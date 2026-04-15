/**
 * UnmarkAI — Background Service Worker
 *
 * ORT inference runs in an Offscreen Document (offscreen.html / offscreen.js)
 * because MV3 service workers lack URL.createObjectURL, document, and the DOM
 * APIs ORT needs. This file is a thin router:
 *   - Spawns the offscreen document on demand.
 *   - Forwards lama-inpaint port messages to offscreen via sendMessage.
 *   - Mirrors offscreen's modelLoadState so popup ports stay informed.
 *   - Handles: download interception, settings, badge, icon, context menu,
 *     and daily stats.
 */
'use strict';

// Set to true during development to see internal logs in the SW console.
// MUST be false for any version uploaded to the Chrome Web Store.
const DEBUG = false;
const log   = DEBUG ? console.log.bind(console, '[UAI bg]')   : () => {};
const warn  = DEBUG ? console.warn.bind(console, '[UAI bg]')  : () => {};
const error = console.error.bind(console, '[UAI bg]');  // errors always shown

// ── Offscreen document lifecycle ─────────────────────────────────────────────
const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;

async function ensureOffscreen() {
  // Dedup concurrent creations: claim the slot synchronously BEFORE any await.
  // Previous version awaited getContexts() first, which let two callers both
  // observe `existing.length === 0` and both reach createDocument.
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    try {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      }).catch(() => []);
      if (existing.length > 0) return;

      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['BLOBS', 'WORKERS'],
          justification: 'Run LaMa ONNX model inference for image inpainting (DOM APIs required)',
        });
      } catch (err) {
        // If another caller raced past our guard (e.g. across SW restarts)
        // and created it first, Chrome throws "Only a single offscreen
        // document may be created." Treat that as success.
        if (!/single offscreen document/i.test(err?.message || '')) throw err;
      }
    } finally {
      creatingOffscreen = null;
    }
  })();

  return creatingOffscreen;
}

// Pull fresh state from offscreen if it exists. The background mirror can drift
// if offscreen was killed/respawned by Chrome (the boot push tells the mirror
// but ordering is not guaranteed; this is a safety net).
async function refreshModelStateFromOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    }).catch(() => []);
    if (contexts.length === 0) return modelLoadState; // not spawned, mirror is correct
    const fresh = await chrome.runtime.sendMessage({
      target: 'offscreen', action: 'getModelState',
    });
    if (fresh && typeof fresh.status === 'string') {
      modelLoadState = { ...modelLoadState, ...fresh };
    }
  } catch {}
  return modelLoadState;
}

async function offscreenSend(action, payload = {}) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', action, ...payload });
}

// Is the offscreen document currently alive?
async function isOffscreenAlive() {
  try {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return ctxs.length > 0;
  } catch { return false; }
}

// Wait until modelLoadState moves out of 'idle' OR a stable 'idle' is confirmed
// (i.e., no state change for a brief settle window). Prevents flashing the
// "Model not downloaded" message before the offscreen boot IIFE has had a chance
// to detect a cached model.
function waitForStateSettle(maxMs = 800) {
  return new Promise(resolve => {
    const startStatus = modelLoadState.status;
    const startTime = Date.now();
    const tick = setInterval(() => {
      // Resolved if we left 'idle' OR exceeded the budget.
      if (modelLoadState.status !== startStatus || Date.now() - startTime > maxMs) {
        clearInterval(tick);
        resolve();
      }
    }, 60);
  });
}

// ── Mirror of offscreen's model state ────────────────────────────────────────
// Updated whenever offscreen sends an 'updateModelState' message.
let modelLoadState = { status: 'idle', progress: 0, error: null };
const popupPorts = new Set();

function broadcastModelState() {
  popupPorts.forEach(p => {
    try { p.postMessage({ type: 'modelStatus', ...modelLoadState }); } catch {}
  });
}

// ── Constants ────────────────────────────────────────────────────────────────
const GEMINI_HOSTS = ['gemini.google.com', 'aistudio.google.com'];
const ACCENT       = '#2DD4BF';
const GRAY         = '#6B7280';

// URLs of downloads we ourselves initiated (via chrome.downloads.download in the
// `downloadClean` handler). The downloads.onCreated listener skips these so we
// don't re-intercept our own cleaned output.
//
// Previously this was a single integer counter (pendingCleanDownloads), which
// was racy: any unrelated download firing in the interim consumed the counter,
// letting our own download slip through to re-interception OR masking a user's
// legitimate save.
const ourDownloadUrls = new Set();
let geminiTabActive       = false;
let cachedSettings        = { enabled: true, autoIntercept: true, method: 'smart' };

// ── Daily stats ──────────────────────────────────────────────────────────────
// "Today" in the popup is backed by chrome.storage.local (not SW memory, which
// dies every ~30s of idle in MV3). Key is the local-date YYYY-MM-DD string; a
// mismatch means a new day and the count resets to 1.
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function incrementDailyStat() {
  const key = todayKey();
  const { dailyStats } = await chrome.storage.local.get('dailyStats');
  const next = (dailyStats && dailyStats.date === key)
    ? { date: key, count: dailyStats.count + 1 }
    : { date: key, count: 1 };
  await chrome.storage.local.set({ dailyStats: next });
}

chrome.storage.sync.get('settings', ({ settings }) => {
  if (settings) Object.assign(cachedSettings, settings);
  refreshBadge();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings?.newValue) {
    Object.assign(cachedSettings, changes.settings.newValue);
    refreshBadge();
  }
});

function updateGeminiTabActive(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    geminiTabActive = GEMINI_HOSTS.some(h => (tab.url || '').includes(h));
  });
}
chrome.tabs.onActivated.addListener((info) => updateGeminiTabActive(info.tabId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && change.url) updateGeminiTabActive(tabId);
});

// ── URL lock (prevent same-URL double processing) ────────────────────────────
const processedUrls = new Map();
function lockUrl(url)   { processedUrls.set(url, Date.now() + 30_000); }
function isLocked(url)  {
  const exp = processedUrls.get(url);
  if (!exp) return false;
  if (Date.now() > exp) { processedUrls.delete(url); return false; }
  return true;
}
function unlockUrl(url) { processedUrls.delete(url); }

// ── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  await chrome.storage.sync.set({
    settings: { enabled: true, autoIntercept: true, method: 'smart' },
    stats:    { totalRemoved: 0, lastReset: Date.now() },
  });
  Object.assign(cachedSettings, { enabled: true, autoIntercept: true, method: 'smart' });
  refreshBadge();
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
  chrome.storage.sync.get('settings', ({ settings }) => {
    if (settings) Object.assign(cachedSettings, settings);
    refreshBadge();
  });
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'uai-clean-download', title: '✦ UnmarkAI — Clean & Download',
      contexts: ['image'],
      documentUrlPatterns: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'uai-clean-download' || !info.srcUrl) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (url) => window.__UAI_processAndDownload?.(url, 'unmark-ai-clean.png'),
    args: [info.srcUrl],
  }).catch(error);
});

// ── Download interception (auto-clean Gemini downloads) ──────────────────────
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    if (!item?.url) return;

    // Skip downloads we ourselves initiated (our cleaned output going to disk).
    if (ourDownloadUrls.has(item.url)) {
      ourDownloadUrls.delete(item.url);
      return;
    }

    // data: URLs are never Gemini originals we need to intercept.
    if (item.url.startsWith('data:')) return;

    if (!cachedSettings.autoIntercept) return;

    const isKnownGeminiBlob        = item.url.startsWith('blob:') && GEMINI_HOSTS.some(h => item.url.includes(h));
    const isNullOriginBlobOnGemini = item.url.startsWith('blob:null') && geminiTabActive;
    const shouldPreCancel          = isKnownGeminiBlob || isNullOriginBlobOnGemini;

    if (shouldPreCancel) chrome.downloads.cancel(item.id).catch(() => {});

    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings?.enabled || !settings?.autoIntercept) return;

    const isImage = (item.mime || '').startsWith('image/') ||
                    /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.url);
    if (!isImage) return;

    const geminiTabs = await chrome.tabs.query({
      url: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    }).catch(() => []);
    if (!geminiTabs.length) return;
    if (isLocked(item.url)) return;

    lockUrl(item.url);
    if (!shouldPreCancel) await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});

    const tab   = geminiTabs.find(t => t.active) || geminiTabs[0];
    const orig  = (item.filename || 'gemini-image').split(/[/\\]/).pop();
    const clean = orig.replace(/(\.[a-z]+)?$/i, '-clean.png');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (url, fname) => {
        if (typeof window.__UAI_processAndDownload !== 'function')
          return { ok: false, error: 'UnmarkAI not loaded — refresh the Gemini page' };
        return window.__UAI_processAndDownload(url, fname);
      },
      args: [item.url, clean],
    }).catch(e => [{ result: { ok: false, error: e.message } }]);

    const result = results?.[0]?.result;
    if (result?.ok === false) warn('fallback failed:', result.error);
    unlockUrl(item.url);
  } catch (e) {
    error('fallback error:', e.message);
  }
});

// ── Port: lama-inpaint (from content.js) → forwarded to offscreen ────────────
chrome.runtime.onConnect.addListener((port) => {

  if (port.name === 'uai-popup') {
    popupPorts.add(port);
    // Refresh from offscreen first, then push to the new popup.
    refreshModelStateFromOffscreen().then(() => {
      try { port.postMessage({ type: 'modelStatus', ...modelLoadState }); } catch {}
    });
    port.onDisconnect.addListener(() => popupPorts.delete(port));
    return;
  }

  if (port.name !== 'lama-inpaint') return;

  port.onMessage.addListener(async (msg) => {

    if (msg.type === 'warmup') {
      // Forward warmup; offscreen will push state updates via updateModelState
      // which we re-broadcast to popups. Send a lightweight progress relay.
      const progressRelay = setInterval(() => {
        try {
          port.postMessage({ type: 'progress', msg: getWarmupMessage() });
        } catch { clearInterval(progressRelay); }
      }, 800);

      try {
        const result = await offscreenSend('warmup');
        clearInterval(progressRelay);
        if (result?.ok) {
          try { port.postMessage({ type: 'warmed' }); } catch {}
        } else {
          try { port.postMessage({ type: 'error', error: result?.error || 'Warmup failed' }); } catch {}
        }
      } catch (err) {
        clearInterval(progressRelay);
        try { port.postMessage({ type: 'error', error: err.message }); } catch {}
      }
      return;
    }

    // Inference request — forward to offscreen
    try {
      port.postMessage({ type: 'progress', msg: 'Sending to AI engine…' });
      const result = await offscreenSend('inpaint', {
        cropPixels: msg.cropPixels,
        cropW:      msg.cropW,
        cropH:      msg.cropH,
        softMask:   msg.softMask,
      });
      if (result?.ok) {
        port.postMessage({ type: 'result', ok: true, inpainted512: result.inpainted512 });
      } else {
        port.postMessage({ type: 'result', ok: false, error: result?.error || 'Inference failed' });
      }
    } catch (err) {
      error('inference forward error:', err.message);
      try { port.postMessage({ type: 'result', ok: false, error: err.message }); } catch {}
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {}
  });
});

function getWarmupMessage() {
  const s = modelLoadState;
  if (s.status === 'downloading') return `Downloading AI model… ${s.progress}%`;
  if (s.status === 'loading')     return 'Preparing AI model…';
  if (s.status === 'ready')       return 'AI model ready';
  return 'Loading…';
}

// ── Messages ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    // From offscreen: mirror the model state
    case 'updateModelState':
      modelLoadState = { ...msg.state };
      broadcastModelState();
      sendResponse({ ok: true });
      return false;

    case 'getModelStatus':
      // Spawn-and-settle pattern. If offscreen isn't running yet, we
      // ensureOffscreen() (triggers spawn + boot IIFE), then wait briefly for
      // its boot to detect cache + push a state update. This eliminates the
      // false "Model not downloaded" the popup used to flash on new tabs
      // when the offscreen had been killed for inactivity.
      (async () => {
        try {
          const wasAlive = await isOffscreenAlive();
          await ensureOffscreen();
          if (!wasAlive) {
            // Just spawned — wait up to 800ms for boot IIFE to either:
            //   - detect cache + start loading (state → 'loading')
            //   - confirm no cache (state stays 'idle', settles fast)
            await waitForStateSettle(800);
          }
          await refreshModelStateFromOffscreen();
        } catch (e) {
          warn('getModelStatus refresh failed:', e.message);
        }
        sendResponse({
          loaded:   modelLoadState.status === 'ready',
          status:   modelLoadState.status,
          progress: modelLoadState.progress,
          error:    modelLoadState.error,
        });
      })();
      return true;

    case 'clearModelCache':
      offscreenSend('clearCache')
        .then(r => sendResponse(r || { ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'cancelModelDownload':
      offscreenSend('cancelDownload')
        .then(r => sendResponse(r || { ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'preWarmModel':
      if (modelLoadState.status === 'idle' || modelLoadState.status === 'error') {
        offscreenSend('warmup').catch(e => warn('pre-warm failed:', e.message));
      }
      sendResponse({ ok: true, status: modelLoadState.status });
      return false;

    case 'lockUrl':
      lockUrl(msg.url);
      sendResponse({ ok: true });
      return false;

    case 'downloadClean': {
      // Prefer blobUrl (cheap IPC); fall back to dataUrl for compat.
      const url = msg.blobUrl || msg.dataUrl;
      if (!url) {
        sendResponse({ ok: false, error: 'No url or blobUrl provided' });
        return false;
      }
      // Register BEFORE calling chrome.downloads.download so onCreated (which
      // fires synchronously-ish inside Chrome) can recognise it as ours.
      ourDownloadUrls.add(url);
      // Safety: if the download never produces an onCreated event (rare: user
      // cancelled before the chooser, or another extension intercepted), the
      // Set entry would live forever. Expire after 60s.
      setTimeout(() => ourDownloadUrls.delete(url), 60_000);

      chrome.downloads.download(
        { url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' },
        (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            ourDownloadUrls.delete(url);
            sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'Download failed' });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
      return true;
    }

    case 'fetchImage':
      fetch(msg.url, { credentials: 'include', cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const mime = r.headers.get('content-type') || 'image/png';
          return r.arrayBuffer().then(buf => ({ buf, mime }));
        })
        .then(({ buf, mime }) => sendResponse({
          buffer: Array.from(new Uint8Array(buf)), mimeType: mime,
        }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'watermarkRemoved':
      chrome.storage.sync.get('stats', ({ stats }) => {
        chrome.storage.sync.set({
          stats: {
            totalRemoved: (stats?.totalRemoved || 0) + 1,
            lastReset: stats?.lastReset || Date.now(),
          },
        });
      });
      incrementDailyStat().catch(() => {});
      sendResponse({ ok: true });
      return false;
  }
});

// Badge reflects the current engine (QCK / PRO), not a count. The popup shows
// stats already; the badge as a method indicator gives a glanceable cue of
// which engine is active.
function methodLabel(method) {
  return method === 'ai' ? 'PRO' : 'QCK';
}

function refreshBadge() {
  const on = cachedSettings.enabled !== false;
  if (!on) {
    setBadge('OFF', GRAY);
  } else {
    setBadge(methodLabel(cachedSettings.method), ACCENT);
  }
  setIconVariant(on);
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
function setIconVariant(active) {
  const suffix = active ? '' : '_gray';
  chrome.action.setIcon({
    path: {
      '16':  `icons/icon16${suffix}.png`,
      '32':  `icons/icon32${suffix}.png`,
      '48':  `icons/icon48${suffix}.png`,
      '128': `icons/icon128${suffix}.png`,
    },
  }).catch(() => {});
}

log('service worker booted');