/**
 * UnmarkAI v4.0 — Background Service Worker
 *
 * MODEL LOADING (CDN + IndexedDB cache):
 *   1. On first use, fetch lama-model.onnx from GitHub CDN (~198 MB)
 *   2. Cache the raw ArrayBuffer in IndexedDB — persists forever across sessions
 *   3. On subsequent uses, load directly from IndexedDB (instant, no network)
 *   4. Create ORT InferenceSession from the buffer
 *
 * PROGRESS REPORTING:
 *   Download progress (0-100%) is broadcast to all connected popup ports
 *   and reported via modelLoadState so popup.js can poll it via getModelStatus.
 *
 * LAMA INFERENCE FLOW (unchanged):
 *   content.js → Port('lama-inpaint') → background runs inference → result
 */

'use strict';

// ── CDN URL ───────────────────────────────────────────────────────────────────
const MODEL_CDN_URL = 'https://github.com/mabdsh/lama_fp32/releases/download/v1.0.0/lama-model.onnx';

// ── IndexedDB config ──────────────────────────────────────────────────────────
const IDB_NAME    = 'uai-model-cache';
const IDB_VERSION = 1;
const IDB_STORE   = 'models';
const IDB_KEY     = 'lama-model';

// ── Load ONNX Runtime Web ─────────────────────────────────────────────────────
try {
  importScripts('ort.min.js');
  if (self.ort) {
    const extRoot = self.location.href.replace(/[^/]+$/, '');
    self.ort.env.wasm.wasmPaths  = extRoot;
    self.ort.env.wasm.simd       = true;
    self.ort.env.wasm.numThreads = 1;
    console.log('[UAI bg] ORT loaded ✓');
  }
} catch (e) {
  console.warn('[UAI bg] ORT load failed:', e.message);
}

// ── Model load state — single source of truth ─────────────────────────────────
let modelLoadState = {
  status:   'idle',  // 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  progress: 0,       // 0-100 during download
  error:    null,
};

let lamaSession      = null;
let loadingPromise   = null; // prevent concurrent load attempts

// Connected popup ports — for live progress push
const popupPorts = new Set();

function broadcastProgress(state) {
  popupPorts.forEach(p => {
    try { p.postMessage({ type: 'modelStatus', ...state }); } catch {}
  });
}

function setModelState(patch) {
  Object.assign(modelLoadState, patch);
  broadcastProgress(modelLoadState);
  console.log('[UAI bg] model state:', modelLoadState.status,
    modelLoadState.progress ? modelLoadState.progress + '%' : '');
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess       = e => resolve(e.target.result);
    req.onerror         = e => reject(new Error('IDB open failed: ' + e.target.error));
  });
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(new Error('IDB get failed: ' + e.target.error));
  });
}

async function idbPut(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(new Error('IDB put failed: ' + e.target.error));
  });
}

async function idbDelete(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(new Error('IDB delete failed: ' + e.target.error));
  });
}

// ── CDN download with progress ────────────────────────────────────────────────
async function downloadModelFromCDN() {
  console.log('[UAI bg] Downloading model from CDN:', MODEL_CDN_URL);
  setModelState({ status: 'downloading', progress: 0, error: null });

  const response = await fetch(MODEL_CDN_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`CDN fetch failed: HTTP ${response.status}`);

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
  const reader  = response.body.getReader();
  const chunks  = [];
  let received  = 0;
  let lastPct   = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;

    if (contentLength > 0) {
      const pct = Math.min(99, Math.round((received / contentLength) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        setModelState({ status: 'downloading', progress: pct });
      }
    }
  }

  // Combine all chunks into one ArrayBuffer
  const full = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }

  setModelState({ status: 'downloading', progress: 100 });
  console.log('[UAI bg] Download complete —', (received / 1024 / 1024).toFixed(1), 'MB');
  return full.buffer;
}

// ── Main model loader ─────────────────────────────────────────────────────────
async function getLamaSession() {
  // Already loaded
  if (lamaSession) return lamaSession;

  // Deduplicate concurrent calls
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      if (!self.ort) throw new Error('ONNX Runtime not loaded — check ort.min.js');

      // 1. Try IndexedDB cache first
      let modelBuf = null;
      try {
        console.log('[UAI bg] Checking IndexedDB cache…');
        modelBuf = await idbGet(IDB_KEY);
        if (modelBuf) console.log('[UAI bg] Model found in cache ✓');
      } catch (e) {
        console.warn('[UAI bg] IDB read failed, will re-download:', e.message);
      }

      // 2. Download from CDN if not cached
      if (!modelBuf) {
        modelBuf = await downloadModelFromCDN();

        // Save to IndexedDB for next time
        try {
          setModelState({ status: 'loading', progress: 100 });
          console.log('[UAI bg] Saving model to IndexedDB cache…');
          await idbPut(IDB_KEY, modelBuf);
          console.log('[UAI bg] Model cached in IndexedDB ✓');
        } catch (e) {
          console.warn('[UAI bg] IDB save failed (will re-download next time):', e.message);
        }
      }

      // 3. Create ORT session
      setModelState({ status: 'loading', progress: 100 });
      console.log('[UAI bg] Creating ORT inference session…');

      lamaSession = await self.ort.InferenceSession.create(modelBuf, {
        executionProviders:     ['wasm'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena:      true,
      });

      setModelState({ status: 'ready', progress: 100, error: null });
      console.log('[UAI bg] LaMa session ready ✓ inputs:', lamaSession.inputNames);
      return lamaSession;

    } catch (err) {
      setModelState({ status: 'error', error: err.message });
      lamaSession    = null;
      loadingPromise = null;
      throw err;
    }
  })();

  return loadingPromise;
}

// ── Pure-JS image processing ──────────────────────────────────────────────────
const TARGET = 512;

function bilinearResize(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 4);
  const xS  = srcW / dstW;
  const yS  = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy  = dy * yS;
    const sy0 = Math.min(srcH - 1, sy | 0);
    const sy1 = Math.min(srcH - 1, sy0 + 1);
    const yf  = sy - sy0;
    for (let dx = 0; dx < dstW; dx++) {
      const sx  = dx * xS;
      const sx0 = Math.min(srcW - 1, sx | 0);
      const sx1 = Math.min(srcW - 1, sx0 + 1);
      const xf  = sx - sx0;
      const i00 = (sy0 * srcW + sx0) * 4;
      const i01 = (sy0 * srcW + sx1) * 4;
      const i10 = (sy1 * srcW + sx0) * 4;
      const i11 = (sy1 * srcW + sx1) * 4;
      const w00 = (1 - xf) * (1 - yf);
      const w01 = xf       * (1 - yf);
      const w10 = (1 - xf) * yf;
      const w11 = xf       * yf;
      const di  = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        dst[di + c] = (src[i00+c]*w00 + src[i01+c]*w01 + src[i10+c]*w10 + src[i11+c]*w11 + 0.5) | 0;
      }
    }
  }
  return dst;
}

function bilinearResizeMono(src, srcW, srcH, dstW, dstH) {
  const dst = new Float32Array(dstW * dstH);
  const xS  = srcW / dstW;
  const yS  = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy  = dy * yS;
    const sy0 = Math.min(srcH - 1, sy | 0);
    const sy1 = Math.min(srcH - 1, sy0 + 1);
    const yf  = sy - sy0;
    for (let dx = 0; dx < dstW; dx++) {
      const sx  = dx * xS;
      const sx0 = Math.min(srcW - 1, sx | 0);
      const sx1 = Math.min(srcW - 1, sx0 + 1);
      const xf  = sx - sx0;
      dst[dy * dstW + dx] =
        src[sy0 * srcW + sx0] * (1-xf) * (1-yf) +
        src[sy0 * srcW + sx1] * xf     * (1-yf) +
        src[sy1 * srcW + sx0] * (1-xf) * yf     +
        src[sy1 * srcW + sx1] * xf     * yf;
    }
  }
  return dst;
}

function rgbaToChwFloat(rgba, W, H) {
  const N   = W * H;
  const chw = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    chw[i]         = rgba[i * 4]     / 255;
    chw[N + i]     = rgba[i * 4 + 1] / 255;
    chw[2 * N + i] = rgba[i * 4 + 2] / 255;
  }
  return chw;
}

function chwFloatToRgba(chw, W, H) {
  const N    = W * H;
  const rgba = new Uint8Array(N * 4);
  let maxVal = 0;
  for (let s = 0; s < 20; s++) {
    const i = ((s / 20) * N) | 0;
    maxVal = Math.max(maxVal, Math.abs(chw[i]), Math.abs(chw[N + i]), Math.abs(chw[2 * N + i]));
  }
  const scale = maxVal > 1.5 ? 1 : 255;
  for (let i = 0; i < N; i++) {
    rgba[i*4]     = Math.max(0, Math.min(255, (chw[i]         * scale + 0.5) | 0));
    rgba[i*4 + 1] = Math.max(0, Math.min(255, (chw[N + i]     * scale + 0.5) | 0));
    rgba[i*4 + 2] = Math.max(0, Math.min(255, (chw[2 * N + i] * scale + 0.5) | 0));
    rgba[i*4 + 3] = 255;
  }
  return rgba;
}

function binarize(mask, threshold = 0.1) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] > threshold ? 1.0 : 0.0;
  return out;
}

function dilate2px(mask, W, H) {
  const out = new Float32Array(mask.length);
  const R   = 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x] < 0.5) continue;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < H && nx >= 0 && nx < W) out[ny * W + nx] = 1.0;
        }
      }
    }
  }
  return out;
}

async function runLaMa(sess, imgChw, maskFlat) {
  const shape  = [1, 3, TARGET, TARGET];
  const mShape = [1, 1, TARGET, TARGET];
  const inNames = sess.inputNames;
  const imgIn   = inNames.find(n => /^image|^input/i.test(n)) ?? inNames[0];
  const maskIn  = inNames.find(n => /^mask/i.test(n))          ?? inNames[1];
  const feeds   = {
    [imgIn]:  new self.ort.Tensor('float32', imgChw,   shape),
    [maskIn]: new self.ort.Tensor('float32', maskFlat, mShape),
  };
  const results = await sess.run(feeds);
  return results[sess.outputNames[0]].data;
}

// ── Extension lifecycle ───────────────────────────────────────────────────────
const GEMINI_HOSTS = ['gemini.google.com', 'aistudio.google.com'];
const ACCENT       = '#2DD4BF';
const GRAY         = '#6B7280';

let sessionCount          = 0;
let pendingCleanDownloads = 0;
let geminiTabActive       = false;
let cachedSettings        = { enabled: true, autoIntercept: true };

chrome.storage.sync.get('settings', ({ settings }) => {
  if (settings) Object.assign(cachedSettings, settings);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings?.newValue) Object.assign(cachedSettings, changes.settings.newValue);
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

const processedUrls = new Map();
function lockUrl(url)   { processedUrls.set(url, Date.now() + 30_000); }
function isLocked(url)  {
  const exp = processedUrls.get(url);
  if (!exp) return false;
  if (Date.now() > exp) { processedUrls.delete(url); return false; }
  return true;
}
function unlockUrl(url) { processedUrls.delete(url); }

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
  setBadge('ON', ACCENT);
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  sessionCount = 0;
  setupContextMenu();
  chrome.storage.sync.get('settings', ({ settings }) => {
    if (settings) Object.assign(cachedSettings, settings);
    updateBadge(settings?.enabled !== false);
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
    func:   (url) => window.__UAI_processAndDownload?.(url, 'unmark-ai-clean.png'),
    args:   [info.srcUrl],
  }).catch(console.error);
});

chrome.downloads.onCreated.addListener(async (item) => {
  try {
    if (!item?.url) return;
    if (pendingCleanDownloads > 0) { pendingCleanDownloads--; return; }
    if (item.url.startsWith('data:')) return;
    if (!cachedSettings.autoIntercept) return;

    const isKnownGeminiBlob       = item.url.startsWith('blob:') && GEMINI_HOSTS.some(h => item.url.includes(h));
    const isNullOriginBlobOnGemini = item.url.startsWith('blob:null') && geminiTabActive;
    const shouldPreCancel          = isKnownGeminiBlob || isNullOriginBlobOnGemini;

    if (shouldPreCancel) chrome.downloads.cancel(item.id).catch(() => {});

    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings?.enabled || !settings?.autoIntercept) return;
    if (item.url.startsWith('data:')) return;

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

// ── LaMa inference via persistent Port ───────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {

  // Popup progress port — for live model download/load progress
  if (port.name === 'uai-popup') {
    popupPorts.add(port);
    // Immediately send current state to newly connected popup
    try { port.postMessage({ type: 'modelStatus', ...modelLoadState }); } catch {}
    port.onDisconnect.addListener(() => popupPorts.delete(port));
    return;
  }

  if (port.name !== 'lama-inpaint') return;

  port.onMessage.addListener(async (msg) => {

    // Warmup — just load the session, no inference
    if (msg.type === 'warmup') {
      // If currently downloading, send live progress updates to this port too
      const progressRelay = setInterval(() => {
        try {
          port.postMessage({ type: 'progress', msg: getWarmupMessage() });
        } catch { clearInterval(progressRelay); }
      }, 800);

      getLamaSession()
        .then(() => {
          clearInterval(progressRelay);
          try { port.postMessage({ type: 'warmed' }); } catch {}
        })
        .catch((err) => {
          clearInterval(progressRelay);
          try { port.postMessage({ type: 'error', error: err.message }); } catch {}
        });
      return;
    }

    // Inference
    try {
      const sess = await getLamaSession();
      const { cropPixels, cropW, cropH, softMask } = msg;
      const src = new Uint8Array(cropPixels);
      const msk = new Float32Array(softMask);

      port.postMessage({ type: 'progress', msg: 'Resizing input...' });
      const resizedImg  = bilinearResize(src, cropW, cropH, TARGET, TARGET);
      const resizedMask = bilinearResizeMono(msk, cropW, cropH, TARGET, TARGET);
      const binMask     = binarize(resizedMask, 0.05);
      const dilMask     = dilate2px(binMask, TARGET, TARGET);
      const imgChw      = rgbaToChwFloat(resizedImg, TARGET, TARGET);

      port.postMessage({ type: 'progress', msg: 'Running AI inpainting...' });
      const outChw    = await runLaMa(sess, imgChw, dilMask);
      const inpainted = chwFloatToRgba(outChw, TARGET, TARGET);

      port.postMessage({ type: 'result', ok: true, inpainted512: Array.from(inpainted) });

    } catch (err) {
      console.error('[UAI bg] inference error:', err.message);
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

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    case 'getModelStatus':
      sendResponse({
        loaded:      modelLoadState.status === 'ready',
        status:      modelLoadState.status,
        progress:    modelLoadState.progress,
        error:       modelLoadState.error,
      });
      return false;

    case 'clearModelCache':
      idbDelete(IDB_KEY)
        .then(() => {
          lamaSession    = null;
          loadingPromise = null;
          setModelState({ status: 'idle', progress: 0, error: null });
          sendResponse({ ok: true });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'preWarmModel':
      if (modelLoadState.status === 'idle' || modelLoadState.status === 'error') {
        getLamaSession().catch(e => console.warn('[UAI bg] pre-warm failed:', e.message));
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
      chrome.downloads.download(
        { url: msg.dataUrl, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' },
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

function updateBadge(on)    { setBadge(on ? 'ON' : 'OFF', on ? ACCENT : GRAY); }
function updateBadgeCount() {
  if (sessionCount > 0) setBadge(sessionCount > 99 ? '99+' : String(sessionCount), ACCENT);
}
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}