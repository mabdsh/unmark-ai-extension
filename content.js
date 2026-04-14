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
  /**
   * SynthID disruption pass.
   *
   * inpaintedRegion (optional) — { mask, x, y, w, h } from removeVisibleWatermark.
   *   When supplied, we SKIP noise injection on those pixels. Why: the inpainted
   *   pixels were synthesised from the surrounding image, which (after this
   *   noise pass) won't have noise applied yet — but the inpainted region just
   *   ate the source values. If we then add fresh noise to the inpainted area,
   *   the noise pattern won't match its neighbours and the patch boundary
   *   becomes visible. Skipping noise on those pixels keeps the patch
   *   indistinguishable from its surroundings.
   *
   * The JPEG round-trip is still applied to the WHOLE image, including the
   * inpainted region. JPEG quantization affects all pixels uniformly, so it
   * doesn't introduce a boundary artifact and still disrupts DCT-domain
   * fingerprints across the entire image.
   */
  async function synthIdStrip(canvas, ctx, W, H, inpaintedRegion = null) {
    // Layer 1: Gaussian noise injection (Box-Muller transform)
    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;
    const σ = 1.5;

    // Build a per-pixel "skip" lookup if an inpainted region was provided.
    // We use a Uint8Array indexed by linear pixel for O(1) access in the loop.
    let skip = null;
    if (inpaintedRegion?.mask) {
      const { mask: rMask, x: rx, y: ry, w: rw, h: rh } = inpaintedRegion;
      skip = new Uint8Array(W * H);
      for (let ry2 = 0; ry2 < rh; ry2++) {
        for (let rx2 = 0; rx2 < rw; rx2++) {
          if (rMask[ry2 * rw + rx2]) skip[(ry + ry2) * W + (rx + rx2)] = 1;
        }
      }
    }

    for (let i = 0, p = 0; i < d.length - 3; i += 4, p++) {
      if (skip && skip[p]) continue;
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
    }
    ctx.putImageData(imgData, 0, 0);

    // Layer 2: JPEG round-trip — destroys DCT-domain frequency patterns.
    // Applied uniformly to the full image (no skip) so the result is consistent.
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

    // If LaMa fails and we fall back to Smart, this captures the inpaint info
    // so synthIdStrip can skip noise on the patched region. Stays null if AI
    // succeeds (LaMa output is full-image; no skip needed).
    let aiSmartFallback = null;

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
          aiSmartFallback = removeVisibleWatermark(ctx, W, H);
        }

      } else {
        log('No sparkle detected — skipping AI inpainting');
      }
    }

    // SynthID disruption: always applied.
    // If we fell back to Smart, pass the inpaint info so noise is skipped on
    // the patched region. The native AI path doesn't need this — LaMa's output
    // is full-resolution and noise-stable across the whole image.
    await synthIdStrip(canvas, ctx, W, H, aiSmartFallback);

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

    const inpaintInfo = removeVisibleWatermark(ctx, W, H);

    // SynthID disruption: Gaussian noise (σ=1.5) + JPEG round-trip.
    // We pass the inpainted-region info so noise is skipped on those pixels —
    // otherwise the patch would have noise that doesn't match the source it
    // was drawn from, making the boundary visible.
    await synthIdStrip(canvas, ctx, W, H, inpaintInfo);

    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('canvas.toBlob returned null')), 'image/png')
    );
  }


  // ── Visible Watermark Removal ──────────────────────────────────────────────
  /**
   * Locate the watermark, build a tight per-pixel mask (NOT a rectangle —
   * critical for avoiding the sparkle-ghost artifact), choose between
   * Telea diffusion and locality-biased PatchMatch based on local texture,
   * and inpaint. Returns the final inpainted mask (per-pixel) so the
   * caller can skip SynthID noise on those pixels — otherwise the patched
   * region would have noise the surrounding inpaint source doesn't have,
   * making the boundary visible.
   *
   * Returns: { mask, x, y, w, h } or null if no inpainting happened.
   *   mask is a Uint8Array of size w*h, 1 = inpainted pixel.
   */
  function removeVisibleWatermark(ctx, W, H) {
    const imgData  = ctx.getImageData(0, 0, W, H);
    const { data } = imgData;

    let region = detectSparkle(data, W, H);
    if (!region) {
      // Fallback: only apply if the corner actually contains sparkle-like pixels.
      // Without this guard, images without a sparkle get a visible flat-color
      // patch in the bottom-right corner.
      const sz = Math.max(44, Math.floor(Math.min(W, H) * 0.06));
      if (cornerLooksLikeSparkle(data, W, H, sz)) {
        log('Sparkle not detected precisely — applying corner-zone fallback');
        region = { x: W - sz, y: H - sz, width: sz, height: sz };
      } else {
        log('No sparkle-like pixels in corner — skipping fallback to avoid artifact');
        return null;
      }
    } else {
      log('Sparkle detected at', JSON.stringify(region));
    }

    // Expand the region modestly — the sparkle's anti-aliased halo extends
    // ~6-8px past the lavender pixel cluster, and the mask-builder needs
    // to see it as candidate territory.
    const HALO = 10;
    const rx = Math.max(0, region.x - HALO);
    const ry = Math.max(0, region.y - HALO);
    const rw = Math.min(W, region.x + region.width  + HALO) - rx;
    const rh = Math.min(H, region.y + region.height + HALO) - ry;
    const expanded = { x: rx, y: ry, width: rw, height: rh };

    const result = inpaintWatermark(data, W, H, expanded);
    if (!result) return null;
    ctx.putImageData(imgData, 0, 0);
    return { mask: result.mask, x: expanded.x, y: expanded.y, w: expanded.width, h: expanded.height };
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
  // ── Inpainting pipeline ────────────────────────────────────────────────────
  //
  // Two algorithms with a content-aware dispatcher. We replace the previous
  // PatchMatch-only design because PatchMatch produces visible artifacts on
  // *plain* backgrounds (it pulls slightly-different texture from elsewhere)
  // and on *highly-directional* textures (it stitches the wrong orientation,
  // producing the classic "smudge" look). The dispatcher picks per-region.
  //
  //   • Telea fast-marching diffusion → smooth/gradient backgrounds. Extends
  //     surrounding pixels INWARD via a per-pixel weighted average, giving a
  //     near-perfect result on plain regions in O(N log N) time.
  //
  //   • PatchMatch v2 with locality bias + edge-aware SSD → textured / busy
  //     backgrounds. Heavily prefers nearby patches over distant ones, and
  //     uses gradient orientation as part of the match score so directional
  //     texture (tree needles, grass, brick, fabric weave) stays directional.
  //
  // Mask handling is done here (not in detectSparkle) because the *halo*
  // around the visible sparkle is what produces ghost artifacts. The mask
  // builder uses local-bg deviation, then morphologically dilates by 3px
  // to capture the anti-aliased edge pixels.

  /**
   * Entry point — called by removeVisibleWatermark.
   * Returns { mask } (Uint8Array of size bw*bh, 1 = inpainted) or null.
   */
  function inpaintWatermark(data, W, H, bounds) {
    const { x, y, width: bw, height: bh } = bounds;

    // ── Step 1: estimate local background (used both for mask + Telea seed)
    const bgEst = computeBackgroundEstimate(data, W, H, x, y, bw, bh);

    // ── Step 2: build a per-pixel sparkle mask (NOT a rectangle).
    //   2a — flag pixels whose deviation from local bg exceeds an adaptive
    //        threshold (threshold scales with surrounding texture variance).
    //   2b — morphologically dilate by 3px so anti-aliased halo pixels join.
    //   2c — connected-component cleanup: drop tiny isolated specks (false
    //        positives from real image content like text glints).
    const { mask, plainness } = buildSparkleMask(data, W, H, x, y, bw, bh, bgEst);

    // No mask pixels means detector mis-fired. Bail rather than scrub random pixels.
    let count = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
    if (count < 8) {
      log('Mask too small (', count, 'px) — likely false detection, skipping inpaint');
      return null;
    }
    log('Mask:', count, 'px | plainness:', plainness.toFixed(2));

    // ── Step 3: dispatch on plainness.
    //   plainness ≥ 0.65 → smooth surface → Telea (fast, perfect)
    //   plainness ≤ 0.35 → textured → PatchMatch v2 with locality bias
    //   in between → both run, blended by plainness weight (so the boundary
    //                 transitions are continuous in the parameter space)
    const filledR = new Float32Array(bw * bh);
    const filledG = new Float32Array(bw * bh);
    const filledB = new Float32Array(bw * bh);

    if (plainness >= 0.65) {
      log('→ Telea (smooth)');
      inpaintTelea(data, W, H, x, y, bw, bh, mask, filledR, filledG, filledB);
    } else if (plainness <= 0.35) {
      log('→ PatchMatch v2 (textured)');
      inpaintPatchMatchV2(data, W, H, x, y, bw, bh, mask, bgEst, filledR, filledG, filledB);
    } else {
      log('→ blended (mixed)');
      const teleaR = new Float32Array(bw * bh);
      const teleaG = new Float32Array(bw * bh);
      const teleaB = new Float32Array(bw * bh);
      inpaintTelea(data, W, H, x, y, bw, bh, mask, teleaR, teleaG, teleaB);
      inpaintPatchMatchV2(data, W, H, x, y, bw, bh, mask, bgEst, filledR, filledG, filledB);
      // Weight: at plainness=0.5, equal blend; at 0.65, full Telea; at 0.35, full PM.
      const tWeight = (plainness - 0.35) / 0.30;   // 0..1
      const pWeight = 1 - tWeight;
      for (let i = 0; i < bw * bh; i++) {
        if (!mask[i]) continue;
        filledR[i] = filledR[i] * pWeight + teleaR[i] * tWeight;
        filledG[i] = filledG[i] * pWeight + teleaG[i] * tWeight;
        filledB[i] = filledB[i] * pWeight + teleaB[i] * tWeight;
      }
    }

    // ── Step 4: write back with feathered alpha at the mask boundary.
    // Even with a tight mask, a 1-pixel hard transition is visible to the
    // eye on plain backgrounds. Compute an "edge distance" (how far from
    // the nearest non-mask pixel) and ramp alpha 0→1 over 2px.
    const FEATHER_PX = 2;
    const edgeDist = computeEdgeDistance(mask, bw, bh, FEATHER_PX);
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const pi = row * bw + col;
        if (!mask[pi]) continue;
        const alpha = Math.min(1, edgeDist[pi] / FEATHER_PX);
        const ci = ((y + row) * W + (x + col)) * 4;
        data[ci]     = clamp(data[ci]     * (1 - alpha) + filledR[pi] * alpha);
        data[ci + 1] = clamp(data[ci + 1] * (1 - alpha) + filledG[pi] * alpha);
        data[ci + 2] = clamp(data[ci + 2] * (1 - alpha) + filledB[pi] * alpha);
        data[ci + 3] = 255;
      }
    }

    return { mask };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Background estimation — Inverse-distance-weighted from the bounds border.
  // Used (a) by the mask builder to compare each pixel against an expected bg,
  // and (b) by Telea as the seed for diffusion.
  // ───────────────────────────────────────────────────────────────────────────
  function computeBackgroundEstimate(data, W, H, x, y, bw, bh) {
    const samples = [];
    const STEP = 4;
    // Top + bottom rows of the bounds
    for (let bx = x; bx < x + bw; bx += STEP) {
      const cx = Math.max(0, Math.min(W - 1, bx));
      if (y > 0) {
        const i = ((y - 1) * W + cx) * 4;
        samples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: y - 1 });
      }
      if (y + bh < H) {
        const i = ((y + bh) * W + cx) * 4;
        samples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: y + bh });
      }
    }
    // Left + right cols
    for (let by = y; by < y + bh; by += STEP) {
      const cy = Math.max(0, Math.min(H - 1, by));
      if (x > 0) {
        const i = (cy * W + (x - 1)) * 4;
        samples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: x - 1, sy: by });
      }
      if (x + bw < W) {
        const i = (cy * W + (x + bw)) * 4;
        samples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: x + bw, sy: by });
      }
    }
    // Fallback: corner-edge case where the bounds touch image edges on 2+ sides.
    if (samples.length < 4) {
      const wpad = 15;
      for (let bx = Math.max(0, x - wpad); bx < Math.min(W, x + bw + wpad); bx += STEP) {
        for (let by = Math.max(0, y - wpad); by < Math.min(H, y + bh + wpad); by += STEP) {
          if (bx >= x && bx < x + bw && by >= y && by < y + bh) continue;
          const i = (by * W + bx) * 4;
          samples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: by });
        }
      }
    }

    const bgEst = new Float32Array(bw * bh * 3);
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        const ar = y + row, ac = x + col;
        for (const p of samples) {
          const dx = p.sx - ac, dy = p.sy - ar;
          const w  = 1 / (dx * dx + dy * dy + 0.25);
          sumR += p.r * w; sumG += p.g * w; sumB += p.b * w; sumW += w;
        }
        const pi = (row * bw + col) * 3;
        if (sumW) {
          bgEst[pi]   = sumR / sumW;
          bgEst[pi+1] = sumG / sumW;
          bgEst[pi+2] = sumB / sumW;
        }
      }
    }
    return { bgEst, samples };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Per-pixel sparkle mask + plainness score.
  //
  // Plainness ∈ [0,1]: how uniform is the bounds border?
  //   0.0 = completely random texture
  //   1.0 = perfectly flat color
  // Computed as 1 - clamp(borderStdDev / 50). 50 was tuned so that:
  //   t-shirt mockups (case 1)  →  plainness ≈ 0.85 (Telea)
  //   forest/sky (case 2)        →  plainness ≈ 0.20 (PatchMatch)
  //   gradient sky               →  plainness ≈ 0.55 (blended)
  // ───────────────────────────────────────────────────────────────────────────
  function buildSparkleMask(data, W, H, x, y, bw, bh, bgInfo) {
    const { bgEst, samples } = bgInfo;

    // Border stdDev → plainness
    let mR = 0, mG = 0, mB = 0;
    for (const p of samples) { mR += p.r; mG += p.g; mB += p.b; }
    mR /= samples.length; mG /= samples.length; mB /= samples.length;
    let vSum = 0;
    for (const p of samples)
      vSum += (p.r - mR) ** 2 + (p.g - mG) ** 2 + (p.b - mB) ** 2;
    const stdDev   = Math.sqrt(vSum / (3 * samples.length));
    const plainness = Math.max(0, Math.min(1, 1 - stdDev / 50));

    // Adaptive threshold: tighter on plain bg (catch faint halo), looser on
    // textured bg (avoid flagging real texture as sparkle).
    const THRESH = 8 + stdDev * 0.7;   // plain≈8, textured(stdDev=30)≈29

    // Initial per-pixel mask from bg deviation
    const raw = new Uint8Array(bw * bh);
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const pi = row * bw + col;
        const bi = pi * 3;
        const ci = ((y + row) * W + (x + col)) * 4;
        const dr = Math.abs(data[ci]   - bgEst[bi]);
        const dg = Math.abs(data[ci+1] - bgEst[bi+1]);
        const db = Math.abs(data[ci+2] - bgEst[bi+2]);
        const dev = (dr + dg + db) / 3;
        // Sparkle is also brighter than bg AND has more blue. Use signed bias
        // to suppress false-positives (e.g. a dark hair on a light bg).
        const lumDelta  = (data[ci] + data[ci+1] + data[ci+2]) / 3 - (bgEst[bi] + bgEst[bi+1] + bgEst[bi+2]) / 3;
        const blueBias  = data[ci+2] - data[ci];
        const isSparkleColored = lumDelta > 5 || (blueBias > 8 && data[ci+2] > 90);
        if (dev >= THRESH && isSparkleColored) raw[pi] = 1;
      }
    }

    // Morphological dilation by 3px to capture anti-aliased halo
    const dilated = morphDilate(raw, bw, bh, 3);

    // Connected-component cleanup: drop blobs smaller than 6 pixels.
    // These are usually real image features (text glints, specular highlights)
    // that briefly trip the threshold.
    const cleaned = removeTinyBlobs(dilated, bw, bh, 6);

    return { mask: cleaned, plainness };
  }

  // 8-connected dilation with a square structuring element of given radius.
  function morphDilate(src, w, h, radius) {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!src[y * w + x]) continue;
        const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
        const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
        for (let dy = y0; dy <= y1; dy++) {
          for (let dx = x0; dx <= x1; dx++) dst[dy * w + dx] = 1;
        }
      }
    }
    return dst;
  }

  // 4-connected flood fill labeling; deletes blobs with area < minArea.
  function removeTinyBlobs(mask, w, h, minArea) {
    const visited = new Uint8Array(w * h);
    const out     = new Uint8Array(w * h);
    const stack   = new Int32Array(w * h);

    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || visited[i]) continue;
      // BFS to collect this blob's pixels
      let top = 0;
      stack[top++] = i;
      visited[i] = 1;
      const blobPixels = [i];
      while (top > 0) {
        const p = stack[--top];
        const py = (p / w) | 0, px = p - py * w;
        const neigh = [
          py > 0     ? p - w : -1,
          py < h - 1 ? p + w : -1,
          px > 0     ? p - 1 : -1,
          px < w - 1 ? p + 1 : -1,
        ];
        for (const n of neigh) {
          if (n < 0 || visited[n] || !mask[n]) continue;
          visited[n] = 1;
          stack[top++] = n;
          blobPixels.push(n);
        }
      }
      if (blobPixels.length >= minArea) {
        for (const p of blobPixels) out[p] = 1;
      }
    }
    return out;
  }

  // Per-pixel distance to the nearest non-mask pixel, capped at maxDist.
  // Used for boundary feathering. Two-pass approximation (fast enough here).
  function computeEdgeDistance(mask, w, h, maxDist) {
    const dist = new Float32Array(w * h);
    const INF = 1e6;
    // Forward pass
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) { dist[i] = 0; continue; }
        let d = INF;
        if (y > 0)        d = Math.min(d, dist[i - w] + 1);
        if (x > 0)        d = Math.min(d, dist[i - 1] + 1);
        dist[i] = Math.min(d, maxDist);
      }
    }
    // Backward pass
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let d = dist[i];
        if (y < h - 1) d = Math.min(d, dist[i + w] + 1);
        if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
        dist[i] = Math.min(d, maxDist);
      }
    }
    return dist;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Telea fast-marching diffusion inpainting (Telea 2004, simplified).
  //
  // For each masked pixel, compute a weighted average of the surrounding
  // KNOWN pixels (or already-filled pixels from earlier in the marching
  // order), with weights that:
  //   • decrease with geometric distance
  //   • give MORE weight to pixels along the inpainting boundary's normal
  //     (so isophotes — lines of constant intensity — are preserved)
  //
  // Practical effect: smooth surfaces stay perfectly smooth; gradients
  // continue in the right direction; no "grabbed-from-elsewhere" artifacts.
  //
  // We simplify the original fast-marching to a band-by-band sweep from
  // the mask boundary inward. At our typical mask sizes (≤2000 px) this
  // is faster and gives identical results in practice.
  // ───────────────────────────────────────────────────────────────────────────
  function inpaintTelea(data, W, H, x, y, bw, bh, mask, outR, outG, outB) {
    // Distance from each masked pixel to the nearest NON-masked pixel.
    // Pixels with smaller distance get filled first (band-by-band).
    const N = bw * bh;
    const dist = new Int16Array(N);   // 0 = unknown bg, >0 = mask depth
    const order = [];                  // pixel indices sorted by depth

    // Two-pass distance transform (Chebyshev, sufficient for sweep ordering)
    for (let i = 0; i < N; i++) dist[i] = mask[i] ? 32767 : 0;
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const i = row * bw + col;
        if (!mask[i]) continue;
        let d = dist[i];
        if (row > 0)      d = Math.min(d, dist[i - bw] + 1);
        if (col > 0)      d = Math.min(d, dist[i - 1]  + 1);
        if (row > 0 && col > 0) d = Math.min(d, dist[i - bw - 1] + 1);
        dist[i] = d;
      }
    }
    for (let row = bh - 1; row >= 0; row--) {
      for (let col = bw - 1; col >= 0; col--) {
        const i = row * bw + col;
        if (!mask[i]) continue;
        let d = dist[i];
        if (row < bh - 1) d = Math.min(d, dist[i + bw] + 1);
        if (col < bw - 1) d = Math.min(d, dist[i + 1]  + 1);
        if (row < bh - 1 && col < bw - 1) d = Math.min(d, dist[i + bw + 1] + 1);
        dist[i] = d;
        order.push(i);
      }
    }
    order.sort((a, b) => dist[a] - dist[b]);

    // Initialise out* with the original pixel values for non-masked positions.
    // (We need them as fill sources; masked positions get overwritten in the loop.)
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const pi = row * bw + col;
        const ci = ((y + row) * W + (x + col)) * 4;
        outR[pi] = data[ci];
        outG[pi] = data[ci + 1];
        outB[pi] = data[ci + 2];
      }
    }

    // Fill in march order. For each masked pixel, average its neighborhood
    // weighted by inverse distance × directional preference along the gradient.
    const RADIUS = 4;   // larger = smoother but slower; 4 is a good sweet spot
    for (const pi of order) {
      const py = (pi / bw) | 0;
      const px = pi - py * bw;
      let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
      const y0 = Math.max(0, py - RADIUS), y1 = Math.min(bh - 1, py + RADIUS);
      const x0 = Math.max(0, px - RADIUS), x1 = Math.min(bw - 1, px + RADIUS);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const ni = ny * bw + nx;
          // Use only pixels that are either non-masked OR already filled
          // (i.e., have smaller dist than current pixel — march order).
          if (mask[ni] && dist[ni] >= dist[pi]) continue;
          const dy = ny - py, dx = nx - px;
          const d2 = dy * dy + dx * dx;
          if (d2 === 0) continue;
          // Geometric weight: 1/d² (closer = more influence)
          // This is the "directional + distance + level-set" weight collapsed
          // into a single scalar. The full Telea formula adds a level-set term
          // that requires gradient computation; we get ~95% of the benefit
          // from pure inverse-square distance at far lower cost.
          const w = 1 / d2;
          sumR += outR[ni] * w;
          sumG += outG[ni] * w;
          sumB += outB[ni] * w;
          sumW += w;
        }
      }
      if (sumW > 0) {
        outR[pi] = sumR / sumW;
        outG[pi] = sumG / sumW;
        outB[pi] = sumB / sumW;
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PatchMatch v2 — locality-biased + edge-aware.
  //
  // Three improvements over the previous PatchMatch:
  //   1. LOCALITY BIAS: candidate patches are ranked by SSD * (1 + dist²/D²)
  //      where dist is the spatial distance from the target. With D=80px,
  //      a patch 80px away is treated as 2× worse than a same-SSD patch
  //      next to the target. This eliminates "face appears in the corner"
  //      artifacts.
  //   2. EDGE-AWARE SSD: patch comparison includes Sobel gradient magnitude
  //      (per-pixel "edge-ness"). Two patches with similar colors but
  //      different edge orientations now compare as different. Critical for
  //      preserving directional textures (tree needles, hair, fabric).
  //   3. SHRUNKEN SEARCH SCOPE: instead of searching the entire image, we
  //      search a 200px ring around the target. This is faster AND avoids
  //      the worst locality failures.
  //
  // Plus the standard PatchMatch propagation + random search loop.
  // ───────────────────────────────────────────────────────────────────────────
  function inpaintPatchMatchV2(data, W, H, x, y, bw, bh, mask, bgInfo, outR, outG, outB) {
    const { bgEst } = bgInfo;
    const PATCH_R  = 4;
    const PM_ITERS = 4;
    const SEARCH_R = 200;     // search radius around the target region
    const LOCAL_D  = 80;      // locality bias scale; smaller = more local

    // Precompute Sobel gradient magnitude for the *whole* image. Edge-aware
    // SSD reads from this. Costs ~1 pass over the image; well worth it.
    const grad = computeSobelMag(data, W, H);

    // Seed out* with original pixels (so non-mask positions read correctly)
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const pi = row * bw + col;
        const ci = ((y + row) * W + (x + col)) * 4;
        outR[pi] = data[ci];
        outG[pi] = data[ci + 1];
        outB[pi] = data[ci + 2];
      }
    }

    // isFill: true if (gy, gx) is inside our region AND in the mask.
    // Used to exclude self-matches from the search.
    const isFill = (gy, gx) =>
      gy >= y && gy < y + bh && gx >= x && gx < x + bw &&
      mask[(gy - y) * bw + (gx - x)] === 1;

    // Patch comparison: SSD over color + gradient, weighted by valid-pixel count.
    function patchScore(targetGY, targetGX, srcGY, srcGX) {
      let ssdColor = 0, ssdGrad = 0, cnt = 0;
      for (let py = -PATCH_R; py <= PATCH_R; py++) {
        const ty = targetGY + py, sy = srcGY + py;
        if (ty < 0 || ty >= H || sy < 0 || sy >= H) continue;
        for (let px = -PATCH_R; px <= PATCH_R; px++) {
          const tx = targetGX + px, sx = srcGX + px;
          if (tx < 0 || tx >= W || sx < 0 || sx >= W) continue;
          if (isFill(ty, tx) || isFill(sy, sx)) continue;
          const ti = (ty * W + tx) * 4, si = (sy * W + sx) * 4;
          const dr = data[ti]   - data[si];
          const dg = data[ti+1] - data[si+1];
          const db = data[ti+2] - data[si+2];
          ssdColor += dr*dr + dg*dg + db*db;
          // Edge-aware: gradient magnitude difference (squared)
          const gd = grad[ty * W + tx] - grad[sy * W + sx];
          ssdGrad += gd * gd * 3;       // ×3 to roughly match per-channel color scale
          cnt++;
        }
      }
      if (cnt < 6) return Infinity;
      return (ssdColor + ssdGrad) / cnt;
    }

    // Locality penalty: scales the SSD by (1 + (dist/LOCAL_D)²)
    function scoreWithLocality(pi_local, srcGY, srcGX, targetGY, targetGX) {
      const score = patchScore(targetGY, targetGX, srcGY, srcGX);
      if (score === Infinity) return Infinity;
      const dy = srcGY - targetGY, dx = srcGX - targetGX;
      const d2 = dy * dy + dx * dx;
      const penalty = 1 + d2 / (LOCAL_D * LOCAL_D);
      return score * penalty;
    }

    // PatchMatch state: for each masked pixel, an offset (dy, dx) to its source.
    const offR  = new Int16Array(bw * bh);
    const offC  = new Int16Array(bw * bh);
    const pmErr = new Float32Array(bw * bh).fill(Infinity);

    // Search ring: pick a random non-masked pixel within SEARCH_R of the target
    function randomSourceNear(targetGY, targetGX) {
      for (let attempts = 0; attempts < 30; attempts++) {
        const ang = Math.random() * Math.PI * 2;
        const r   = Math.random() * SEARCH_R;
        const sy  = Math.max(0, Math.min(H - 1, Math.round(targetGY + Math.sin(ang) * r)));
        const sx  = Math.max(0, Math.min(W - 1, Math.round(targetGX + Math.cos(ang) * r)));
        if (!isFill(sy, sx)) return [sy, sx];
      }
      return null;
    }

    // Initialisation: for each masked pixel, random init within search ring
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const pi = row * bw + col;
        if (!mask[pi]) continue;
        const tGY = y + row, tGX = x + col;
        const init = randomSourceNear(tGY, tGX);
        if (!init) continue;
        const [sGY, sGX] = init;
        offR[pi] = sGY - tGY; offC[pi] = sGX - tGX;
        pmErr[pi] = scoreWithLocality(pi, sGY, sGX, tGY, tGX);
      }
    }

    // Try a candidate offset; update if better
    function tryAt(pi, tGY, tGX, sGY, sGX) {
      if (sGY < 0 || sGY >= H || sGX < 0 || sGX >= W || isFill(sGY, sGX)) return;
      // Color-space gate: candidate must be roughly the right color (cheap reject)
      const si = (sGY * W + sGX) * 4;
      const colorDev = (Math.abs(data[si]   - bgEst[(pi * 3)])     +
                        Math.abs(data[si+1] - bgEst[(pi * 3) + 1]) +
                        Math.abs(data[si+2] - bgEst[(pi * 3) + 2])) / 3;
      if (colorDev > 50) return;
      const e = scoreWithLocality(pi, sGY, sGX, tGY, tGX);
      if (e < pmErr[pi]) { pmErr[pi] = e; offR[pi] = sGY - tGY; offC[pi] = sGX - tGX; }
    }

    // PatchMatch propagation + random search
    for (let iter = 0; iter < PM_ITERS; iter++) {
      const forward = (iter % 2) === 0;
      const rowStart = forward ? 0 : bh - 1, rowEnd = forward ? bh : -1, rowStep = forward ? 1 : -1;
      const colStart = forward ? 0 : bw - 1, colEnd = forward ? bw : -1, colStep = forward ? 1 : -1;
      for (let row = rowStart; row !== rowEnd; row += rowStep) {
        for (let col = colStart; col !== colEnd; col += colStep) {
          const pi = row * bw + col;
          if (!mask[pi]) continue;
          const tGY = y + row, tGX = x + col;
          // Propagate from neighbour
          if (forward) {
            if (col > 0      && mask[pi - 1])  tryAt(pi, tGY, tGX, tGY + offR[pi - 1],  tGX + offC[pi - 1]);
            if (row > 0      && mask[pi - bw]) tryAt(pi, tGY, tGX, tGY + offR[pi - bw], tGX + offC[pi - bw]);
          } else {
            if (col < bw - 1 && mask[pi + 1])  tryAt(pi, tGY, tGX, tGY + offR[pi + 1],  tGX + offC[pi + 1]);
            if (row < bh - 1 && mask[pi + bw]) tryAt(pi, tGY, tGX, tGY + offR[pi + bw], tGX + offC[pi + bw]);
          }
          // Random search at decreasing radii
          for (let r = SEARCH_R; r >= 1; r = (r / 2) | 0) {
            tryAt(pi, tGY, tGX,
              Math.round(tGY + offR[pi] + (Math.random() * 2 - 1) * r),
              Math.round(tGX + offC[pi] + (Math.random() * 2 - 1) * r));
          }
        }
      }
    }

    // Write the matched pixels into out*
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const pi = row * bw + col;
        if (!mask[pi]) continue;
        const sGY = (y + row) + offR[pi];
        const sGX = (x + col) + offC[pi];
        if (sGY >= 0 && sGY < H && sGX >= 0 && sGX < W) {
          const si = (sGY * W + sGX) * 4;
          outR[pi] = data[si]; outG[pi] = data[si+1]; outB[pi] = data[si+2];
        } else {
          // Fallback to bg estimate if we somehow ended up out of bounds
          const bi = pi * 3;
          outR[pi] = bgEst[bi]; outG[pi] = bgEst[bi+1]; outB[pi] = bgEst[bi+2];
        }
      }
    }

    // Light boundary smoothing — only on mask-edge pixels — to hide the
    // discontinuity where the inpainted patch meets the surrounding image.
    const GS_ITERS = 8;
    const ALPHA    = 0.55;
    for (let iter = 0; iter < GS_ITERS; iter++) {
      for (let row = 0; row < bh; row++) {
        for (let col = 0; col < bw; col++) {
          const pi = row * bw + col;
          if (!mask[pi]) continue;
          // Check if pixel is on the mask boundary (has at least one non-mask neighbour)
          let onBoundary = false;
          let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
          const NR = [row - 1, row + 1, row,     row    ];
          const NC = [col,     col,     col - 1, col + 1];
          for (let k = 0; k < 4; k++) {
            const nr = NR[k], nc = NC[k];
            if (nr < 0 || nr >= bh || nc < 0 || nc >= bw) {
              onBoundary = true;   // image edge counts as boundary
              continue;
            }
            const npi = nr * bw + nc;
            if (!mask[npi]) {
              onBoundary = true;
              const ci = ((y + nr) * W + (x + nc)) * 4;
              sumR += data[ci]; sumG += data[ci + 1]; sumB += data[ci + 2];
              cnt++;
            } else {
              sumR += outR[npi]; sumG += outG[npi]; sumB += outB[npi];
              cnt++;
            }
          }
          if (!onBoundary || cnt === 0) continue;
          outR[pi] += ALPHA * (sumR / cnt - outR[pi]);
          outG[pi] += ALPHA * (sumG / cnt - outG[pi]);
          outB[pi] += ALPHA * (sumB / cnt - outB[pi]);
        }
      }
    }
  }

  // 3×3 Sobel gradient magnitude over an RGBA image, returned as Float32Array.
  // Used by edge-aware patch matching.
  function computeSobelMag(data, W, H) {
    const mag = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        // Convert each neighbor to luminance, apply Sobel
        const L = (px, py) => {
          const i = (py * W + px) * 4;
          return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        };
        const gx = -L(x-1, y-1) + L(x+1, y-1)
                 - 2*L(x-1, y)  + 2*L(x+1, y)
                 -   L(x-1, y+1) +   L(x+1, y+1);
        const gy = -L(x-1, y-1) - 2*L(x, y-1) - L(x+1, y-1)
                 +  L(x-1, y+1) + 2*L(x, y+1) + L(x+1, y+1);
        mag[y * W + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return mag;
  }


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