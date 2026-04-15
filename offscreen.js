/**
 * UnmarkAI — Offscreen Document
 *
 * WHY THIS FILE EXISTS:
 *   Chrome MV3 service workers do NOT have URL.createObjectURL, document, or
 *   any DOM API. ONNX Runtime needs URL.createObjectURL to spawn worker threads
 *   and to load the WASM binary, so it crashes when run from a SW.
 *
 *   This Offscreen Document is a hidden DOM context the extension owns. It has
 *   full document APIs including URL.createObjectURL, WebGPU, and worker
 *   support. Background.js spawns it on demand and forwards inference requests
 *   via chrome.runtime.sendMessage.
 *
 * RESPONSIBILITIES:
 *   - Load ORT + LaMa model from CDN (or IndexedDB cache)
 *   - Verify model SHA-256
 *   - Hold the InferenceSession for the lifetime of the offscreen document
 *   - Run inpainting and return the 512×512 result
 *   - Send model state updates to background.js for popup UI
 */
'use strict';

// Set to true during development to see internal logs in the offscreen console.
// MUST be false for any version uploaded to the Chrome Web Store.
const DEBUG = false;
const log   = DEBUG ? console.log.bind(console, '[UAI offscreen]')   : () => {};
const warn  = DEBUG ? console.warn.bind(console, '[UAI offscreen]')  : () => {};
const error = console.error.bind(console, '[UAI offscreen]');

// ── ORT setup ────────────────────────────────────────────────────────────────
if (self.ort) {
  const extRoot = chrome.runtime.getURL('');
  self.ort.env.wasm.wasmPaths = extRoot;
  self.ort.env.wasm.simd      = true;
  // Single-thread WASM. ORT loads `ort-wasm-simd.wasm` with this config,
  // which is the only WASM binary bundled. To enable multi-thread (4× faster
  // inference), also add `ort-wasm-simd-threaded.wasm` (from the same ORT
  // npm version) to the extension root and bump this number.
  self.ort.env.wasm.numThreads = 1;
  // Disable proxy worker explicitly — single-thread mode shouldn't need one,
  // but some ORT versions still try to spawn one without this hint.
  self.ort.env.wasm.proxy = false;
  log('ORT loaded ✓ — single-thread WASM');
} else {
  error('ORT failed to load');
}

// ── CDN URL ──────────────────────────────────────────────────────────────────
const MODEL_CDN_URL = 'https://github.com/mabdsh/lama_fp32/releases/download/v1.0.0/lama-model.onnx';

// SHA-256 of the expected lama-model.onnx file. Set to '' to disable verification.
// Compute via:  sha256sum lama-model.onnx
const MODEL_SHA256 = '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6';

async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── IndexedDB ────────────────────────────────────────────────────────────────
const IDB_NAME    = 'uai-model-cache';
const IDB_VERSION = 1;
const IDB_STORE   = 'models';
const IDB_KEY     = 'lama-model';

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
  return new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    r.onsuccess = e => res(e.target.result ?? null);
    r.onerror   = e => rej(new Error('IDB get failed: ' + e.target.error));
  });
}
async function idbPut(key, value) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(value, key);
    r.onsuccess = () => res();
    r.onerror   = e => rej(new Error('IDB put failed: ' + e.target.error));
  });
}
async function idbDelete(key) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(key);
    r.onsuccess = () => res();
    r.onerror   = e => rej(new Error('IDB delete failed: ' + e.target.error));
  });
}

// ── Model state (mirrored to background.js for popup UI) ─────────────────────
let modelLoadState = { status: 'idle', progress: 0, error: null };
let lamaSession    = null;
let loadingPromise = null;
// Module-level so the 'cancelDownload' message handler can abort an
// in-flight fetch. Reset to null after each download attempt finishes
// (success, failure, or cancellation).
let currentDownloadController = null;

function setModelState(patch) {
  Object.assign(modelLoadState, patch);
  // Push to background so it can broadcast to popup ports
  try {
    chrome.runtime.sendMessage({
      action: 'updateModelState',
      state: { ...modelLoadState }
    }).catch(() => {});
  } catch {}
  log('model state:', modelLoadState.status,
    modelLoadState.progress ? modelLoadState.progress + '%' : '');
}

// ── CDN download with progress ───────────────────────────────────────────────
async function downloadModelFromCDN() {
  log('Downloading model from CDN:', MODEL_CDN_URL);
  setModelState({ status: 'downloading', progress: 0, error: null });

  // AbortController — user can cancel from popup → bg → us.
  currentDownloadController = new AbortController();
  const { signal } = currentDownloadController;

  let response;
  try {
    response = await fetch(MODEL_CDN_URL, {
      cache:    'no-store',
      redirect: 'follow',
      signal,
    });
  } catch (e) {
    currentDownloadController = null;
    if (e.name === 'AbortError') {
      const err = new Error('Download cancelled');
      err.cancelled = true;
      throw err;
    }
    throw new Error(`Network error reaching CDN: ${e.message}`);
  }
  if (!response.ok) {
    currentDownloadController = null;
    throw new Error(`CDN responded HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    currentDownloadController = null;
    throw new Error('CDN response has no body');
  }

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastPct  = -1;

  try {
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
  } catch (e) {
    currentDownloadController = null;
    if (e.name === 'AbortError' || signal.aborted) {
      try { await reader.cancel(); } catch {}
      const err = new Error('Download cancelled');
      err.cancelled = true;
      throw err;
    }
    throw e;
  }

  const full = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }

  currentDownloadController = null;
  setModelState({ status: 'downloading', progress: 100 });
  log('Download complete —', (received / 1024 / 1024).toFixed(1), 'MB');
  return full.buffer;
}

// ── Main model loader ────────────────────────────────────────────────────────
async function getLamaSession() {
  if (lamaSession) {
    // Re-broadcast state so a freshly-restarted background mirror
    // catches up. Cheap (no real work happens here).
    setModelState({ status: 'ready', progress: 100, error: null });
    return lamaSession;
  }
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      if (!self.ort) throw new Error('ONNX Runtime not loaded — check ort.min.js');

      // 1. Try IDB cache
      let modelBuf = null;
      try {
        log('Checking IndexedDB cache…');
        modelBuf = await idbGet(IDB_KEY);
        if (modelBuf) {
          log('Model found in cache ✓');
          if (MODEL_SHA256) {
            const cachedHash = await sha256Hex(modelBuf);
            if (cachedHash !== MODEL_SHA256) {
              warn('Cached model hash mismatch — re-downloading');
              try { await idbDelete(IDB_KEY); } catch {}
              modelBuf = null;
            }
          }
        }
      } catch (e) {
        warn('IDB read failed, will re-download:', e.message);
      }

      // 2. Download from CDN
      if (!modelBuf) {
        modelBuf = await downloadModelFromCDN();
        if (MODEL_SHA256) {
          const actualHash = await sha256Hex(modelBuf);
          if (actualHash !== MODEL_SHA256) {
            throw new Error(
              `Model integrity check failed. Expected ${MODEL_SHA256.slice(0,16)}…, got ${actualHash.slice(0,16)}…`
            );
          }
          log('Model integrity verified ✓');
        }
        try {
          setModelState({ status: 'loading', progress: 100 });
          log('Saving model to IDB cache…');
          await idbPut(IDB_KEY, modelBuf);
        } catch (e) {
          warn('IDB save failed:', e.message);
        }
      }

      // 3. Create ORT session — WASM only.
      // Removed 'webgpu' from providers because the matching
      // `ort-wasm-simd.jsep.wasm` binary is not bundled. To enable WebGPU
      // (significantly faster on modern GPUs), bundle that file and switch
      // the providers list to ['webgpu', 'wasm'].
      setModelState({ status: 'loading', progress: 100 });
      log('Creating ORT inference session…');

      lamaSession = await self.ort.InferenceSession.create(modelBuf, {
        executionProviders:     ['wasm'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena:      true,
      });

      setModelState({ status: 'ready', progress: 100, error: null });
      log('session ready ✓ inputs:', lamaSession.inputNames);
      return lamaSession;
    } catch (err) {
      lamaSession    = null;
      loadingPromise = null;
      if (err.cancelled) {
        // User-initiated cancel — reset to idle so the popup can show the
        // "ready to set up" panel again rather than a Retry button.
        setModelState({ status: 'idle', progress: 0, error: null });
      } else {
        setModelState({ status: 'error', error: err.message });
      }
      throw err;
    }
  })();

  return loadingPromise;
}

// ── Image processing helpers (pure JS, ported from old background.js) ────────
const TARGET = 512;

function bilinearResize(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH * 4);
  const xS = srcW / dstW, yS = srcH / dstH;
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
      const w00 = (1-xf)*(1-yf), w01 = xf*(1-yf), w10 = (1-xf)*yf, w11 = xf*yf;
      const di = (dy*dstW+dx)*4;
      for (let c = 0; c < 4; c++) {
        dst[di+c] = (src[i00+c]*w00 + src[i01+c]*w01 + src[i10+c]*w10 + src[i11+c]*w11 + 0.5) | 0;
      }
    }
  }
  return dst;
}

function bilinearResizeMono(src, srcW, srcH, dstW, dstH) {
  const dst = new Float32Array(dstW * dstH);
  const xS = srcW / dstW, yS = srcH / dstH;
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
      dst[dy*dstW+dx] =
        src[sy0*srcW+sx0]*(1-xf)*(1-yf) + src[sy0*srcW+sx1]*xf*(1-yf) +
        src[sy1*srcW+sx0]*(1-xf)*yf     + src[sy1*srcW+sx1]*xf*yf;
    }
  }
  return dst;
}

function rgbaToChwFloat(rgba, W, H) {
  const N = W * H;
  const chw = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    chw[i]         = rgba[i*4]   / 255;
    chw[N + i]     = rgba[i*4+1] / 255;
    chw[2*N + i]   = rgba[i*4+2] / 255;
  }
  return chw;
}

function chwFloatToRgba(chw, W, H) {
  const N = W * H;
  const rgba = new Uint8Array(N * 4);
  let maxVal = 0;
  for (let s = 0; s < 20; s++) {
    const i = ((s/20)*N) | 0;
    maxVal = Math.max(maxVal, Math.abs(chw[i]), Math.abs(chw[N+i]), Math.abs(chw[2*N+i]));
  }
  const scale = maxVal > 1.5 ? 1 : 255;
  for (let i = 0; i < N; i++) {
    rgba[i*4]   = Math.max(0, Math.min(255, (chw[i]       * scale + 0.5) | 0));
    rgba[i*4+1] = Math.max(0, Math.min(255, (chw[N+i]     * scale + 0.5) | 0));
    rgba[i*4+2] = Math.max(0, Math.min(255, (chw[2*N+i]   * scale + 0.5) | 0));
    rgba[i*4+3] = 255;
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
  const R = 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y*W+x] < 0.5) continue;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const ny = y+dy, nx = x+dx;
          if (ny >= 0 && ny < H && nx >= 0 && nx < W) out[ny*W+nx] = 1.0;
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
  const feeds = {
    [imgIn]:  new self.ort.Tensor('float32', imgChw,   shape),
    [maskIn]: new self.ort.Tensor('float32', maskFlat, mShape),
  };
  const results = await sess.run(feeds);
  return results[sess.outputNames[0]].data;
}

// ── Inference entry point (called by background) ─────────────────────────────
async function runInpaint({ cropPixels, cropW, cropH, softMask }) {
  const sess = await getLamaSession();
  const src = new Uint8Array(cropPixels);
  const msk = new Float32Array(softMask);

  const resizedImg  = bilinearResize(src, cropW, cropH, TARGET, TARGET);
  const resizedMask = bilinearResizeMono(msk, cropW, cropH, TARGET, TARGET);
  const binMask     = binarize(resizedMask, 0.05);
  const dilMask     = dilate2px(binMask, TARGET, TARGET);
  const imgChw      = rgbaToChwFloat(resizedImg, TARGET, TARGET);

  const outChw    = await runLaMa(sess, imgChw, dilMask);
  const inpainted = chwFloatToRgba(outChw, TARGET, TARGET);

  return Array.from(inpainted);
}

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only handle messages targeted at us
  if (msg.target !== 'offscreen') return false;

  switch (msg.action) {
    case 'getModelState': {
      sendResponse({ ...modelLoadState });
      return false;
    }
    case 'warmup': {
      getLamaSession()
        .then(() => sendResponse({ ok: true, status: 'ready' }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case 'inpaint': {
      runInpaint(msg)
        .then(inpainted512 => sendResponse({ ok: true, inpainted512 }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    case 'clearCache': {
      idbDelete(IDB_KEY)
        .then(() => {
          lamaSession    = null;
          loadingPromise = null;
          setModelState({ status: 'idle', progress: 0, error: null });
          sendResponse({ ok: true });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case 'cancelDownload': {
      // Abort any in-flight CDN fetch. If no download is active this is a no-op.
      if (currentDownloadController) {
        try { currentDownloadController.abort(); } catch {}
      }
      sendResponse({ ok: true });
      return false;
    }
  }
  return false;
});

// On boot, auto-load the model if it's cached in IDB.
//
// WHY: Chrome periodically terminates idle offscreen documents. When it
// respawns, the in-memory ORT session is gone but the model stays in IDB.
// Without this, the popup would show "Model not downloaded" until the user
// manually triggers warmup, even though the model is fully cached.
//
// Cost: ~2-3s of CPU at offscreen boot when cached. Worth it — offscreen
// only spawns when actually needed (popup open with Pro selected, or an
// inference request).
(async () => {
  try {
    if (!self.ort) {
      // ORT didn't load — probably a build issue. Surface the error so the
      // popup's Retry button appears instead of a misleading "not downloaded".
      setModelState({
        status: 'error',
        progress: 0,
        error: 'ONNX Runtime failed to load (ort.min.js)',
      });
      return;
    }
    const cached = await idbGet(IDB_KEY);
    if (cached && cached.byteLength > 1_000_000) {
      log('Cached model detected — auto-loading…');
      setModelState({ status: 'loading', progress: 100, error: null });
      // Hash check (only if MODEL_SHA256 is set)
      if (MODEL_SHA256) {
        const cachedHash = await sha256Hex(cached);
        if (cachedHash !== MODEL_SHA256) {
          warn('Cached model hash mismatch — discarding');
          try { await idbDelete(IDB_KEY); } catch {}
          setModelState({ status: 'idle', progress: 0, error: null });
          return;
        }
      }
      lamaSession = await self.ort.InferenceSession.create(cached, {
        executionProviders:     ['wasm'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena:      true,
      });
      setModelState({ status: 'ready', progress: 100, error: null });
      log('Auto-loaded ✓ inputs:', lamaSession.inputNames);
    } else {
      setModelState({ status: 'idle', progress: 0, error: null });
    }
  } catch (e) {
    // ORT session creation failed on a cached model. The cache is likely
    // corrupt — drop it so the next warmup triggers a fresh download — and
    // surface the error to the popup so the user sees what happened.
    warn('Auto-load failed, discarding cache:', e.message);
    try { await idbDelete(IDB_KEY); } catch {}
    lamaSession = null;
    setModelState({
      status: 'error',
      progress: 0,
      error: 'Cached model failed to load (' + (e.message || 'unknown error') + '). Cache cleared — Retry to re-download.',
    });
  }
})();
log('Ready');