/**
 * UnmarkAI v3.9 — Background Service Worker
 *
 * WHY INFERENCE RUNS HERE (not in a Worker, not in content.js):
 *   Gemini's CSP "worker-src *" blocks blob: workers — * only matches http/https.
 *   Content scripts can't importScripts() or eval() foreign code due to the same CSP.
 *   The background service worker runs in the EXTENSION context, completely outside
 *   Gemini's CSP. It can importScripts, load bundled WASM, and run ONNX inference.
 *
 * BUNDLED DEPENDENCIES (no CDN — put these files in your extension root):
 *   ort.min.js            — ONNX Runtime Web JS  (download once, ~2 MB)
 *   ort-wasm-simd.wasm    — SIMD-accelerated WASM (~10 MB, best performance)
 *   ort-wasm.wasm         — non-SIMD fallback     (~10 MB, for older CPUs)
 *   lama-model.onnx       — LaMa inpainting model  (~20 MB INT8 quantized)
 *
 *   See SETUP-AI.md for exact download URLs.
 *
 * LAMA INFERENCE FLOW:
 *   content.js  →  sendMessage('lamaInpaint', {cropPixels, cropW, cropH, softMask})
 *   background  →  bilinear resize to 512×512 (pure JS, no OffscreenCanvas)
 *               →  ORT inference (bundled WASM)
 *               →  sendResponse({ok, inpainted512}) — 512×512 RGBA
 *   content.js  →  compositeInpainted() — canvas scale-back + alpha blend
 *
 * IMAGE PROCESSING FUNCTIONS (pure JS, no DOM/Canvas needed in service worker):
 *   bilinearResize()     — RGBA resize
 *   bilinearResizeMono() — single-channel float resize
 *   rgbaToChwFloat()     — RGBA uint8 → CHW float32 [0,1] for ORT
 *   chwFloatToRgba()     — CHW float32 → RGBA uint8
 *   binarize()           — float mask → hard 0/1
 *   dilate2px()          — expand mask boundary for cleaner inpainting seam
 */

'use strict';

// ── Load ONNX Runtime Web from bundled file ───────────────────────────────────
// importScripts() MUST be called at the top level in MV3 classic service workers.
// Wrap in try/catch so the extension still works if ort.min.js isn't bundled yet.
try {
  importScripts('ort.min.js');
  if (self.ort) {
    // Point ORT to the extension root so it finds the bundled .wasm files.
    // self.location.href = 'chrome-extension://[id]/background.js'
    const extRoot = self.location.href.replace(/[^/]+$/, '');
    self.ort.env.wasm.wasmPaths  = extRoot;
    self.ort.env.wasm.numThreads = 1; // service workers are single-threaded
    console.log('[UAI bg] ORT loaded from bundle ✓');
  }
} catch (e) {
  // ORT not bundled yet — AI method will show a clear error. All other methods work.
  console.warn('[UAI bg] ORT not bundled (is ort.min.js in extension root?):', e.message);
}

// ── LaMa session — lazy, persists for lifetime of service worker ─────────────
let lamaSession = null;

async function getLamaSession() {
  if (lamaSession) return lamaSession;

  if (!self.ort) {
    throw new Error(
      'ONNX Runtime not loaded. Bundle ort.min.js in your extension root. ' +
      'See SETUP-AI.md for instructions.'
    );
  }

  console.log('[UAI bg] Loading LaMa model from bundle…');
  const modelUrl = chrome.runtime.getURL('lama-model.onnx');
  let modelBuf;
  try {
    const resp = await fetch(modelUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    modelBuf = await resp.arrayBuffer();
  } catch (e) {
    throw new Error(
      'LaMa model not found. Bundle lama-model.onnx in your extension root. ' +
      'See SETUP-AI.md for instructions. (fetch error: ' + e.message + ')'
    );
  }

  console.log('[UAI bg] Creating ORT inference session…');
  lamaSession = await self.ort.InferenceSession.create(modelBuf, {
    executionProviders:     ['wasm'],
    graphOptimizationLevel: 'all',
    enableCpuMemArena:      true,
  });

  console.log('[UAI bg] LaMa session ready ✓ inputs:', lamaSession.inputNames);
  return lamaSession;
}

// ── Pure-JS image processing (no OffscreenCanvas — not available in SW) ───────

const TARGET = 512; // LaMa model input resolution

/** Bilinear resize of RGBA pixel buffer (Uint8Array/Uint8ClampedArray). */
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

      const di = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        dst[di + c] = (src[i00+c]*w00 + src[i01+c]*w01 + src[i10+c]*w10 + src[i11+c]*w11 + 0.5) | 0;
      }
    }
  }
  return dst;
}

/** Bilinear resize of a single-channel float array. */
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

/** RGBA uint8 → RGB CHW float32 [0, 1] (LaMa image input format). */
function rgbaToChwFloat(rgba, W, H) {
  const N   = W * H;
  const chw = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    chw[i]         = rgba[i * 4]     / 255; // R
    chw[N + i]     = rgba[i * 4 + 1] / 255; // G
    chw[2 * N + i] = rgba[i * 4 + 2] / 255; // B
  }
  return chw;
}

/**
 * CHW float32 → RGBA uint8 (LaMa output → displayable pixels).
 *
 * Output range varies by ONNX export:
 *   Carve/LaMa-ONNX  lama_fp32.onnx → [0, 255]  (do NOT multiply by 255 again)
 *   Other exports    (e.g. INT8)     → [0, 1]    (multiply by 255)
 *
 * We auto-detect by sampling the max value: if > 1.5 it's already [0,255].
 */
function chwFloatToRgba(chw, W, H) {
  const N = W * H;
  const rgba = new Uint8Array(N * 4);

  // Sample a few spread-out pixels to detect output range
  let maxVal = 0;
  for (let s = 0; s < 20; s++) {
    const i = ((s / 20) * N) | 0;
    maxVal = Math.max(maxVal, Math.abs(chw[i]), Math.abs(chw[N + i]), Math.abs(chw[2 * N + i]));
  }
  // [0,255] range → scale=1 (pass through), [0,1] range → scale=255
  const scale = maxVal > 1.5 ? 1 : 255;

  for (let i = 0; i < N; i++) {
    rgba[i*4]     = Math.max(0, Math.min(255, (chw[i]         * scale + 0.5) | 0));
    rgba[i*4 + 1] = Math.max(0, Math.min(255, (chw[N + i]     * scale + 0.5) | 0));
    rgba[i*4 + 2] = Math.max(0, Math.min(255, (chw[2 * N + i] * scale + 0.5) | 0));
    rgba[i*4 + 3] = 255;
  }
  return rgba;
}

/** Binarize a float mask: 1.0 where value > threshold, else 0.0. */
function binarize(mask, threshold = 0.1) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] > threshold ? 1.0 : 0.0;
  return out;
}

/** 2-pixel square dilation — expands mask edges for cleaner inpainting seam. */
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

/** Run LaMa forward pass. Returns CHW float32 output tensor data. */
async function runLaMa(sess, imgChw, maskFlat) {
  const shape  = [1, 3, TARGET, TARGET];
  const mShape = [1, 1, TARGET, TARGET];

  // Handle different input name conventions across ONNX export tools
  const inNames = sess.inputNames;
  const imgIn   = inNames.find(n => /^image|^input/i.test(n))  ?? inNames[0];
  const maskIn  = inNames.find(n => /^mask/i.test(n))           ?? inNames[1];

  const feeds = {
    [imgIn]:  new self.ort.Tensor('float32', imgChw,   shape),
    [maskIn]: new self.ort.Tensor('float32', maskFlat, mShape),
  };

  const results = await sess.run(feeds);
  return results[sess.outputNames[0]].data; // Float32Array
}


// ═══════════════════════════════════════════════════════════════════════════════
//  EXISTING BACKGROUND CODE (unchanged below)
// ═══════════════════════════════════════════════════════════════════════════════

const GEMINI_HOSTS = ['gemini.google.com', 'aistudio.google.com'];
const ACCENT       = '#2DD4BF';
const GRAY         = '#6B7280';

let sessionCount          = 0;
let pendingCleanDownloads = 0;
let geminiTabActive       = false;

let cachedSettings = { enabled: true, autoIntercept: true };

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

    const isKnownGeminiBlob = item.url.startsWith('blob:') && GEMINI_HOSTS.some(h => item.url.includes(h));
    const isNullOriginBlobOnGemini = item.url.startsWith('blob:null') && geminiTabActive;
    const shouldPreCancel = isKnownGeminiBlob || isNullOriginBlobOnGemini;

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
// WHY PORT, NOT sendMessage:
//   sendMessage has an implicit timeout — Chrome kills the service worker if
//   sendResponse() is not called fast enough. LaMa loading a 208 MB model and
//   running WASM inference takes 20-90 seconds, which exceeds the limit.
//
//   A Port connection (chrome.runtime.connect) keeps the service worker alive
//   for the full duration of the port's lifetime. content.js opens the port,
//   posts the crop data, waits for the result message, then disconnects.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'lama-inpaint') return;

  port.onMessage.addListener(async (msg) => {
    // Warmup request — load the session and confirm ready (no inference)
    if (msg.type === 'warmup') {
      getLamaSession()
        .then(() => { try { port.postMessage({ type: 'warmed' }); } catch {} })
        .catch((err) => { try { port.postMessage({ type: 'error', error: err.message }); } catch {} });
      return;
    }

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

      port.postMessage({ type: 'progress', msg: 'Running LaMa inference...' });

      const outChw    = await runLaMa(sess, imgChw, dilMask);
      const inpainted = chwFloatToRgba(outChw, TARGET, TARGET);

      port.postMessage({ type: 'result', ok: true, inpainted512: Array.from(inpainted) });

    } catch (err) {
      console.error('[UAI bg] lamaInpaint port error:', err.message);
      try { port.postMessage({ type: 'result', ok: false, error: err.message }); } catch (_) {}
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) { /* suppress disconnect noise */ }
  });
});

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

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

function updateBadge(on)   { setBadge(on ? 'ON' : 'OFF', on ? ACCENT : GRAY); }
function updateBadgeCount() {
  if (sessionCount > 0) setBadge(sessionCount > 99 ? '99+' : String(sessionCount), ACCENT);
}
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}