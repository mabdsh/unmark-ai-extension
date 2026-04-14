/**
 * UnmarkAI v4.0.6 — Background Service Worker
 *
 * v4.0.4 ARCHITECTURE CHANGE:
 *   ORT inference moved to an Offscreen Document (offscreen.html / offscreen.js).
 *   Service workers in MV3 lack URL.createObjectURL, document, and DOM APIs that
 *   ORT needs internally. The offscreen document has full DOM access and stays
 *   alive as long as it's processing requests.
 *
 *   This file is now a thin router:
 *     - Spawns the offscreen document on demand
 *     - Forwards lama-inpaint port messages to offscreen via sendMessage
 *     - Mirrors offscreen's modelLoadState so popup ports stay informed
 *     - Continues to handle: downloads, settings, badges, context menu
 */
'use strict';

// ── Offscreen document lifecycle ─────────────────────────────────────────────
const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;

async function ensureOffscreen() {
  // Already exists?
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  }).catch(() => []);
  if (existing.length > 0) return;

  // Dedup concurrent creations
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS', 'WORKERS'],
    justification: 'Run LaMa ONNX model inference for image inpainting (DOM APIs required)',
  }).finally(() => { creatingOffscreen = null; });

  return creatingOffscreen;
}

// v4.0.6: Pull fresh state from offscreen if it exists. The background mirror
// can drift if offscreen was killed/respawned by Chrome (the boot push tells
// the mirror but ordering is not guaranteed; this is a safety net).
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

// v4.0.6 helpers
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

let sessionCount          = 0;
let pendingCleanDownloads = 0;
let geminiTabActive       = false;
let cachedSettings        = { enabled: true, autoIntercept: true, method: 'smart' };

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
    settings: {
      enabled: true, autoIntercept: true, removeVisible: true,
      removeSynthID: true, method: 'smart', format: 'png',
      jpegQuality: 0.96, showNotifications: true,
    },
    stats: { totalRemoved: 0, lastReset: Date.now() },
  });
  // v4.0.9: seed cachedSettings + show method-aware badge from first install
  Object.assign(cachedSettings, { enabled: true, autoIntercept: true, method: 'smart' });
  refreshBadge();
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  sessionCount = 0;
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
  }).catch(console.error);
});

// ── Download interception (auto-clean Gemini downloads) ──────────────────────
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    if (!item?.url) return;
    if (pendingCleanDownloads > 0) { pendingCleanDownloads--; return; }
    if (item.url.startsWith('data:') || item.url.startsWith('blob:')) {
      // blob: URLs from our own content-script downloadClean path — but only
      // skip if it's from us (counter handled above). Other blob: still need
      // checking, so don't skip blanket. (Original code skipped only data:.)
      if (item.url.startsWith('data:')) return;
    }
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
    if (result?.ok === false) console.warn('[UAI bg] fallback failed:', result.error);
    unlockUrl(item.url);
  } catch (e) {
    console.error('[UAI bg] fallback error:', e.message);
  }
});

// ── Port: lama-inpaint (from content.js) → forwarded to offscreen ────────────
chrome.runtime.onConnect.addListener((port) => {

  if (port.name === 'uai-popup') {
    popupPorts.add(port);
    // v4.0.6: refresh from offscreen first, then push to the new popup.
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
      console.error('[UAI bg] inference forward error:', err.message);
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
      // v4.0.6: spawn-and-settle pattern. If offscreen isn't running yet, we
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
          console.warn('[UAI bg] getModelStatus refresh failed:', e.message);
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

    case 'preWarmModel':
      if (modelLoadState.status === 'idle' || modelLoadState.status === 'error') {
        offscreenSend('warmup').catch(e => console.warn('[UAI bg] pre-warm failed:', e.message));
      }
      sendResponse({ ok: true, status: modelLoadState.status });
      return false;

    case 'lockUrl':
      lockUrl(msg.url);
      sendResponse({ ok: true });
      return false;

    case 'setAutoIntercept':
      cachedSettings.autoIntercept = !!msg.autoIntercept;
      sendResponse({ ok: true });
      return false;

    case 'downloadClean': {
      pendingCleanDownloads++;
      // v4.0.1: prefer blobUrl (cheap IPC); fall back to dataUrl for compat
      const url = msg.blobUrl || msg.dataUrl;
      if (!url) {
        pendingCleanDownloads = Math.max(0, pendingCleanDownloads - 1);
        sendResponse({ ok: false, error: 'No url or blobUrl provided' });
        return false;
      }
      chrome.downloads.download(
        { url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' },
        (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            pendingCleanDownloads = Math.max(0, pendingCleanDownloads - 1);
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
      sessionCount++;
      chrome.storage.sync.get('stats', ({ stats }) => {
        chrome.storage.sync.set({
          stats: { totalRemoved: (stats?.totalRemoved || 0) + 1, lastReset: stats?.lastReset || Date.now() },
        });
      });
      updateBadgeCount();
      sendResponse({ ok: true, sessionCount });
      return false;

    case 'toggleEnabled':
      chrome.storage.sync.get('settings', ({ settings }) => {
        const updated = { ...settings, enabled: msg.enabled };
        chrome.storage.sync.set({ settings: updated }, () => {
          Object.assign(cachedSettings, updated);
          updateBadge(msg.enabled);
          sendResponse({ ok: true });
        });
      });
      return true;

    case 'getSession':
      sendResponse({ sessionCount });
      return false;
  }
});

// v4.0.9: badge now reflects the current engine (QCK / PRO), not a session
// count. The popup shows the count already; the badge as a method indicator
// gives a glanceable cue of which engine is active.
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

// Kept as a thin alias so the old call sites keep working without bigger refactor.
function updateBadge(_on) { refreshBadge(); }
function updateBadgeCount() { /* deprecated v4.0.9 — badge shows method now */ }

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

console.log('[UAI bg] service worker booted v4.0.4 (offscreen ORT)');
