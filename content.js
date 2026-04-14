/**
 * UnmarkAI — ISOLATED WORLD Content Script
 *
 * Has access to Chrome APIs but cannot intercept page JS (that's main-world.js).
 * Communicates with main-world.js via window.postMessage.
 *
 * RESPONSIBILITIES:
 *   • Receive GWR_INTERCEPT messages → fetch image → process → send GWR_DOWNLOAD
 *   • Cache blobs from GWR_BLOB to avoid re-fetching (prevents revocation issues)
 *   • Expose __UAI_scanImages / __UAI_processAndDownload / __UAI_downloadAll for popup
 *   • Sync settings to main world on load and on settings change
 *   • Report stats to background service worker
 *
 * METHODS (cfg.method):
 *   smart  — PatchMatch exemplar inpainting + IDW fill + Gauss-Seidel seam
 *            smoothing. Fully algorithmic, runs in-page, near-instant.
 *   ai     — LaMa neural inpainting via ONNX Runtime (runs in offscreen doc,
 *            ~30–40 s per image, best quality).
 *
 *   All outputs go through a SynthID-disruption pass: Gaussian noise (σ=1.5) +
 *   JPEG round-trip at Q=0.88. Final encoding is PNG.
 *
 * BLOB:NULL NOTES:
 *   Gemini creates image blobs in a sandboxed iframe (null origin), producing
 *   blob:null/uuid URLs. Chrome BLOCKS fetch() of blob:null URLs from
 *   isolated-world content scripts. The fix is two-part:
 *     1. GWR_BLOB accepts a pre-converted dataUrl string (sent by main-world
 *        via FileReader). fetch(dataUrl) always works.
 *     2. fetchImage has a multi-stage fallback chain: cached dataUrl →
 *        cached Blob → data: URL → blob: URL (same-origin only) → HTTPS via
 *        background → imgHint HTTPS URL passed from main-world → DOM scan for
 *        page images.
 */

(function () {
  'use strict';

  const TAG = '[UAI-iso]';

  // ── Settings ───────────────────────────────────────────────────────────────
  // Only these three are user-controllable. Output format is always PNG, visible
  // watermark + SynthID removal are always on, notifications are always on.
  let cfg = {
    enabled:       true,
    autoIntercept: true,   // when false, auto-intercept is off (manual-only mode)
    method:        'smart',
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function init() {
    try {
      const s = await chrome.storage.sync.get('settings');
      if (s.settings) Object.assign(cfg, s.settings);
    } catch (_) {}

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.settings?.newValue) {
        const prev = cfg.method;
        Object.assign(cfg, changes.settings.newValue);
        syncSettings();
        // Pre-warm model when user switches TO AI method
        if (cfg.method === 'ai' && prev !== 'ai') preWarmLaMa();
      }
    });

    syncSettings();
    installMessageBridge();
    installSpaNavigationCleanup();  // clear stale image hints on Gemini SPA nav
    preWarmLaMa();  // trigger model load immediately if AI method is already set
    log('ISOLATED world ready on', window.location.hostname);
  })();

  // Gemini is a SPA. Stale uaiClickedSrc/uaiHoveredSrc dataset values
  // can persist across chats and cause the next download to grab a wrong image.
  // Hook history.pushState/replaceState/popstate to clear them on every nav.
  function installSpaNavigationCleanup() {
    function clearImageHints() {
      delete document.documentElement.dataset.uaiClickedSrc;
      delete document.documentElement.dataset.uaiClickedTime;
      delete document.documentElement.dataset.uaiHoveredSrc;
      delete document.documentElement.dataset.uaiHoveredTime;
      hoveredSrc = null;
      hoveredTime = 0;
    }
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function () {
      clearImageHints();
      return _push.apply(this, arguments);
    };
    history.replaceState = function () {
      clearImageHints();
      return _replace.apply(this, arguments);
    };
    window.addEventListener('popstate', clearImageHints);
  }

  // Send blob to background via short-lived blob URL instead of
  // base64 data URL through sendMessage. For a 4 MB cleaned PNG this drops
  // a ~5.5 MB IPC payload to ~50 bytes — major perf win + dodges the IPC
  // size cliff for very large images.
  async function downloadBlobViaBackground(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    try {
      const result = await chrome.runtime.sendMessage({
        action:   'downloadClean',
        blobUrl,
        filename: normalizeFilename(filename),
      });
      if (!result?.ok) throw new Error(result?.error || 'Download failed');
      return result;
    } finally {
      // Revoke after Chrome has had time to start the download.
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 60_000);
    }
  }

  // Push current enabled state to main world so it knows whether to intercept
  function syncSettings() {
    window.postMessage({
      gwrType:       'GWR_SETTINGS',
      enabled:       cfg.enabled,
      autoIntercept: cfg.autoIntercept !== false, // default true
    }, '*');
  }

  // Originals cache for the "View original" feature.
  // Each clean operation registers the unprocessed image so the user can
  // download it as a fallback if the AI output isn't what they wanted.
  // LRU-bounded + 5-minute TTL — won't accumulate across long Gemini sessions.
  const ORIGINALS_MAX = 12;
  const ORIGINALS_TTL = 5 * 60_000;  // 5 minutes
  const originalsCache = new Map();   // id → { blob, filename, ts }

  // Parallel cache for cleaned output, keyed by the SAME id as the original.
  // Stores a downscaled JPEG (max 800px) so the before/after preview modal
  // can load both images cheaply. Full-res cleaned blob has already been
  // saved to disk by the time we get here; we only need enough for preview.
  const cleanedCache = new Map();     // id → { blob, ts }

  function registerOriginal(rawBlob, filename) {
    const id = 'o_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    originalsCache.set(id, { blob: rawBlob, filename, ts: Date.now() });
    // Evict oldest if over cap (Map preserves insertion order)
    while (originalsCache.size > ORIGINALS_MAX) {
      const oldest = originalsCache.keys().next().value;
      originalsCache.delete(oldest);
    }
    // Auto-expire
    setTimeout(() => originalsCache.delete(id), ORIGINALS_TTL);
    return id;
  }

  // Downscale an image blob to a JPEG at max dimension, for preview use.
  // JPEG chosen over PNG because previews are photographic and JPEG at 0.88
  // is typically 5-10× smaller than PNG with no perceptible quality loss.
  async function downscaleToJpeg(blob, maxWidth = 800, quality = 0.88) {
    const bitmap = await createImageBitmap(blob);
    const w = Math.min(maxWidth, bitmap.width);
    const h = Math.round(bitmap.height * (w / bitmap.width));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', quality)
    );
  }

  // Fire-and-forget: immediately after a clean succeeds, stash a downscaled
  // JPEG preview keyed to the same id as the original. Failures are logged
  // but never propagate — the Compare feature is best-effort.
  async function cacheCleanedPreview(id, cleanBlob) {
    try {
      const preview = await downscaleToJpeg(cleanBlob, 800, 0.88);
      cleanedCache.set(id, { blob: preview, ts: Date.now() });
      while (cleanedCache.size > ORIGINALS_MAX) {
        const oldest = cleanedCache.keys().next().value;
        cleanedCache.delete(oldest);
      }
      setTimeout(() => cleanedCache.delete(id), ORIGINALS_TTL);
    } catch (e) {
      log('Cleaned-preview cache failed:', e.message);
    }
  }

  async function downloadOriginal(id) {
    const entry = originalsCache.get(id);
    if (!entry) {
      log('Original cache miss for id:', id);
      toast('Original no longer available', 'error');
      return false;
    }
    // Build "filename-original.ext" from the cleaned filename
    const orig = entry.filename
      .replace(/\.png$/i, '-original.png')
      .replace(/\.jpg$/i, '-original.jpg')
      .replace(/\.jpeg$/i, '-original.jpeg')
      .replace(/\.webp$/i, '-original.webp');
    try {
      await downloadBlobViaBackground(entry.blob, orig);
      toast('Original saved', 'success');
      return true;
    } catch (e) {
      log('downloadOriginal failed:', e.message);
      toast('Could not save original', 'error');
      return false;
    }
  }

  // Prevents the same URL from being processed twice (e.g., if both the primary
  // intercept and the popup manual-download trigger simultaneously).
  const processingUrls = new Set();

  // ── Image data cache ─────────────────────────────────────────────────
  const blobCache = new Map(); // blobUrl → data URL string or Blob


  /**
   * Open a persistent port to background.js, send the crop, and wait for the
   * inpainted 512×512 result. The port keeps the service worker alive for the
   * full duration of LaMa inference — no timeout, no dropped connections.
   *
   * Pass an AbortSignal to make the operation cancelable. On abort we
   * disconnect the port (the offscreen inference keeps running to completion
   * but its result is discarded) and reject with an AbortError.
   */
  function lamaInpaintViaBackground({ cropPixels, cropW, cropH, softMask, signal }) {
    return new Promise((resolve, reject) => {
      let port;
      let settled = false;

      try {
        port = chrome.runtime.connect({ name: 'lama-inpaint' });
      } catch (e) {
        return reject(new Error('Could not connect to background: ' + e.message));
      }

      const cleanup = () => {
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        try { port.disconnect(); } catch {}
      };

      const onAbort = () => {
        if (settled) return;
        cleanup();
        const err = new Error('Cancelled');
        err.cancelled = true;
        reject(err);
      };

      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Handle messages from background
      port.onMessage.addListener((msg) => {
        if (settled) return;
        if (msg.type === 'progress') {
          toast(msg.msg, 'info');
          log('bg:', msg.msg);
          return;
        }
        if (msg.type === 'result') {
          cleanup();
          if (msg.ok) resolve(msg.inpainted512);
          else        reject(new Error(msg.error || 'inference failed'));
        }
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        const err = chrome.runtime.lastError?.message || 'Port disconnected unexpectedly';
        reject(new Error(err));
      });

      // Send the crop data — background starts inference immediately
      port.postMessage({
        cropPixels: Array.from(cropPixels), // Uint8ClampedArray → plain Array
        cropW,
        cropH,
        softMask:   Array.from(softMask),  // Float32Array → plain Array
      });
    });
  }

  /**
   * Scale a 512×512 inpainted RGBA result back to cropW×cropH,
   * then soft-blend it into `ctx` at the crop coordinates using softMask.
   *
   * @param {CanvasRenderingContext2D} ctx      — main image canvas
   * @param {Array|Uint8ClampedArray}  inpainted512 — 512×512 RGBA from background
   * @param {number} cropX, cropY, cropW, cropH — crop location in canvas
   * @param {Float32Array} softMask             — [cropW × cropH] alpha, 0–1
   */
  function compositeInpainted(ctx, inpainted512, cropX, cropY, cropW, cropH, softMask) {
    // Step 1: put 512×512 result onto a temp canvas
    const src    = document.createElement('canvas');
    src.width    = 512; src.height = 512;
    src.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(inpainted512), 512, 512), 0, 0
    );

    // Step 2: scale to crop dimensions
    const scaled    = document.createElement('canvas');
    scaled.width    = cropW; scaled.height = cropH;
    scaled.getContext('2d').drawImage(src, 0, 0, cropW, cropH);
    const inpData   = scaled.getContext('2d').getImageData(0, 0, cropW, cropH).data;

    // Step 3: read original pixels at crop region, blend, write back
    const origData  = ctx.getImageData(cropX, cropY, cropW, cropH);
    const d         = origData.data;

    for (let i = 0; i < cropW * cropH; i++) {
      const a = softMask[i];
      if (a < 0.005) continue;
      const inv = 1 - a;
      d[i*4]   = ((d[i*4]   * inv + inpData[i*4]   * a) + 0.5) | 0;
      d[i*4+1] = ((d[i*4+1] * inv + inpData[i*4+1] * a) + 0.5) | 0;
      d[i*4+2] = ((d[i*4+2] * inv + inpData[i*4+2] * a) + 0.5) | 0;
      // alpha channel (d[i*4+3]) untouched
    }

    ctx.putImageData(origData, cropX, cropY);
  }



  // ── Hover state — synced from main-world.js via GWR_HOVER ─────────────────
  // Background.js's download fallback calls __UAI_processAndDownload(url) with
  // no imgHint. We use the most recently hovered image-button src as the hint,
  // since the user must hover an image before its download button appears.
  let hoveredSrc  = null;
  let hoveredTime = 0;

  // ── Message Bridge ─────────────────────────────────────────────────────────
  function installMessageBridge() {
    window.addEventListener('message', async (e) => {
      if (!e.data || typeof e.data.gwrType !== 'string') return;
      if (e.origin !== window.location.origin && e.origin !== 'null') return;

      switch (e.data.gwrType) {

        case 'GWR_HOVER': {
          // main-world.js tells us which image the user is hovering over.
          // We store it so background.js's fallback path can use it.
          if (e.data.src) { hoveredSrc = e.data.src; hoveredTime = Date.now(); }
          break;
        }

        // main-world now sends a pre-converted data URL string (not a Blob)
        case 'GWR_BLOB': {
          const { url, dataUrl, blob } = e.data;
          const cached = (typeof dataUrl === 'string' && dataUrl.startsWith('data:'))
            ? dataUrl
            : (blob instanceof Blob ? blob : null);
          if (url && cached) {
            blobCache.set(url, cached);
            setTimeout(() => blobCache.delete(url), 90_000);
          }
          break;
        }

        case 'GWR_INTERCEPT': {
          if (!cfg.enabled) {
            window.postMessage({ gwrType: 'GWR_FALLBACK', url: e.data.url, filename: e.data.filename }, '*');
            return;
          }
          chrome.runtime.sendMessage({ action: 'lockUrl', url: e.data.url }).catch(() => {});
          await processIntercept(
            e.data.url,
            e.data.filename,
            blobCache.get(e.data.url),
            e.data.imgHint ?? null,
          );
          break;
        }
      }
    });
  }

  // imgHint param — HTTPS URL from a nearby <img> on the page,
  // used as fallback when the download URL is a blob:null we cannot fetch.
  async function processIntercept(url, filename, cachedData = null, imgHint = null) {
    if (processingUrls.has(url)) {
      log('Duplicate intercept ignored for:', url.slice(0, 60));
      return;
    }
    processingUrls.add(url);

    // Persistent progress card for Pro mode (long wait). Smart mode is fast
    // enough that the existing toast is sufficient.
    const usePro = (cfg.method === 'ai');
    const abortCtrl = usePro ? new AbortController() : null;
    const card = usePro
      ? showProgressCard({ onCancel: abortCtrl ? () => abortCtrl.abort() : null })
      : null;
    if (!card) toast('Removing watermark…', 'info');

    try {
      const rawBlob   = await fetchImage(url, cachedData, imgHint);
      const cleanBlob = await processImage(rawBlob, abortCtrl?.signal);

      // Send blob via blob URL instead of giant base64 data URL (cheap IPC).
      await downloadBlobViaBackground(cleanBlob, filename);

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      // Clear the click hint so it doesn't affect the next download if jslog fails
      delete document.documentElement.dataset.uaiClickedSrc;
      delete document.documentElement.dataset.uaiClickedTime;

      // Cache the original so user can fall back to it if the AI result isn't
      // what they wanted. Available via the "Download original" link in card.
      const originalId = registerOriginal(rawBlob, filename);
      // Also cache a downscaled cleaned preview for the before/after modal.
      cacheCleanedPreview(originalId, cleanBlob);

      if (card) card.success('Watermark removed · Saved', { originalId });
      else      toast('Watermark removed ✓', 'success');
      log('Processed:', filename);
    } catch (err) {
      if (err.cancelled) {
        log('Cancelled by user:', filename);
        if (card) card.cancelled('You cancelled this clean');
        // On cancel, don't fall back to native download — the user asked
        // us to stop, so stop. They can download manually if they want.
      } else {
        log('Processing error:', err.message);
        if (card) card.error(err.message || 'Processing failed');
        else      toast('Processing failed — downloading original', 'error');
        window.postMessage({ gwrType: 'GWR_FALLBACK', url, filename }, '*');
      }
    } finally {
      processingUrls.delete(url);
      blobCache.delete(url);
    }
  }

  // ── Image Fetch — multi-stage fallback chain ─────────────────────────
  //
  //  Stage 1: cached data URL string (pre-converted by main-world FileReader)
  //  Stage 2: cached Blob object (legacy GWR_BLOB path)
  //  Stage 3: data: URL directly in the intercept URL
  //  Stage 4: blob: URL with KNOWN accessible origin — try fetch()
  //           blob:null is SKIPPED entirely (Chrome always logs a security
  //           violation even when caught by try/catch — skipping eliminates
  //           the error from the extension console completely)
  //  Stage 5: HTTPS URL — delegate to background service worker
  //  Stage 6: imgHint (HTTPS URL found by main-world near the anchor element)
  //  Stage 7: DOM scan — same logic as __UAI_scanImages (always finds images
  //           that are visible on the Gemini page)
  async function fetchImage(url, cachedData = null, imgHint = null) {

    // Stage 1: pre-converted data URL from main-world (most reliable path)
    if (typeof cachedData === 'string' && cachedData.startsWith('data:')) {
      log('Stage 1: pre-converted data URL from main-world');
      const r = await fetch(cachedData);
      if (!r.ok) throw new Error(`data URL fetch failed: ${r.status}`);
      return r.blob();
    }

    // Stage 2: raw Blob object received via GWR_BLOB (legacy path)
    if (cachedData instanceof Blob) {
      log('Stage 2: cached Blob object');
      return cachedData;
    }

    // Stage 3: the intercept URL itself is a data: URL
    if (url.startsWith('data:')) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`data: fetch failed: ${r.status}`);
      return r.blob();
    }

    // Stage 4: blob: URL — only attempt fetch for KNOWN accessible origins.
    // blob:null (sandboxed iframe) is detected here and skipped WITHOUT calling
    // fetch() at all. Chrome logs blob:null fetch attempts to the extension error
    // console even when caught by try/catch, so we must not call fetch() at all.
    if (url.startsWith('blob:')) {
      const isBlobNull = url.startsWith('blob:null');
      if (!isBlobNull) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`blob fetch HTTP ${r.status}`);
          log('Stage 4: blob fetch succeeded');
          return r.blob();
        } catch (blobErr) {
          log('Stage 4 failed:', blobErr.message, '— falling through to page-image fallback');
        }
      } else {
        log('Stage 4 skipped: blob:null URL (sandboxed iframe) — going straight to fallback');
      }
      // blob: URL is inaccessible — fall through to stages 6 & 7
    }

    // Stage 5: plain HTTPS URL — delegate to background service worker
    if (!url.startsWith('blob:')) {
      const result = await chrome.runtime.sendMessage({ action: 'fetchImage', url });
      if (!result?.error) {
        log('Stage 5: HTTPS fetch via background succeeded');
        return new Blob([new Uint8Array(result.buffer)], {
          type: result.mimeType || 'image/png',
        });
      }
      throw new Error(result.error);
    }

    // ── Stages 6 & 7: page-image fallback ────────────────────────────────────
    // The download URL is a blob:null (sandboxed iframe — inaccessible).
    // Priority order for the fallback URL:
    //   1. imgHint       — from GWR_INTERCEPT (only when main-world intercepted directly)
    //   2. uaiClickedSrc — written to DOM by main-world's click listener at CLICK TIME
    //                      via jslog rc_ cross-reference. Most reliable: written
    //                      synchronously in the same event tick as the user's click,
    //                      so scripting.executeScript always reads the correct image.
    //   3. uaiHoveredSrc — written on image-button mouseover (5s window)
    //   4. findBestPageImageUrl() — DOM scan (last resort, often latest image)
    const clickedSrc  = document.documentElement.dataset.uaiClickedSrc  || null;
    const clickedTime = parseInt(document.documentElement.dataset.uaiClickedTime || '0', 10);
    // 15-second window (was 60s). Combined with SPA navigation cleanup,
    // this prevents stale clicks from earlier chats grabbing the wrong image.
    const clickHint   = (clickedSrc && Date.now() - clickedTime < 15000) ? clickedSrc : null;

    const domSrc      = document.documentElement.dataset.uaiHoveredSrc  || null;
    const domTime     = parseInt(document.documentElement.dataset.uaiHoveredTime || '0', 10);
    // 5-second hover window — only use if no click hint available
    const recentHover = (domSrc && Date.now() - domTime < 5000) ? domSrc : null;

    const fallbackUrl = imgHint || clickHint || recentHover || findBestPageImageUrl();

    if (!fallbackUrl) {
      throw new Error(
        'blob:null URL is inaccessible and no Gemini image found on this page. ' +
        'Please use Manual Scan in the popup as a workaround.'
      );
    }

    log('Stage 6/7: using page <img> fallback:', fallbackUrl.slice(0, 80),
        imgHint ? '(imgHint)' : clickHint ? '(click)' : recentHover ? '(hover)' : '(DOM scan)');

    if (fallbackUrl.startsWith('blob:')) {
      const r = await fetch(fallbackUrl);
      if (!r.ok) throw new Error(`Blob fallback fetch failed: ${r.status}`);
      return r.blob();
    }

    const result = await chrome.runtime.sendMessage({ action: 'fetchImage', url: fallbackUrl });
    if (result?.error) throw new Error(`Fallback fetch failed: ${result.error}`);
    return new Blob([new Uint8Array(result.buffer)], {
      type: result.mimeType || 'image/png',
    });
  }

  // Scan the DOM for large Gemini-generated images.
  // Uses the SAME URL patterns as __UAI_scanImages so it always matches
  // whatever __UAI_scanImages finds (manual scan = direct download = same logic).
  //
  // only skip blob:null (sandboxed-iframe, truly inaccessible).
  // blob:https://gemini.google.com/uuid are same-origin blobs — content scripts
  // CAN fetch them (Stage 4), and they're what Gemini uses for <img src>.
  // The old "skip all blob:" was why the fallback always returned null.
  function findBestPageImageUrl() {
    const imgs = Array.from(document.querySelectorAll('img[src]'));
    for (let i = imgs.length - 1; i >= 0; i--) {
      const img = imgs[i];
      if (img.naturalWidth < 256 || img.naturalHeight < 256) continue;
      const { src } = img;

      // Only skip null-origin blobs — same-origin blobs ARE fetchable
      if (src.startsWith('blob:null')) continue;

      // Same-origin blob: URL (blob:https://gemini.google.com/...) — accept
      if (src.startsWith('blob:')) return src;

      // Known Gemini HTTPS image domains
      if (
        src.includes('googleusercontent.com') ||
        src.includes('generativelanguage.googleapis.com') ||
        src.includes('storage.googleapis.com') ||
        src.includes('generatedimage')
      ) return src;

      // Broad fallback: any URL with a recognised image extension
      try {
        const path = new URL(src, location.href).pathname;
        if (/\.(png|jpe?g|webp)(\?|$)/i.test(path)) return src;
      } catch {}
    }
    return null;
  }

  // ── SynthID Removal — Gaussian noise + internal JPEG round-trip ────────
  //
  // PROBLEM with the old approach: canvas re-encode to PNG is lossless —
  // pixel values are UNCHANGED, so any frequency-domain fingerprint (SynthID)
  // survives completely. Only JPEG output at q<98 would disrupt it, and even
  // then only partially.
  //
  // TWO-LAYER FIX:
  //   Layer 1 — Gaussian noise σ=1.5 (Box-Muller).
  //     Adds ±1–3 counts to each RGB channel, below the JND (just-noticeable
  //     difference ≈ 3–4 counts). Disrupts LSB steganography and any signal
  //     that encodes information in absolute pixel values.
  //
  //   Layer 2 — Internal JPEG round-trip at quality 88.
  //     Encodes to JPEG (DCT quantization) then decodes back to raw pixels.
  //     Quality 88 is visually lossless on photographic content (standard
  //     save-for-web quality) but the quantization step irreversibly destroys
  //     any frequency-domain steganographic pattern — SynthID is almost
  //     certainly frequency-domain encoded.
  //
  //   Final output is then re-encoded in the user's chosen format (PNG/JPEG).
  //   Both layers together make reconstruction of the original SynthID signal
  //   computationally infeasible regardless of the encoding scheme used.
  async function synthIdStrip(canvas, ctx, W, H) {
    // Layer 1: Gaussian noise injection (Box-Muller transform)
    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;
    const σ = 1.5;

    for (let i = 0; i < d.length - 3; i += 4) {
      // Two independent Gaussian samples from two uniform pairs
      const u1a = Math.random() || 1e-10, u1b = Math.random() || 1e-10;
      const u2a = Math.random() || 1e-10, u2b = Math.random() || 1e-10;
      const mag1 = σ * Math.sqrt(-2 * Math.log(u1a));
      const mag2 = σ * Math.sqrt(-2 * Math.log(u1b));
      const n0 = mag1 * Math.cos(2 * Math.PI * u1b);
      const n1 = mag1 * Math.sin(2 * Math.PI * u1b);
      const n2 = mag2 * Math.cos(2 * Math.PI * u2a);
      d[i]   = Math.max(0, Math.min(255, (d[i]   + n0 + 0.5) | 0));
      d[i+1] = Math.max(0, Math.min(255, (d[i+1] + n1 + 0.5) | 0));
      d[i+2] = Math.max(0, Math.min(255, (d[i+2] + n2 + 0.5) | 0));
      // Alpha channel untouched
    }
    ctx.putImageData(imgData, 0, 0);

    // Layer 2: JPEG round-trip — destroys DCT-domain frequency patterns
    const jpegBlob = await new Promise((res, rej) =>
      canvas.toBlob(
        b => b ? res(b) : rej(new Error('JPEG round-trip toBlob failed')),
        'image/jpeg', 0.88
      )
    );
    const bmp = await createImageBitmap(jpegBlob);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    // Canvas now holds the JPEG-quantized, noise-injected image.
    // Subsequent toBlob() in processImage() will encode in user's chosen format.
  }


  // ── AI Method — LaMa Neural Inpainting ─────────────────────────────────
  //

  /**
   * Open a warmup port to trigger model loading in the background service worker.
   * Called at page load if AI method is already selected, and whenever the user
   * switches TO the AI method (storage.onChanged fires and content.js sees it).
   *
   * This ensures the model is loaded and session is warm BEFORE the user clicks
   * download, eliminating the "Port disconnected unexpectedly" first-use failure.
   */
  function preWarmLaMa() {
    if (cfg.method !== 'ai') return;
    log('Pre-warming model in background…');
    let port;
    try {
      port = chrome.runtime.connect({ name: 'lama-inpaint' });
    } catch (e) {
      log('Pre-warm connect failed:', e.message);
      return;
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === 'warmed' || msg.type === 'ready') {
        log('LaMa model pre-warmed ✓');
        try { port.disconnect(); } catch {}
      }
    });

    port.onDisconnect.addListener(() => {
      // Silence — either warmed successfully or SW was killed. Either way,
      // next actual inpaint will retry the model load.
      if (chrome.runtime.lastError) {}
    });

    // Send warmup signal — background loads the model and responds
    port.postMessage({ type: 'warmup' });

    // Disconnect after 3 minutes regardless (model should be loaded by then)
    setTimeout(() => { try { port.disconnect(); } catch {} }, 180_000);
  }


  // Routes to the LaMa Web Worker for state-of-the-art inpainting:
  //   1. Detect sparkle bounding box using existing detectSparkle()
  //   2. Expand to a context crop (40px padding, minimum 200×200)
  //   3. Build a feathered soft mask over the sparkle region
  //   4. Send crop + mask to lama-worker.js → ONNX inference at 512×512
  //   5. Worker composites result back at original resolution
  //   6. Apply synthIdStrip() (noise + JPEG round-trip)
  //   7. Encode final blob in user's chosen format
  async function processImageAI(blob, signal) {
    toast('Preparing AI inpainting…', 'info');

    if (signal?.aborted) {
      const e = new Error('Cancelled'); e.cancelled = true; throw e;
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      throw new Error('Could not decode image: ' + err.message);
    }

    const W = bitmap.width, H = bitmap.height;
    log('AI processing', W, '×', H);

    const canvas = document.createElement('canvas');
    canvas.width  = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // Visible-watermark removal — always on for AI mode.
    {
      const fullImgData = ctx.getImageData(0, 0, W, H);
      const { data } = fullImgData;

      let region = detectSparkle(data, W, H);
      if (!region) {
        const sz = Math.max(44, Math.floor(Math.min(W, H) * 0.06));
        if (cornerLooksLikeSparkle(data, W, H, sz)) {
          region = { x: W - sz, y: H - sz, width: sz, height: sz };
          log('Using corner-zone fallback for AI inpainting');
        }
      }

      if (region) {
        log('AI inpainting region:', JSON.stringify(region));
        toast('Running inpainting…', 'info');

        // Expand crop with context padding for LaMa
        // ── Crop window — shift instead of clip ───────────────────────────────
        // The sparkle is always bottom-right. The old formula clipped the crop
        // at the image edge, giving LaMa only ~140×140px of context.
        // Instead: compute the desired crop size first, then SHIFT the window
        // so it fits inside the image while still covering the sparkle + context.
        const PAD     = 64;   // generous padding for texture context
        const MINCROP = 300;  // minimum crop side — enough for LaMa to infer bg

        // Desired crop size: at least MINCROP, at most the full image
        const desiredW = Math.min(W, Math.max(MINCROP, region.width  + PAD * 2));
        const desiredH = Math.min(H, Math.max(MINCROP, region.height + PAD * 2));

        // Ideal top-left: PAD pixels above/left of the sparkle
        let cropX = region.x - PAD;
        let cropY = region.y - PAD;

        // If window extends past the RIGHT edge → shift LEFT
        if (cropX + desiredW > W) cropX = W - desiredW;
        // If window extends past the BOTTOM edge → shift UP
        if (cropY + desiredH > H) cropY = H - desiredH;

        // Clamp to [0, W/H] in case the image itself is smaller than MINCROP
        cropX = Math.max(0, cropX);
        cropY = Math.max(0, cropY);
        const cropW = Math.min(desiredW, W - cropX);
        const cropH = Math.min(desiredH, H - cropY);
        // ─────────────────────────────────────────────────────────────────────

        // Build feathered soft mask (1.0 inside sparkle, feathered at edges)
        const FEATHER  = 8;  // wider feather for smoother composite edge
        const softMask = new Float32Array(cropW * cropH);
        for (let row = 0; row < cropH; row++) {
          for (let col = 0; col < cropW; col++) {
            const ar = cropY + row, ac = cropX + col;
            // Skip pixels outside the sparkle bounding box
            if (ar < region.y || ar >= region.y + region.height ||
                ac < region.x || ac >= region.x + region.width) continue;
            // Distance from nearest sparkle edge → smooth 0→1 ramp
            const dist = Math.min(
              ar - region.y,
              region.y + region.height - 1 - ar,
              ac - region.x,
              region.x + region.width  - 1 - ac,
            );
            // Pure feather: 0.0 at edge, 1.0 after FEATHER pixels
            // (No minimum offset — avoids the visible ring at the boundary)
            softMask[row * cropW + col] = Math.min(1.0, dist / FEATHER);
          }
        }

        // Extract crop pixels for the message
        const cropData = ctx.getImageData(cropX, cropY, cropW, cropH);

        try {
          const inpainted512 = await lamaInpaintViaBackground({
            cropPixels: cropData.data, // Uint8ClampedArray
            cropW,
            cropH,
            softMask,
            signal,
          });

          compositeInpainted(ctx, inpainted512, cropX, cropY, cropW, cropH, softMask);
          log('inpainting complete ✓');
          toast('AI inpainting done ✓', 'success');

        } catch (lamaErr) {
          if (lamaErr.cancelled) throw lamaErr;  // bubble cancellation up
          log('failed, falling back to Smart:', lamaErr.message);
          toast('AI failed — using Smart fallback', 'error');
          removeVisibleWatermark(ctx, W, H);
        }

      } else {
        log('No sparkle detected — skipping AI inpainting');
      }
    }

    // SynthID disruption: always applied.
    await synthIdStrip(canvas, ctx, W, H);

    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('canvas.toBlob returned null')), 'image/png')
    );
  }


  // ── Image Processing Pipeline ──────────────────────────────────────────────
  async function processImage(blob, signal) {
    // Route AI method to LaMa neural inpainting (entirely separate path)
    if (cfg.method === 'ai') {
      return processImageAI(blob, signal);
    }

    // Smart path (algorithmic PatchMatch inpainting).
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      throw new Error(`Could not decode image: ${err.message}`);
    }

    const W = bitmap.width, H = bitmap.height;
    log('Processing', W, '×', H, '| method: smart');

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width  = W;
    canvas.height = H;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    removeVisibleWatermark(ctx, W, H);

    // SynthID disruption: Gaussian noise (σ=1.5) + JPEG round-trip.
    // Disrupts both LSB and DCT-domain fingerprints. Always applied.
    await synthIdStrip(canvas, ctx, W, H);

    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('canvas.toBlob returned null')), 'image/png')
    );
  }


  // ── Visible Watermark Removal ──────────────────────────────────────────────
  function removeVisibleWatermark(ctx, W, H) {
    const imgData  = ctx.getImageData(0, 0, W, H);
    const { data } = imgData;

    const region = detectSparkle(data, W, H);
    if (region) {
      log('Sparkle detected at', JSON.stringify(region));
      inpaintRegion(data, W, H, region);
      ctx.putImageData(imgData, 0, 0);
    } else {
      // Fallback: only apply if the corner actually contains sparkle-like pixels.
      // Without this guard, images without a sparkle get a visible flat-color
      // patch in the bottom-right corner (the IDW average of edge pixels is
      // a single blended color with no variation from the missing samples).
      const sz = Math.max(44, Math.floor(Math.min(W, H) * 0.06));
      if (cornerLooksLikeSparkle(data, W, H, sz)) {
        log('Sparkle not detected precisely — applying corner-zone fallback');
        const fallback = { x: W - sz, y: H - sz, width: sz, height: sz };
        inpaintRegion(data, W, H, fallback);
        ctx.putImageData(imgData, 0, 0);
      } else {
        log('No sparkle-like pixels in corner — skipping fallback to avoid artifact');
      }
    }
  }

  // Quick scan: does the bottom-right corner contain any blue-tinted
  // lighter-than-background pixels that could be Gemini's ✦ watermark?
  function cornerLooksLikeSparkle(data, W, H, sz) {
    const startX = W - sz, startY = H - sz;
    let flagged = 0;
    for (let y = startY; y < H; y++) {
      for (let x = startX; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Broad lavender/light-blue: anything brighter than average with blue bias
        if (b > r + 2 && r > 60 && b > 90 && r < 220) flagged++;
      }
    }
    // At least 1.5% of the corner must look sparkle-like
    return (flagged / (sz * sz)) >= 0.015;
  }

  // ── Sparkle Detector ───────────────────────────────────────────────────────
  /**
   * Locates the Gemini ✦ watermark in the bottom-right corner using two
   * independent signals combined with OR logic.
   */
  function detectSparkle(data, W, H) {
    const SCAN = Math.min(160, Math.floor(Math.min(W, H) * 0.17));
    const SX   = W - SCAN;
    const SY   = H - SCAN;
    const ARM  = 7;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let count = 0;

    for (let y = SY + ARM; y < H - ARM; y++) {
      for (let x = SX + ARM; x < W - ARM; x++) {
        const ci = (y * W + x) * 4;
        const r  = data[ci], g = data[ci + 1], b = data[ci + 2];

        // Signal 1: lavender-gray color fingerprint (slightly broadened ranges)
        const isLavender = (
          r >= 80  && r <= 185 &&
          g >= 80  && g <= 185 &&
          b >= 110 && b <= 215 &&
          Math.abs(r - g) < 35 &&
          b > r + 3
        );

        // Signal 2: 4-fold star shape luminance contrast
        const N  = lum(data[((y-ARM)*W+x)*4],   data[((y-ARM)*W+x)*4+1], data[((y-ARM)*W+x)*4+2]);
        const S  = lum(data[((y+ARM)*W+x)*4],   data[((y+ARM)*W+x)*4+1], data[((y+ARM)*W+x)*4+2]);
        const E  = lum(data[(y*W+(x+ARM))*4],   data[(y*W+(x+ARM))*4+1], data[(y*W+(x+ARM))*4+2]);
        const Ww = lum(data[(y*W+(x-ARM))*4],   data[(y*W+(x-ARM))*4+1], data[(y*W+(x-ARM))*4+2]);
        const d  = Math.round(ARM * 0.707);
        const NE = lum(data[((y-d)*W+(x+d))*4], data[((y-d)*W+(x+d))*4+1], data[((y-d)*W+(x+d))*4+2]);
        const NW = lum(data[((y-d)*W+(x-d))*4], data[((y-d)*W+(x-d))*4+1], data[((y-d)*W+(x-d))*4+2]);
        const SE = lum(data[((y+d)*W+(x+d))*4], data[((y+d)*W+(x+d))*4+1], data[((y+d)*W+(x+d))*4+2]);
        const SW = lum(data[((y+d)*W+(x-d))*4], data[((y+d)*W+(x-d))*4+1], data[((y+d)*W+(x-d))*4+2]);
        const isStarShape = Math.abs((N+S+E+Ww)/4 - (NE+NW+SE+SW)/4) > 12;

        if (isLavender || isStarShape) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          count++;
        }
      }
    }

    if (count < 4 || minX === Infinity) return null;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    const density = count / (bw * bh);
    if (density < 0.02) return null;   // lowered from 0.04 → catches lighter sparkles

    if (bw > 130 || bh > 130) return null;
    if (bw <   4 || bh <   4) return null;

    const pad = 4;
    return {
      x:      Math.max(0, minX - pad),
      y:      Math.max(0, minY - pad),
      width:  Math.min(W, maxX + pad + 1) - Math.max(0, minX - pad),
      height: Math.min(H, maxY + pad + 1) - Math.max(0, minY - pad),
    };
  }

  // ── Inpainting ─────────────────────────────────────────────────────────────
  /**
   * Smart inpainting: PatchMatch exemplar search (plain surfaces fall back to
   * IDW background fill) plus a Gauss-Seidel boundary smoothing pass to
   * eliminate the seam where the patched region meets the original pixels.
   *
   * This is the same core algorithm used by Photoshop Content-Aware Fill and
   * professional inpainting tools — it finds the most visually similar patch
   * from elsewhere in the image and copies that texture, making the result
   * pixel-perfect on gradients and complex surfaces.
   */
  function inpaintRegion(data, W, H, bounds) {
    const { x, y, width: bw, height: bh } = bounds;

    // ── SMART: PatchMatch exemplar inpainting + soft boundary blending ────────
    //
    // Three phases:
    //   1. Build a per-pixel background estimate (IDW from border) + anomaly map
    //   2. PatchMatch: for each sparkle pixel, search the image for the best
    //      matching texture patch and record its centre value
    //   3. Soft-blend output: hard cut at the sparkle boundary is the cause of
    //      visible seams — instead, blend alpha = 0→1 over a feather zone so
    //      the transition is invisible at any zoom level

    // ── Collect border background samples ────────────────────────────────────
    const bgSamples = [];
    const BG_STEP = 5;
    for (let bx = x; bx < x + bw; bx += BG_STEP) {
      if (y > 0) {
        const i = ((y - 1) * W + Math.max(0, Math.min(W - 1, bx))) * 4;
        bgSamples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: y - 1 });
      }
      if (y + bh < H) {
        const i = ((y + bh) * W + Math.max(0, Math.min(W - 1, bx))) * 4;
        bgSamples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: y + bh });
      }
    }
    for (let by = y; by < y + bh; by += BG_STEP) {
      if (x > 0) {
        const i = (Math.max(0, Math.min(H - 1, by)) * W + (x - 1)) * 4;
        bgSamples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: x - 1, sy: by });
      }
      if (x + bw < W) {
        const i = (Math.max(0, Math.min(H - 1, by)) * W + (x + bw)) * 4;
        bgSamples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: x + bw, sy: by });
      }
    }
    // Fallback: wider ring for full-corner regions where all borders are at image edge
    if (bgSamples.length < 4) {
      const wpad = 15;
      for (let bx = Math.max(0, x - wpad); bx < Math.min(W, x + bw + wpad); bx += BG_STEP) {
        for (let by = Math.max(0, y - wpad); by < Math.min(H, y + bh + wpad); by += BG_STEP) {
          if (bx >= x && bx < x + bw && by >= y && by < y + bh) continue;
          const i = (by * W + bx) * 4;
          bgSamples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: by });
        }
      }
    }

    // ── Phase 1: per-pixel background estimate + anomaly score ──────────────
    const bgEst  = new Float32Array(bw * bh * 3);
    const aScore = new Float32Array(bw * bh);

    for (let row = y; row < Math.min(H, y + bh); row++) {
      for (let col = x; col < Math.min(W, x + bw); col++) {
        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        for (const p of bgSamples) {
          const dx = p.sx - col, dy = p.sy - row;
          const w  = 1 / (dx * dx + dy * dy + 0.25);
          sumR += p.r * w; sumG += p.g * w; sumB += p.b * w; sumW += w;
        }
        const pi = (row - y) * bw + (col - x);
        const er = sumW ? sumR / sumW : 18;
        const eg = sumW ? sumG / sumW : 19;
        const eb = sumW ? sumB / sumW : 50;
        bgEst[pi * 3] = er; bgEst[pi * 3 + 1] = eg; bgEst[pi * 3 + 2] = eb;
        const ci = (row * W + col) * 4;
        aScore[pi] = (Math.abs(data[ci] - er) + Math.abs(data[ci+1] - eg) + Math.abs(data[ci+2] - eb)) / 3;
      }
    }

    // ── Measure surface complexity first (needed to pick threshold) ──────────
    let mR = 0, mG = 0, mB = 0;
    for (const p of bgSamples) { mR += p.r; mG += p.g; mB += p.b; }
    mR /= bgSamples.length; mG /= bgSamples.length; mB /= bgSamples.length;
    let vSum = 0;
    for (const p of bgSamples)
      vSum += (p.r - mR) ** 2 + (p.g - mG) ** 2 + (p.b - mB) ** 2;
    const bgStdDev = Math.sqrt(vSum / (3 * bgSamples.length));

    // Plain surface (stdDev < 22): background estimate is near pixel-perfect so
    // we can confidently detect even subtle sparkle edges (low threshold).
    // Textured/gradient (stdDev ≥ 22): background estimate has natural variation
    // so we need a higher threshold to avoid flagging real texture as sparkle.
    const isPlain = bgStdDev < 22;
    const THRESH   = isPlain ? 14 : 30;  // plain: catch faint edges; textured: avoid false positives
    const SOFT_MIN = isPlain ?  6 : 10;  // feather zone scales with threshold

    // ── Phase 2: fill mask ────────────────────────────────────────────────────
    const fillMask = new Uint8Array(bw * bh);
    for (let pi = 0; pi < bw * bh; pi++) if (aScore[pi] >= THRESH) fillMask[pi] = 1;

    // Fast lookup: is (r,c) an unfilled sparkle pixel?
    const isFill = (r, c) =>
      r >= y && r < y + bh && c >= x && c < x + bw &&
      fillMask[(r - y) * bw + (c - x)] === 1;

    // ── Phase 3: Fill — plain surface uses IDW, textured uses PatchMatch ─────
    const filledR = new Float32Array(bw * bh);
    const filledG = new Float32Array(bw * bh);
    const filledB = new Float32Array(bw * bh);

    // Seed with original pixels (non-fill pixels used by Phase 4 Gauss-Seidel)
    for (let row = y; row < Math.min(H, y + bh); row++) {
      for (let col = x; col < Math.min(W, x + bw); col++) {
        const pi = (row - y) * bw + (col - x);
        const ci = (row * W + col) * 4;
        filledR[pi] = data[ci]; filledG[pi] = data[ci+1]; filledB[pi] = data[ci+2];
      }
    }

    if (isPlain) {
      // Plain / solid-colour surface: IDW background estimate is pixel-perfect.
      // PatchMatch would pull micro-texture from unrelated image regions.
      for (let pi = 0; pi < bw * bh; pi++) {
        if (!fillMask[pi]) continue;
        filledR[pi] = bgEst[pi * 3];
        filledG[pi] = bgEst[pi * 3 + 1];
        filledB[pi] = bgEst[pi * 3 + 2];
      }
    } else {
      // Gradient / textured surface: True PatchMatch (Barnes et al. 2009).
      // Searches the entire image via random init + propagation + random search.
      const PATCH_R  = 5;
      const PM_ITERS = 5;

      function patchSSD(row, col, sr, sc) {
        let ssd = 0, cnt = 0;
        for (let py = -PATCH_R; py <= PATCH_R; py++) {
          const ny = row + py, ry = sr + py;
          if (ny < 0 || ny >= H || ry < 0 || ry >= H) continue;
          for (let px = -PATCH_R; px <= PATCH_R; px++) {
            const nx = col + px, rx = sc + px;
            if (nx < 0 || nx >= W || rx < 0 || rx >= W) continue;
            if (isFill(ny, nx)) continue;
            if (isFill(ry, rx)) continue;
            const ni = (ny * W + nx) * 4, ri = (ry * W + rx) * 4;
            const dr = data[ni]-data[ri], dg = data[ni+1]-data[ri+1], db = data[ni+2]-data[ri+2];
            ssd += dr*dr + dg*dg + db*db; cnt++;
          }
        }
        return cnt >= 6 ? ssd / cnt : Infinity;
      }

      const offR  = new Int16Array(bw * bh);
      const offC  = new Int16Array(bw * bh);
      const pmErr = new Float32Array(bw * bh).fill(Infinity);

      // Local-first random init (100px radius), global fallback
      for (let row = y; row < Math.min(H, y + bh); row++) {
        for (let col = x; col < Math.min(W, x + bw); col++) {
          const pi = (row - y) * bw + (col - x);
          if (!fillMask[pi]) continue;
          let sr, sc, tries = 0;
          do {
            if (tries < 50) {
              sr = Math.max(0, Math.min(H-1, row + (((Math.random()*2-1)*100)|0)));
              sc = Math.max(0, Math.min(W-1, col + (((Math.random()*2-1)*100)|0)));
            } else { sr = (Math.random()*H)|0; sc = (Math.random()*W)|0; }
          } while (isFill(sr, sc) && ++tries < 80);
          offR[pi] = sr - row; offC[pi] = sc - col;
          pmErr[pi] = patchSSD(row, col, sr, sc);
        }
      }

      function tryAt(pi, row, col, sr, sc) {
        if (sr < 0 || sr >= H || sc < 0 || sc >= W || isFill(sr, sc)) return;
        const si = (sr * W + sc) * 4;
        const colorDev = (Math.abs(data[si]  -bgEst[pi*3  ]) +
                          Math.abs(data[si+1]-bgEst[pi*3+1]) +
                          Math.abs(data[si+2]-bgEst[pi*3+2])) / 3;
        if (colorDev > 35) return;
        const e = patchSSD(row, col, sr, sc);
        if (e < pmErr[pi]) { pmErr[pi] = e; offR[pi] = sr-row; offC[pi] = sc-col; }
      }

      const MAXR = Math.max(W, H);
      for (let iter = 0; iter < PM_ITERS; iter++) {
        for (let row = y; row < Math.min(H, y+bh); row++) {
          for (let col = x; col < Math.min(W, x+bw); col++) {
            const pi = (row-y)*bw+(col-x);
            if (!fillMask[pi]) continue;
            if (col > x     && fillMask[pi-1 ]) tryAt(pi,row,col,row+offR[pi-1], col+offC[pi-1]);
            if (row > y     && fillMask[pi-bw]) tryAt(pi,row,col,row+offR[pi-bw],col+offC[pi-bw]);
            for (let r=MAXR; r>=1; r=(r/2)|0)
              tryAt(pi,row,col,Math.round(row+offR[pi]+(Math.random()*2-1)*r),
                               Math.round(col+offC[pi]+(Math.random()*2-1)*r));
          }
        }
        for (let row = Math.min(H,y+bh)-1; row >= y; row--) {
          for (let col = Math.min(W,x+bw)-1; col >= x; col--) {
            const pi = (row-y)*bw+(col-x);
            if (!fillMask[pi]) continue;
            if (col < x+bw-1 && fillMask[pi+1 ]) tryAt(pi,row,col,row+offR[pi+1], col+offC[pi+1]);
            if (row < y+bh-1 && fillMask[pi+bw]) tryAt(pi,row,col,row+offR[pi+bw],col+offC[pi+bw]);
            for (let r=MAXR; r>=1; r=(r/2)|0)
              tryAt(pi,row,col,Math.round(row+offR[pi]+(Math.random()*2-1)*r),
                               Math.round(col+offC[pi]+(Math.random()*2-1)*r));
          }
        }
      }

      // Write PatchMatch result into filled buffer
      for (let row = y; row < Math.min(H, y+bh); row++) {
        for (let col = x; col < Math.min(W, x+bw); col++) {
          const pi = (row-y)*bw+(col-x);
          if (!fillMask[pi]) continue;
          const sr = row+offR[pi], sc = col+offC[pi];
          if (sr >= 0 && sr < H && sc >= 0 && sc < W) {
            const si = (sr*W+sc)*4;
            filledR[pi]=data[si]; filledG[pi]=data[si+1]; filledB[pi]=data[si+2];
          } else {
            filledR[pi]=bgEst[pi*3]; filledG[pi]=bgEst[pi*3+1]; filledB[pi]=bgEst[pi*3+2];
          }
        }
      }
    } // end !isPlain

    // ── Phase 4: Boundary Gauss-Seidel (seam elimination) ────────────────────
    // Only smooth pixels on the fill boundary (adjacent to at least one non-fill
    // pixel). Interior fill pixels are left untouched — their PatchMatch texture
    // is perfect and must not be blurred. The boundary pixels blend toward their
    // surrounding neighbour average, eliminating any colour discontinuity seam.
    const GS_ITERS = 50;
    for (let iter = 0; iter < GS_ITERS; iter++) {
      for (let row = y; row < Math.min(H, y + bh); row++) {
        for (let col = x; col < Math.min(W, x + bw); col++) {
          const pi = (row - y) * bw + (col - x);
          if (!fillMask[pi]) continue;

          let sumR = 0, sumG = 0, sumB = 0, cnt = 0, onBoundary = false;
          // 4-connected neighbours
          const NR = [row-1, row+1, row,   row  ];
          const NC = [col,   col,   col-1, col+1];
          for (let k = 0; k < 4; k++) {
            const nr = NR[k], nc = NC[k];
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) { onBoundary = true; continue; }
            if (nr >= y && nr < y+bh && nc >= x && nc < x+bw) {
              const npi = (nr-y)*bw + (nc-x);
              if (!fillMask[npi]) onBoundary = true;
              sumR += filledR[npi]; sumG += filledG[npi]; sumB += filledB[npi];
            } else {
              onBoundary = true;
              const ci2 = (nr*W+nc)*4;
              sumR += data[ci2]; sumG += data[ci2+1]; sumB += data[ci2+2];
            }
            cnt++;
          }
          if (!onBoundary || cnt === 0) continue;

          // 45% blend toward neighbour average per iteration → converges in ~20 iters
          filledR[pi] += 0.45 * (sumR / cnt - filledR[pi]);
          filledG[pi] += 0.45 * (sumG / cnt - filledG[pi]);
          filledB[pi] += 0.45 * (sumB / cnt - filledB[pi]);
        }
      }
    }

    // ── Phase 5: write back — soft alpha at feather zone ─────────────────────
    for (let row = y; row < Math.min(H, y + bh); row++) {
      for (let col = x; col < Math.min(W, x + bw); col++) {
        const pi  = (row - y) * bw + (col - x);
        const sc  = aScore[pi];
        if (sc < SOFT_MIN) continue;
        const alpha = Math.min(1, (sc - SOFT_MIN) / (THRESH - SOFT_MIN));
        const ci = (row * W + col) * 4;
        data[ci]     = clamp(data[ci]     * (1 - alpha) + filledR[pi] * alpha);
        data[ci + 1] = clamp(data[ci + 1] * (1 - alpha) + filledG[pi] * alpha);
        data[ci + 2] = clamp(data[ci + 2] * (1 - alpha) + filledB[pi] * alpha);
        data[ci + 3] = 255;
      }
    }
  }

  // ── Manual Scan API ────────────────────────────────────────────────────────
  window.__UAI_scanImages = function () {
    const seen = new Set();
    const results = [];

    document.querySelectorAll('img[src]').forEach(img => {
      const { src, naturalWidth: w, naturalHeight: h } = img;
      if (w < 256 || h < 256) return;
      if (seen.has(src)) return;

      let parsedPathname = '';
      try { parsedPathname = new URL(src, location.href).pathname; } catch {}

      const isGeminiSource =
        src.startsWith('blob:') ||
        src.includes('googleusercontent.com') ||
        src.includes('generativelanguage.googleapis.com') ||
        src.includes('storage.googleapis.com') ||
        src.includes('generatedimage') ||
        /\.(png|jpe?g|webp)(\?|$)/i.test(parsedPathname);

      if (!isGeminiSource) return;

      seen.add(src);
      results.push({ src, width: w, height: h, alt: img.alt || '' });
    });

    return results.slice(0, 24);
  };

  // ── Batch download all found images ──────────────────────────────
  window.__UAI_downloadAll = async function () {
    const images = window.__UAI_scanImages();
    if (!images.length) return { ok: false, error: 'No images found on page' };

    let succeeded = 0;
    let failed = 0;
    let cancelled = false;
    const errors = [];

    // Single progress card that updates per image (Pro mode only). One
    // AbortController governs the whole batch — cancelling aborts the
    // in-flight image's inference AND skips the rest.
    const usePro = (cfg.method === 'ai');
    const abortCtrl = usePro ? new AbortController() : null;
    const card = usePro
      ? showProgressCard({
          totalImages: images.length,
          currentIndex: 1,
          onCancel: abortCtrl ? () => { cancelled = true; abortCtrl.abort(); } : null,
        })
      : null;

    for (let i = 0; i < images.length; i++) {
      if (cancelled) break;
      const img = images[i];
      const filename = `unmark-ai-${i + 1}-of-${images.length}.png`;
      if (card) card.setBatch(i + 1, images.length);
      try {
        const rawBlob   = await fetchImage(img.src, blobCache.get(img.src));
        const cleanBlob = await processImage(rawBlob, abortCtrl?.signal);

        // blob URL transport (was: dataUrl base64)
        await downloadBlobViaBackground(cleanBlob, filename);

        await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});

        // Stagger downloads so browser doesn't throttle
        await new Promise(r => setTimeout(r, 400));
        succeeded++;
      } catch (e) {
        if (e.cancelled) { cancelled = true; break; }
        failed++;
        errors.push(e.message);
        log('downloadAll — image', i + 1, 'failed:', e.message);
      }
    }

    if (card) {
      if (cancelled) {
        card.cancelled(
          succeeded > 0
            ? `Stopped after ${succeeded} of ${images.length}`
            : 'You cancelled the batch'
        );
      } else if (succeeded === images.length) {
        card.success(`${succeeded} of ${images.length} cleaned`);
      } else if (succeeded > 0) {
        card.success(`${succeeded} of ${images.length} cleaned · ${failed} failed`);
      } else {
        card.error('All cleans failed');
      }
    }

    return { ok: succeeded > 0, succeeded, failed, cancelled, total: images.length, errors };
  };

  window.__UAI_processAndDownload = async function (url, filename) {
    // progress card for Pro mode (popup grid Clean button + context menu)
    const usePro = (cfg.method === 'ai');
    const abortCtrl = usePro ? new AbortController() : null;
    const card = usePro
      ? showProgressCard({ onCancel: abortCtrl ? () => abortCtrl.abort() : null })
      : null;
    try {
      const rawBlob   = await fetchImage(url, blobCache.get(url), null);
      const cleanBlob = await processImage(rawBlob, abortCtrl?.signal);

      // blob URL transport (was: dataUrl base64)
      await downloadBlobViaBackground(cleanBlob, filename);

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      // register original for "View original" link
      const originalId = registerOriginal(rawBlob, filename);
      // and a downscaled cleaned preview for the Compare modal
      cacheCleanedPreview(originalId, cleanBlob);
      if (card) card.success('Watermark removed · Saved', { originalId });
      return { ok: true, originalId };
    } catch (e) {
      if (e.cancelled) {
        log('processAndDownload cancelled by user');
        if (card) card.cancelled('You cancelled this clean');
        return { ok: false, cancelled: true };
      }
      log('processAndDownload error:', e.message);
      if (card) card.error(e.message || 'Processing failed');
      return { ok: false, error: e.message };
    }
  };

  // callable from popup via chrome.scripting.executeScript so the
  // popup grid can offer "View original" too.
  window.__UAI_downloadOriginal = async function (id) {
    return downloadOriginal(id);
  };

  // Return downscaled before/after previews as JPEG data URLs so the popup
  // can drive a comparison slider. Both images are downscaled to max 800px
  // so the IPC payload stays well under typical sendMessage limits. Returns
  // null if either side is missing (cache expired / different id / etc).
  window.__UAI_getPreviewPair = async function (id) {
    const orig  = originalsCache.get(id);
    const clean = cleanedCache.get(id);
    if (!orig || !clean) return null;
    try {
      // cleanedCache already holds a downscaled JPEG. Downscale original
      // lazily; at full res a 4 MB PNG as a data URL is ~5.5 MB of IPC.
      const origPreview = await downscaleToJpeg(orig.blob, 800, 0.88);
      const [origUrl, cleanUrl] = await Promise.all([
        blobToDataURL(origPreview),
        blobToDataURL(clean.blob),
      ]);
      return { original: origUrl, cleaned: cleanUrl };
    } catch (e) {
      log('getPreviewPair failed:', e.message);
      return null;
    }
  };

  // Keep old names as aliases so background.js fallback still works if page not refreshed
  window.__GWR_processAndDownload = window.__UAI_processAndDownload;
  window.__GWR_scanImages         = window.__UAI_scanImages;

  // ── Utilities ──────────────────────────────────────────────────────────────
  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
  function clamp(v)      { return Math.max(0, Math.min(255, Math.round(v))); }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const reader   = new FileReader();
      reader.onload  = () => res(reader.result);
      reader.onerror = () => rej(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  function normalizeFilename(name) {
    if (!name) return 'unmark-ai-clean.png';
    const base = name.replace(/\.(png|jpe?g|jpg|webp|gif|bmp|avif)$/i, '');
    return base + '.png';
  }

  // ── Progress Card ─────────────────────────────────────────────────
  //
  // Persistent in-page progress card for long Pro-mode operations. Lives inside
  // the Gemini tab itself (not the action popup), so it stays visible even when
  // the popup isn't open — which is the common case for auto-clean.
  //
  // Why not auto-open the action popup?
  //   Chrome's chrome.action.openPopup() is restricted to user gestures and
  //   can't be reliably triggered from background work. And no API exists to
  //   prevent the user from closing the action popup.
  // Why not a separate window?
  //   chrome.windows.create('popup') works but the user can always close it,
  //   pulls focus from the workspace, and feels disruptive.
  //
  // The in-page card cannot be accidentally dismissed (pointer-events: none),
  // sits in the bottom-right above any toast, and auto-fades on completion.

  let activeProgressCard = null;

  function showProgressCard({ totalImages = 1, currentIndex = 1, onCancel = null } = {}) {
    // Replace any existing card (e.g. user triggered a second clean before
    // the first one's success animation finished)
    if (activeProgressCard) {
      activeProgressCard.kill();
      activeProgressCard = null;
    }

    // Inject keyframes once
    if (!document.getElementById('uai-pc-styles')) {
      const style = document.createElement('style');
      style.id = 'uai-pc-styles';
      style.textContent = `
        @keyframes uai-pc-spin { to { transform: rotate(360deg); } }
        @keyframes uai-pc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        @keyframes uai-pc-pop { 0% { transform: scale(.6); } 60% { transform: scale(1.15); } 100% { transform: scale(1); } }
      `;
      document.head.appendChild(style);
    }

    const card = document.createElement('div');
    card.id = 'uai-progress-card';
    Object.assign(card.style, {
      position:        'fixed',
      bottom:          '24px',
      right:           '24px',
      width:           '270px',
      background:      'rgba(19, 19, 22, 0.96)',
      backdropFilter:  'blur(10px) saturate(140%)',
      WebkitBackdropFilter: 'blur(10px) saturate(140%)',
      color:           '#FAFAFA',
      fontFamily:      '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
      fontSize:        '13px',
      lineHeight:      '1.4',
      padding:         '13px 14px',
      borderRadius:    '12px',
      border:          '1px solid rgba(20, 184, 166, 0.35)',
      boxShadow:       '0 12px 36px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.3)',
      zIndex:          '2147483646',
      transition:      'opacity 280ms ease, transform 280ms cubic-bezier(.4,0,.2,1), border-color 220ms ease',
      opacity:         '0',
      transform:       'translateY(12px) scale(0.98)',
      pointerEvents:   'none',  // can't be clicked / dismissed by the user
      WebkitFontSmoothing: 'antialiased',
    });

    const subtitle = totalImages > 1
      ? `UnmarkAI · Pro · ${currentIndex} of ${totalImages}`
      : 'UnmarkAI · Pro';

    card.innerHTML = `
      <div data-head style="display:flex;align-items:center;gap:9px;margin-bottom:10px;">
        <div data-icon style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.12);
                              border-top-color:#2DD4BF;border-radius:50%;
                              animation:uai-pc-spin 700ms linear infinite;flex-shrink:0;"></div>
        <span data-title style="font-size:10.5px;font-weight:600;letter-spacing:.04em;
                                 color:#A1A1AA;text-transform:uppercase;">${subtitle}</span>
      </div>
      <div data-phase style="font-size:13px;font-weight:500;color:#FAFAFA;
                              letter-spacing:-.005em;margin-bottom:3px;">Starting…</div>
      <div data-timer style="font-size:11px;font-family:ui-monospace,'SF Mono',Menlo,Monaco,monospace;
                              color:#71717A;font-variant-numeric:tabular-nums;
                              letter-spacing:.02em;">0s</div>
    `;

    document.body.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0) scale(1)';
    });

    const phaseEl = card.querySelector('[data-phase]');
    const timerEl = card.querySelector('[data-timer]');
    const headEl  = card.querySelector('[data-head]');
    const startTime = Date.now();

    // Phase timeline tuned for Pro (single-thread WASM LaMa on 512×512)
    const phases = [
      { until:  3, label: 'Detecting watermark'   },
      { until:  6, label: 'Preparing image'       },
      { until: 12, label: 'Loading AI engine'     },
      { until: 35, label: 'Removing watermark'    },
      { until: 60, label: 'Almost done'           },
      { until: Infinity, label: 'Finishing up'    },
    ];

    const tickFn = () => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const phase = phases.find(p => sec < p.until);
      if (phaseEl.textContent !== phase.label + '…') {
        phaseEl.textContent = phase.label + '…';
      }
      timerEl.textContent = sec >= 1 ? `${sec}s` : '0s';
    };
    tickFn();
    let tickInterval = setInterval(tickFn, 500);

    // Optional Cancel button — appears only when the caller supplied an
    // onCancel callback (i.e. they have an AbortController to trigger).
    // Pointer-events are 'none' on the card root; we re-enable them for
    // this button only so the card stays non-dismissable otherwise.
    let cancelBtn = null;
    if (typeof onCancel === 'function') {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      Object.assign(cancelBtn.style, {
        display:        'block',
        marginTop:      '10px',
        padding:        '5px 10px',
        background:     'rgba(239, 68, 68, 0.10)',
        border:         '1px solid rgba(239, 68, 68, 0.25)',
        borderRadius:   '6px',
        color:          '#EF4444',
        fontSize:       '11px',
        fontWeight:     '500',
        fontFamily:     'inherit',
        cursor:         'pointer',
        pointerEvents:  'auto',
        transition:     'background 160ms ease',
        letterSpacing:  '-.005em',
      });
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('mouseenter', () => {
        cancelBtn.style.background = 'rgba(239, 68, 68, 0.18)';
      });
      cancelBtn.addEventListener('mouseleave', () => {
        cancelBtn.style.background = 'rgba(239, 68, 68, 0.10)';
      });
      cancelBtn.addEventListener('click', () => {
        if (cancelBtn.disabled) return;
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling…';
        cancelBtn.style.opacity = '0.6';
        try { onCancel(); } catch {}
      });
      card.appendChild(cancelBtn);
    }

    function fadeAndRemove(delay = 0) {
      setTimeout(() => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(8px) scale(0.98)';
        setTimeout(() => { try { card.remove(); } catch {} }, 350);
      }, delay);
    }

    const controller = {
      // Hard kill (no animation) — used when replacing
      kill() {
        clearInterval(tickInterval);
        try { card.remove(); } catch {}
      },

      // Update phase manually (e.g., for batch progress)
      setPhase(label) {
        if (phaseEl) phaseEl.textContent = label;
      },

      setBatch(currentIndex, totalImages) {
        const titleEl = card.querySelector('[data-title]');
        if (titleEl) {
          titleEl.textContent = totalImages > 1
            ? `UnmarkAI · Pro · ${currentIndex} of ${totalImages}`
            : 'UnmarkAI · Pro';
        }
      },

      // User-triggered abort reached a terminal state. Neutral amber theme
      // (not error red) so the user doesn't think something broke.
      cancelled(msg = 'Cancelled') {
        clearInterval(tickInterval);
        if (cancelBtn) cancelBtn.remove();
        card.style.borderColor = 'rgba(245, 158, 11, 0.5)';
        headEl.innerHTML = `
          <div style="width:14px;height:14px;display:grid;place-items:center;
                      background:#F59E0B;border-radius:50%;color:#fff;
                      font-size:10px;font-weight:700;line-height:1;">↺</div>
          <span style="font-size:10.5px;font-weight:600;letter-spacing:.04em;
                       color:#F59E0B;text-transform:uppercase;">UnmarkAI · Cancelled</span>
        `;
        phaseEl.textContent = msg;
        timerEl.textContent = '';
        fadeAndRemove(2200);
        if (activeProgressCard === controller) activeProgressCard = null;
      },

      success(msg = 'Watermark removed', { originalId = null } = {}) {
        clearInterval(tickInterval);
        if (cancelBtn) cancelBtn.remove();
        const sec = Math.floor((Date.now() - startTime) / 1000);
        card.style.borderColor = 'rgba(16, 185, 129, 0.5)';
        headEl.innerHTML = `
          <div style="width:14px;height:14px;display:grid;place-items:center;
                      background:#10B981;border-radius:50%;color:#fff;
                      font-size:10px;font-weight:700;line-height:1;
                      animation:uai-pc-pop 320ms cubic-bezier(.4,0,.2,1);">✓</div>
          <span style="font-size:10.5px;font-weight:600;letter-spacing:.04em;
                       color:#10B981;text-transform:uppercase;">UnmarkAI · Done</span>
        `;
        phaseEl.textContent = msg;
        timerEl.textContent = `Completed in ${sec}s`;

        // optional "Download original" link if the caller cached the
        // unprocessed image. Extends the card's lifetime so the user has time
        // to read + click. Pointer-events re-enabled on the link itself only.
        if (originalId) {
          const link = document.createElement('button');
          link.type = 'button';
          Object.assign(link.style, {
            display:        'inline-block',
            marginTop:      '8px',
            padding:        '5px 10px',
            background:     'rgba(255,255,255,0.06)',
            border:         '1px solid rgba(255,255,255,0.10)',
            borderRadius:   '6px',
            color:          '#A1A1AA',
            fontSize:       '11px',
            fontWeight:     '500',
            fontFamily:     'inherit',
            cursor:         'pointer',
            pointerEvents:  'auto',  // re-enable for the link only
            transition:     'background 160ms ease, color 160ms ease, border-color 160ms ease',
            letterSpacing:  '-.005em',
          });
          link.textContent = 'Download original';
          link.addEventListener('mouseenter', () => {
            link.style.background = 'rgba(255,255,255,0.10)';
            link.style.color = '#FAFAFA';
            link.style.borderColor = 'rgba(255,255,255,0.18)';
          });
          link.addEventListener('mouseleave', () => {
            link.style.background = 'rgba(255,255,255,0.06)';
            link.style.color = '#A1A1AA';
            link.style.borderColor = 'rgba(255,255,255,0.10)';
          });
          link.addEventListener('click', async (e) => {
            e.stopPropagation();
            link.disabled = true;
            link.style.opacity = '0.55';
            link.textContent = 'Saving original…';
            await downloadOriginal(originalId);
            link.textContent = 'Original saved';
            // Card fades shortly after
            fadeAndRemove(800);
          });
          card.appendChild(link);
          fadeAndRemove(8000);  // longer window so user can click
        } else {
          fadeAndRemove(1800);
        }

        if (activeProgressCard === controller) activeProgressCard = null;
      },

      error(msg = 'Something went wrong') {
        clearInterval(tickInterval);
        if (cancelBtn) cancelBtn.remove();
        card.style.borderColor = 'rgba(239, 68, 68, 0.5)';
        headEl.innerHTML = `
          <div style="width:14px;height:14px;display:grid;place-items:center;
                      background:#EF4444;border-radius:50%;color:#fff;
                      font-size:10px;font-weight:700;line-height:1;">!</div>
          <span style="font-size:10.5px;font-weight:600;letter-spacing:.04em;
                       color:#EF4444;text-transform:uppercase;">UnmarkAI · Failed</span>
        `;
        phaseEl.textContent = msg.length > 64 ? msg.slice(0, 61) + '…' : msg;
        timerEl.textContent = '';
        fadeAndRemove(4500);
        if (activeProgressCard === controller) activeProgressCard = null;
      },
    };

    activeProgressCard = controller;
    return controller;
  }

  // ── Toast Notifications ────────────────────────────────────────────────────
  let toastTimer = null;

  function toast(msg, type = 'info') {
    let el = document.getElementById('uai-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'uai-toast';
      Object.assign(el.style, {
        position:      'fixed',
        bottom:        '24px',
        right:         '24px',
        padding:       '11px 18px',
        borderRadius:  '10px',
        font:          '500 13px/1.4 "Google Sans",Roboto,sans-serif',
        zIndex:        '2147483647',
        pointerEvents: 'none',
        transition:    'opacity .3s, transform .3s, bottom .25s ease',
        boxShadow:     '0 4px 20px rgba(0,0,0,.35)',
        color:         '#fff',
        maxWidth:      '300px',
        opacity:       '0',
        transform:     'translateY(10px)',
      });
      document.body.appendChild(el);
    }

    // Stack above the progress card if one is showing, otherwise sit at 24px.
    // Gives: [ toast ] ← 12px gap → [ card ] ← 24px → window bottom.
    const card = document.getElementById('uai-progress-card');
    if (card && document.body.contains(card)) {
      const h = card.getBoundingClientRect().height;
      el.style.bottom = `${24 + h + 12}px`;
    } else {
      el.style.bottom = '24px';
    }

    const COLORS = { info: '#6366F1', success: '#059669', error: '#DC2626' };
    const ICONS  = { info: '✦', success: '✓', error: '⚠' };

    el.style.background = COLORS[type] || COLORS.info;
    el.style.opacity    = '1';
    el.style.transform  = 'translateY(0)';
    el.textContent      = `${ICONS[type] || ''} ${msg}`;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity   = '0';
      el.style.transform = 'translateY(10px)';
    }, type === 'error' ? 5500 : 4000); // errors stay a bit longer
  }

  function log(...args) {
    console.log('%c' + TAG, 'color:#38bdf8;font-weight:700', ...args);
  }

})();