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
  const blobCache = new Map(); // blobUrl → data URL string or Blob

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

        // v3.5: main-world now sends a pre-converted data URL string (not a Blob)
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
      // Clear the click hint so it doesn't affect the next download if jslog fails
      delete document.documentElement.dataset.uaiClickedSrc;
      delete document.documentElement.dataset.uaiClickedTime;
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
    // 60-second window: user may hover other images after clicking download
    // before background.js processes it. Click is always more precise than hover.
    const clickHint   = (clickedSrc && Date.now() - clickedTime < 60000) ? clickedSrc : null;

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
      // Fallback: only apply if the corner actually contains sparkle-like pixels.
      // Without this guard, images without a sparkle get a visible flat-color
      // patch in the bottom-right corner (the IDW average of edge pixels is
      // a single blended color with no variation from the missing samples).
      const sz = Math.max(56, Math.floor(Math.min(W, H) * 0.075));
      if (cornerLooksLikeSparkle(data, W, H, sz)) {
        log('Sparkle not detected precisely — applying corner-zone fallback');
        const fallback = { x: W - sz, y: H - sz, width: sz, height: sz };
        inpaintRegion(data, W, H, fallback, method);
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

    // ── SMART: background-interpolation anomaly removal ───────────────────────
    // Instead of guessing which pixels ARE the sparkle by colour (fragile —
    // the sparkle can be white, lavender, or any colour depending on rendering),
    // we estimate what the background SHOULD look like by interpolating from
    // pixels just outside the detected region, then replace only pixels that
    // differ significantly from that estimate (= the sparkle pixels).
    //
    // This works perfectly for:
    //   • Gradients — the border pixels define the gradient; IDW continues it
    //   • Solid colours — every interior pixel gets the correct background value
    //   • Any sparkle colour — we detect by deviation, not by hue
    //   • Corner regions — only the available left/top border matters

    // Collect border pixels just outside the bounding box (skip missing edges)
    const bgSamples = [];
    const BG_STEP = 5; // sample every 5px along each border side
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

    // If the region is entirely at the image corner and all 4 borders are
    // missing — sample a wider ring so we always have something to interpolate from
    if (bgSamples.length < 4) {
      const pad = 15;
      for (let bx = Math.max(0, x - pad); bx < Math.min(W, x + bw + pad); bx += BG_STEP) {
        for (let by = Math.max(0, y - pad); by < Math.min(H, y + bh + pad); by += BG_STEP) {
          if (bx >= x && bx < x + bw && by >= y && by < y + bh) continue;
          const i = (by * W + bx) * 4;
          bgSamples.push({ r: data[i], g: data[i+1], b: data[i+2], sx: bx, sy: by });
        }
      }
    }

    // For each pixel in the region: IDW estimate of background, replace if anomalous
    // Threshold: mean absolute deviation across 3 channels > 15 units
    const THRESHOLD = 15;
    for (let row = y; row < Math.min(H, y + bh); row++) {
      for (let col = x; col < Math.min(W, x + bw); col++) {
        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        for (const p of bgSamples) {
          const dx = p.sx - col, dy = p.sy - row;
          const w  = 1 / (dx * dx + dy * dy + 0.25);
          sumR += p.r * w; sumG += p.g * w; sumB += p.b * w; sumW += w;
        }
        if (!sumW) continue;
        const er = sumR / sumW, eg = sumG / sumW, eb = sumB / sumW;
        const ci  = (row * W + col) * 4;
        const diff = (Math.abs(data[ci] - er) + Math.abs(data[ci+1] - eg) + Math.abs(data[ci+2] - eb)) / 3;
        if (diff > THRESHOLD) {
          data[ci]     = clamp(er);
          data[ci + 1] = clamp(eg);
          data[ci + 2] = clamp(eb);
          data[ci + 3] = 255;
        }
        // pixel matches background → left completely untouched ✓
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