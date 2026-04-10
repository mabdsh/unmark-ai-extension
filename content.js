/**
 * UnmarkAI v3.3 — ISOLATED WORLD Content Script
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
 *   smart    — Inverse-distance-weighted fill with Gaussian texture noise (default)
 *   fill     — Detect sparkle region, fill by copying pixels from directly above
 *   crop     — Trim the bottom 8 % of the image (removes badge + sparkle entirely)
 *   strip    — Re-encode only; destroys SynthID, no visible-watermark removal
 *
 * CHANGES v3.4 → v3.5 (blob:null fix):
 *   ROOT CAUSE: Gemini creates image blobs in a sandboxed iframe (null origin).
 *   These produce blob:null/uuid URLs. Chrome BLOCKS fetch() of blob:null URLs
 *   from isolated-world content scripts with "URL scheme blob is not supported".
 *   TWO-PART FIX:
 *   1. GWR_BLOB now accepts a pre-converted dataUrl string (sent by main-world
 *      via FileReader) instead of a Blob object. fetch(dataUrl) always works.
 *   2. fetchImage now has a multi-stage fallback chain: cached dataUrl →
 *      cached Blob → data: URL → blob: URL (try/catch) → HTTPS via background
 *      → imgHint HTTPS URL passed from main-world → DOM scan for page images.
 *      The last two stages handle blob:null definitively by using the same
 *      HTTPS URL that the manual scan uses (which always works).
 */

(function () {
  'use strict';

  const TAG = '[UAI-iso]';

  // ── Settings ───────────────────────────────────────────────────────────────
  let cfg = {
    enabled:           true,
    removeVisible:     true,
    removeSynthID:     true,
    method:            'smart',
    format:            'png',
    jpegQuality:       0.96,   // v3.3 — user-configurable
    showNotifications: true,
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function init() {
    try {
      const s = await chrome.storage.sync.get('settings');
      if (s.settings) Object.assign(cfg, s.settings);
    } catch (_) {}

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.settings?.newValue) {
        Object.assign(cfg, changes.settings.newValue);
        syncSettings();
      }
    });

    syncSettings();
    installMessageBridge();
    log('ISOLATED world ready on', window.location.hostname);
  })();

  // Push current enabled state to main world so it knows whether to intercept
  function syncSettings() {
    window.postMessage({ gwrType: 'GWR_SETTINGS', enabled: cfg.enabled }, '*');
  }

  // ── Per-URL processing lock ────────────────────────────────────────────────
  // Prevents the same URL from being processed twice (e.g., if both the primary
  // intercept and the popup manual-download trigger simultaneously).
  const processingUrls = new Set();

  // ── v3.5: Image data cache ─────────────────────────────────────────────────
  // main-world.js sends GWR_BLOB(dataUrl) before GWR_INTERCEPT.
  // We store the data URL string here; fetch(dataUrl) always works in content.js
  // unlike fetch('blob:null/...') which Chrome blocks with a security error.
  const blobCache = new Map(); // blobUrl → data URL string or Blob

  // ── Message Bridge ─────────────────────────────────────────────────────────
  function installMessageBridge() {
    window.addEventListener('message', async (e) => {
      if (!e.data || typeof e.data.gwrType !== 'string') return;
      if (e.origin !== window.location.origin && e.origin !== 'null') return;

      switch (e.data.gwrType) {

        // v3.5: main-world now sends a pre-converted data URL string (not a Blob)
        // so content.js never needs to fetch a blob: URL at all.
        case 'GWR_BLOB': {
          const { url, dataUrl, blob } = e.data;
          // Accept either a data URL string (v3.5) or a Blob object (legacy)
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
          // Notify background so fallback downloads.onCreated skips this URL
          chrome.runtime.sendMessage({ action: 'lockUrl', url: e.data.url }).catch(() => {});
          // v3.5: pass imgHint through so fetchImage can use it for blob:null fallback
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

  // v3.5: imgHint param — HTTPS URL from a nearby <img> on the page,
  // used as fallback when the download URL is a blob:null we cannot fetch.
  async function processIntercept(url, filename, cachedData = null, imgHint = null) {
    if (processingUrls.has(url)) {
      log('Duplicate intercept ignored for:', url.slice(0, 60));
      return;
    }
    processingUrls.add(url);

    toast('Removing watermark…', 'info');
    try {
      const rawBlob   = await fetchImage(url, cachedData, imgHint);
      const cleanBlob = await processImage(rawBlob);

      // v3.6 FIX: Use chrome.downloads.download() via background instead of
      // postMessage → doDownload(dataUrl) in main-world. The old path created
      // a Chrome download entry that our own downloads.onCreated listener then
      // detected as a "Gemini image download" and cancelled, because Chrome
      // internally converts <a href="data:..." download> clicks into blob: URLs
      // which don't match our data: URL skip-check.
      // chrome.downloads.download() is privileged and tracked with a counter
      // so onCreated knows to skip it.
      const dlResult = await chrome.runtime.sendMessage({
        action:   'downloadClean',
        dataUrl:  await blobToDataURL(cleanBlob),
        filename: normalizeFilename(filename),
      });
      if (!dlResult?.ok) throw new Error(dlResult?.error || 'chrome.downloads.download failed');

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      toast('Watermark removed ✓', 'success');
      log('Processed:', filename);
    } catch (err) {
      log('Processing error:', err.message);
      toast('Processing failed — downloading original', 'error');
      window.postMessage({ gwrType: 'GWR_FALLBACK', url, filename }, '*');
    } finally {
      processingUrls.delete(url);
      blobCache.delete(url);
    }
  }

  // ── Image Fetch — v3.5 multi-stage fallback chain ─────────────────────────
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
    // The blob URL is inaccessible (blob:null / revoked). The same image is
    // always rendered in a visible <img> tag on the Gemini page — use that
    // HTTPS URL instead. This is identical to what manual scan does.

    // Stage 6: imgHint sent by main-world (most targeted — found near the anchor)
    // Stage 7: our own DOM scan (broader — same as __UAI_scanImages)
    const fallbackUrl = imgHint || findBestPageImageUrl();

    if (!fallbackUrl) {
      throw new Error(
        'blob:null URL is inaccessible and no Gemini image found on this page. ' +
        'Please use Manual Scan in the popup as a workaround.'
      );
    }

    log('Stage 6/7: using page <img> fallback:', fallbackUrl.slice(0, 80));
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
  // v3.6 FIX: only skip blob:null (sandboxed-iframe, truly inaccessible).
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

  // ── Image Processing Pipeline ──────────────────────────────────────────────
  async function processImage(blob) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      throw new Error(`Could not decode image: ${err.message}`);
    }

    const W = bitmap.width, H = bitmap.height;
    log('Processing', W, '×', H, '| method:', cfg.method, '| format:', cfg.format);

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });

    // ── CROP: trim bottom 8 % ─────────────────────────────────────────────
    if (cfg.method === 'crop') {
      const cropH = Math.floor(H * 0.92);
      canvas.width  = W;
      canvas.height = cropH;
      ctx.drawImage(bitmap, 0, 0, W, cropH, 0, 0, W, cropH);
      bitmap.close();

    } else {
      // SMART / FILL / STRIP: full-image draw destroys SynthID watermark.
      canvas.width  = W;
      canvas.height = H;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      if (cfg.removeVisible && cfg.method !== 'strip') {
        removeVisibleWatermark(ctx, W, H, cfg.method);
      }
    }

    const mime = cfg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    // v3.3: use configurable quality; fallback to 0.96
    const qual = cfg.format === 'jpeg' ? (cfg.jpegQuality ?? 0.96) : undefined;

    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('canvas.toBlob returned null')), mime, qual)
    );
  }

  // ── Visible Watermark Removal ──────────────────────────────────────────────
  function removeVisibleWatermark(ctx, W, H, method) {
    const imgData  = ctx.getImageData(0, 0, W, H);
    const { data } = imgData;

    const region = detectSparkle(data, W, H);
    if (region) {
      log('Sparkle detected at', JSON.stringify(region));
      inpaintRegion(data, W, H, region, method);
      ctx.putImageData(imgData, 0, 0);
    } else {
      // Fallback: fixed corner zone — Gemini always places the ✦ in the
      // bottom-right corner at the same relative offset.
      log('Sparkle not detected — applying corner-zone fallback');
      const sz = Math.max(72, Math.floor(Math.min(W, H) * 0.085));
      const fallback = { x: W - sz, y: H - sz, width: sz, height: sz };
      inpaintRegion(data, W, H, fallback, method);
      ctx.putImageData(imgData, 0, 0);
    }
  }

  // ── Sparkle Detector ───────────────────────────────────────────────────────
  /**
   * Locates the Gemini ✦ watermark in the bottom-right corner using two
   * independent signals combined with OR logic. Either signal alone is enough
   * to flag a pixel. False-positive clusters are rejected by a density check.
   *
   * SIGNAL 1 — COLOR FINGERPRINT:
   *   Gemini's ✦ is rendered in lavender-gray (R≈G mid-range, B dominant).
   *
   * SIGNAL 2 — 4-FOLD STAR STRUCTURE:
   *   The ✦ arms (N/S/E/W) contrast with diagonal gaps (NE/NW/SE/SW).
   *
   * DENSITY CHECK: flagged pixels must be compact (≥4% fill of bounding box).
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

        // Signal 1: lavender-gray color fingerprint
        const isLavender = (
          r >= 95  && r <= 170 &&
          g >= 95  && g <= 170 &&
          b >= 128 && b <= 198 &&
          Math.abs(r - g) < 30 &&
          b > r + 5
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
        const isStarShape = Math.abs((N+S+E+Ww)/4 - (NE+NW+SE+SW)/4) > 14;

        if (isLavender || isStarShape) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          count++;
        }
      }
    }

    if (count < 6 || minX === Infinity) return null;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    const density = count / (bw * bh);
    if (density < 0.04) return null;

    // Bounding-box sanity check
    if (bw > 120 || bh > 120) return null;
    if (bw <   5 || bh <   5) return null;

    const pad = 10;
    return {
      x:      Math.max(0, minX - pad),
      y:      Math.max(0, minY - pad),
      width:  Math.min(W, maxX + pad + 1) - Math.max(0, minX - pad),
      height: Math.min(H, maxY + pad + 1) - Math.max(0, minY - pad),
    };
  }

  // ── Inpainting ─────────────────────────────────────────────────────────────
  /**
   * 'smart' (v3.3 IMPROVED):
   *   Inverse-distance-weighted average of surrounding ring pixels, with
   *   Gaussian noise scaled to the local pixel standard deviation. This
   *   produces a far more natural fill than the old flat-average + fixed jitter.
   *
   * 'fill':
   *   Copies pixels from directly above the watermark region (mirrored upward).
   */
  function inpaintRegion(data, W, H, bounds, method) {
    const { x, y, width: bw, height: bh } = bounds;

    if (method === 'fill') {
      for (let row = y; row < Math.min(H, y + bh); row++) {
        const offset    = row - y;
        const sourceRow = Math.max(0, y - offset - 1);
        for (let col = x; col < Math.min(W, x + bw); col++) {
          const src = (sourceRow * W + col) * 4;
          const dst = (row       * W + col) * 4;
          data[dst]     = data[src];
          data[dst + 1] = data[src + 1];
          data[dst + 2] = data[src + 2];
          data[dst + 3] = 255;
        }
      }
      return;
    }

    // ── SMART: inverse-distance-weighted ring sample ───────────────────────
    const samplePad = Math.max(18, Math.round(W * 0.018));
    const sx1 = Math.max(0, x - samplePad);
    const sy1 = Math.max(0, y - samplePad);
    const sx2 = Math.min(W, x + bw + samplePad);
    const sy2 = Math.min(H, y + bh + samplePad);

    let rW = 0, gW = 0, bW = 0;
    let rSq = 0, gSq = 0, bSq = 0;
    let totalW = 0;

    for (let sy = sy1; sy < sy2; sy++) {
      for (let sx = sx1; sx < sx2; sx++) {
        // Skip the watermark patch — only sample the surrounding ring
        if (sx >= x && sx < x + bw && sy >= y && sy < y + bh) continue;
        const i = (sy * W + sx) * 4;
        const pr = data[i], pg = data[i + 1], pb = data[i + 2];

        // Inverse-square distance weight (closer pixels influence more)
        const dx = Math.max(0, sx < x ? x - sx : sx - (x + bw - 1));
        const dy = Math.max(0, sy < y ? y - sy : sy - (y + bh - 1));
        const w  = 1 / (dx * dx + dy * dy + 0.25);

        rW += pr * w; gW += pg * w; bW += pb * w;
        rSq += pr * pr * w; gSq += pg * pg * w; bSq += pb * pb * w;
        totalW += w;
      }
    }

    const avgR = totalW ? rW / totalW : 18;
    const avgG = totalW ? gW / totalW : 19;
    const avgB = totalW ? bW / totalW : 50;

    // Local standard deviation → realistic texture noise magnitude
    const stdR = totalW ? Math.sqrt(Math.max(0, rSq / totalW - avgR * avgR)) : 4;
    const stdG = totalW ? Math.sqrt(Math.max(0, gSq / totalW - avgG * avgG)) : 4;
    const stdB = totalW ? Math.sqrt(Math.max(0, bSq / totalW - avgB * avgB)) : 4;

    // Box-Muller Gaussian RNG — produces realistic pixel-level noise
    function gaussNoise(std) {
      if (std < 0.5) return 0; // nearly-uniform region — don't add noise
      const u1 = Math.random(), u2 = Math.random();
      return std * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2) * 0.45;
    }

    for (let row = y; row < Math.min(H, y + bh); row++) {
      for (let col = x; col < Math.min(W, x + bw); col++) {
        const i = (row * W + col) * 4;
        data[i]     = clamp(avgR + gaussNoise(stdR));
        data[i + 1] = clamp(avgG + gaussNoise(stdG));
        data[i + 2] = clamp(avgB + gaussNoise(stdB));
        data[i + 3] = 255;
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

  // ── v3.3 NEW: Batch download all found images ──────────────────────────────
  window.__UAI_downloadAll = async function () {
    const images = window.__UAI_scanImages();
    if (!images.length) return { ok: false, error: 'No images found on page' };

    let succeeded = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const filename = `unmark-ai-${i + 1}-of-${images.length}.png`;
      try {
        const rawBlob   = await fetchImage(img.src, blobCache.get(img.src));
        const cleanBlob = await processImage(rawBlob);

        const dlResult = await chrome.runtime.sendMessage({
          action:   'downloadClean',
          dataUrl:  await blobToDataURL(cleanBlob),
          filename: normalizeFilename(filename),
        });
        if (!dlResult?.ok) throw new Error(dlResult?.error || 'Download failed');

        await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});

        // Stagger downloads so browser doesn't throttle
        await new Promise(r => setTimeout(r, 400));
        succeeded++;
      } catch (e) {
        failed++;
        errors.push(e.message);
        log('downloadAll — image', i + 1, 'failed:', e.message);
      }
    }

    return { ok: succeeded > 0, succeeded, failed, total: images.length, errors };
  };

  window.__UAI_processAndDownload = async function (url, filename) {
    try {
      const rawBlob   = await fetchImage(url, blobCache.get(url), null);
      const cleanBlob = await processImage(rawBlob);

      const dlResult = await chrome.runtime.sendMessage({
        action:   'downloadClean',
        dataUrl:  await blobToDataURL(cleanBlob),
        filename: normalizeFilename(filename),
      });
      if (!dlResult?.ok) throw new Error(dlResult?.error || 'Download failed');

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      return { ok: true };
    } catch (e) {
      log('processAndDownload error:', e.message);
      return { ok: false, error: e.message };
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
    const ext  = cfg.format === 'jpeg' ? '.jpg' : '.png';
    const base = name.replace(/\.(png|jpe?g|jpg|webp|gif|bmp|avif)$/i, '');
    return base + ext;
  }

  // ── Toast Notifications ────────────────────────────────────────────────────
  let toastTimer = null;

  function toast(msg, type = 'info') {
    if (!cfg.showNotifications) return;

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
        transition:    'opacity .3s, transform .3s',
        boxShadow:     '0 4px 20px rgba(0,0,0,.35)',
        color:         '#fff',
        maxWidth:      '300px',
        opacity:       '0',
        transform:     'translateY(10px)',
      });
      document.body.appendChild(el);
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