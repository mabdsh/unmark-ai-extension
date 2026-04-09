/**
 * UnmarkAI v3.2 — ISOLATED WORLD Content Script
 *
 * Has access to Chrome APIs but cannot intercept page JS (that's main-world.js).
 * Communicates with main-world.js via window.postMessage.
 *
 * RESPONSIBILITIES:
 *   • Receive GWR_INTERCEPT messages → fetch image → process → send GWR_DOWNLOAD
 *   • Expose __UAI_scanImages / __UAI_processAndDownload for popup manual scan
 *   • Sync settings to main world on load and on settings change
 *   • Report stats to background service worker
 *
 * METHODS (cfg.method):
 *   smart    — Detect sparkle region, fill with blended surrounding sample (default)
 *   fill     — Detect sparkle region, fill by copying pixels from directly above
 *   crop     — Trim the bottom 8 % of the image (removes badge + sparkle entirely)
 *   strip    — Re-encode only; destroys SynthID, no visible-watermark removal
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

  // ── Message Bridge ─────────────────────────────────────────────────────────
  function installMessageBridge() {
    window.addEventListener('message', async (e) => {
      if (!e.data || typeof e.data.gwrType !== 'string') return;
      if (e.origin !== window.location.origin && e.origin !== 'null') return;

      if (e.data.gwrType === 'GWR_INTERCEPT') {
        if (!cfg.enabled) {
          window.postMessage({ gwrType: 'GWR_FALLBACK', url: e.data.url, filename: e.data.filename }, '*');
          return;
        }
        // Notify background so fallback download.onCreated skips this URL
        chrome.runtime.sendMessage({ action: 'lockUrl', url: e.data.url }).catch(() => {});
        await processIntercept(e.data.url, e.data.filename);
      }
    });
  }

  async function processIntercept(url, filename) {
    // Deduplicate: ignore if same URL is already in flight
    if (processingUrls.has(url)) {
      log('Duplicate intercept ignored for:', url.slice(0, 60));
      return;
    }
    processingUrls.add(url);

    toast('Removing watermark…', 'info');
    try {
      const rawBlob   = await fetchImage(url);
      const cleanBlob = await processImage(rawBlob);
      const dataUrl   = await blobToDataURL(cleanBlob);

      window.postMessage({
        gwrType:  'GWR_DOWNLOAD',
        dataUrl,
        filename: normalizeFilename(filename),
      }, '*');

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      toast('Watermark removed!', 'success');
      log('Processed:', filename);
    } catch (err) {
      log('Processing error:', err.message);
      toast('Processing failed — downloading original', 'error');
      window.postMessage({ gwrType: 'GWR_FALLBACK', url, filename }, '*');
    } finally {
      processingUrls.delete(url);
    }
  }

  // ── Image Fetch ────────────────────────────────────────────────────────────
  async function fetchImage(url) {
    // Blob / data URLs: fetch directly (isolated world can access same-tab blobs)
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`blob fetch failed: ${r.status}`);
      return r.blob();
    }

    // HTTPS cross-origin: delegate to background service worker which has
    // broader network access via host_permissions.
    const result = await chrome.runtime.sendMessage({ action: 'fetchImage', url });
    if (result?.error) throw new Error(result.error);
    return new Blob([new Uint8Array(result.buffer)], {
      type: result.mimeType || 'image/png',
    });
  }

  // ── Image Processing Pipeline ──────────────────────────────────────────────
  async function processImage(blob) {
    const bitmap = await createImageBitmap(blob);
    const W = bitmap.width, H = bitmap.height;
    log('Processing', W, '×', H, '| method:', cfg.method, '| format:', cfg.format);

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });

    // ── CROP: trim bottom 8 % — removes badge AND sparkle in one shot ────────
    if (cfg.method === 'crop') {
      const cropH = Math.floor(H * 0.92);
      canvas.width  = W;
      canvas.height = cropH;
      // drawImage(src, sx,sy,sw,sh, dx,dy,dw,dh) — crop from top
      ctx.drawImage(bitmap, 0, 0, W, cropH, 0, 0, W, cropH);
      bitmap.close();

    } else {
      // SMART / FILL / STRIP: draw full image first.
      // This single canvas re-encode already destroys the SynthID invisible watermark.
      canvas.width  = W;
      canvas.height = H;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // Remove the visible sparkle mark (skip for strip — re-encode only)
      if (cfg.removeVisible && cfg.method !== 'strip') {
        removeVisibleWatermark(ctx, W, H, cfg.method);
      }
    }

    const mime = cfg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const qual = cfg.format === 'jpeg' ? 0.96 : undefined;

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
      // ── Fallback: precision detection failed, clean the fixed corner zone ──
      // Gemini ALWAYS places the ✦ mark in the bottom-right corner at the same
      // absolute pixel offset. When the color/shape detector misses it (e.g. the
      // image background is unusual), fill that fixed corner zone anyway.
      // The content-aware fill makes this invisible on natural image content.
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
   * to flag a pixel. False-positive clusters are then rejected by a density
   * check so that scattered image-content edges don't produce spurious regions.
   *
   * SIGNAL 1 — COLOR FINGERPRINT (background-independent):
   *   Gemini's ✦ is always rendered in lavender-gray (R≈G mid-range, B dominant).
   *   Range validated empirically from real Gemini exports.
   *
   * SIGNAL 2 — 4-FOLD STAR STRUCTURE:
   *   The ✦ arms (N/S/E/W) contrast with the diagonal gaps (NE/NW/SE/SW).
   *   Threshold 14 — low enough to catch subtle sparkles on any background.
   *
   * DENSITY CHECK (replaces the AND requirement from the previous version):
   *   After clustering, if flagged pixels are too sparse (< 4% fill of their
   *   bounding box), the cluster is rejected. This handles false positives from
   *   image content edges far better than requiring both signals simultaneously.
   *
   * WHY OR NOT AND:
   *   On some image backgrounds the color fingerprint won't match (blending
   *   alters the exact RGB). On others the star geometry is weak. OR ensures
   *   at least one signal fires. The density check then validates the result.
   */
  function detectSparkle(data, W, H) {
    // Extended scan area — larger than before to catch the full mark
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

        // ── Signal 1: lavender-gray color fingerprint ─────────────────────
        // Widened slightly vs the original to handle image-blending variations.
        const isLavender = (
          r >= 95  && r <= 170 &&
          g >= 95  && g <= 170 &&
          b >= 128 && b <= 198 &&
          Math.abs(r - g) < 30 &&
          b > r + 5
        );

        // ── Signal 2: 4-fold star shape ───────────────────────────────────
        const N  = lum(data[((y-ARM)*W+x)*4], data[((y-ARM)*W+x)*4+1], data[((y-ARM)*W+x)*4+2]);
        const S  = lum(data[((y+ARM)*W+x)*4], data[((y+ARM)*W+x)*4+1], data[((y+ARM)*W+x)*4+2]);
        const E  = lum(data[(y*W+(x+ARM))*4], data[(y*W+(x+ARM))*4+1], data[(y*W+(x+ARM))*4+2]);
        const Ww = lum(data[(y*W+(x-ARM))*4], data[(y*W+(x-ARM))*4+1], data[(y*W+(x-ARM))*4+2]);
        const d  = Math.round(ARM * 0.707);
        const NE = lum(data[((y-d)*W+(x+d))*4], data[((y-d)*W+(x+d))*4+1], data[((y-d)*W+(x+d))*4+2]);
        const NW = lum(data[((y-d)*W+(x-d))*4], data[((y-d)*W+(x-d))*4+1], data[((y-d)*W+(x-d))*4+2]);
        const SE = lum(data[((y+d)*W+(x+d))*4], data[((y+d)*W+(x+d))*4+1], data[((y+d)*W+(x+d))*4+2]);
        const SW = lum(data[((y+d)*W+(x-d))*4], data[((y+d)*W+(x-d))*4+1], data[((y+d)*W+(x-d))*4+2]);
        // Threshold 14 — original value; sensitive enough for subtle sparkles
        const isStarShape = Math.abs((N+S+E+Ww)/4 - (NE+NW+SE+SW)/4) > 14;

        // OR — either signal counts; density check (below) filters noise clusters
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

    // ── Density check ──────────────────────────────────────────────────────
    // Flagged pixels must form a compact cluster, not scattered edge noise.
    // The sparkle occupies ≥ 4% of its own bounding box; random edges don't.
    const density = count / (bw * bh);
    if (density < 0.04) return null;

    // Bounding box sanity: sparkle is always 6–120px
    if (bw > 120 || bh > 120) return null;
    if (bw <   5 || bh <   5) return null;

    const pad = 10; // generous padding to ensure full mark is covered
    return {
      x:      Math.max(0, minX - pad),
      y:      Math.max(0, minY - pad),
      width:  Math.min(W, maxX + pad + 1) - Math.max(0, minX - pad),
      height: Math.min(H, maxY + pad + 1) - Math.max(0, minY - pad),
    };
  }

  // ── Inpainting ─────────────────────────────────────────────────────────────
  /**
   * Fills the detected watermark region using one of two strategies:
   *
   * 'smart' — Weighted average of the surrounding ring of pixels, with subtle
   *           luminance jitter to avoid an obvious flat patch.
   *
   * 'fill'  — Copies pixels from directly above the watermark region (mirrored
   *           upward row-by-row). Works well when the background above the sparkle
   *           is uniform or patterned (e.g. a plain sky or gradient).
   */
  function inpaintRegion(data, W, H, bounds, method) {
    const { x, y, width: bw, height: bh } = bounds;

    if (method === 'fill') {
      // Copy from directly above — row at (y-1) goes into row y, etc.
      for (let row = y; row < Math.min(H, y + bh); row++) {
        const offset    = row - y;                    // 0, 1, 2, ...
        const sourceRow = Math.max(0, y - offset - 1); // mirror upward
        for (let col = x; col < Math.min(W, x + bw); col++) {
          const src = (sourceRow * W + col) * 4;
          const dst = (row       * W + col) * 4;
          data[dst]     = data[src];
          data[dst + 1] = data[src + 1];
          data[dst + 2] = data[src + 2];
          data[dst + 3] = 255;
        }
      }
    } else {
      // 'smart': sample a ring of pixels around the watermark and average them
      const samplePad = Math.max(14, Math.round(W * 0.014));
      let rSum = 0, gSum = 0, bSum = 0, n = 0;

      const sx1 = Math.max(0, x - samplePad), sy1 = Math.max(0, y - samplePad);
      const sx2 = Math.min(W, x + bw + samplePad), sy2 = Math.min(H, y + bh + samplePad);

      for (let sy = sy1; sy < sy2; sy++) {
        for (let sx = sx1; sx < sx2; sx++) {
          // Skip the watermark patch itself — only sample the ring around it
          if (sx >= x && sx < x + bw && sy >= y && sy < y + bh) continue;
          const i = (sy * W + sx) * 4;
          rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; n++;
        }
      }

      const avgR = n ? Math.round(rSum / n) : 18;
      const avgG = n ? Math.round(gSum / n) : 19;
      const avgB = n ? Math.round(bSum / n) : 50;

      // Fill with tiny luminance jitter to avoid a visible flat patch
      for (let row = y; row < Math.min(H, y + bh); row++) {
        for (let col = x; col < Math.min(W, x + bw); col++) {
          const i = (row * W + col) * 4;
          const j = Math.round((Math.random() - 0.5) * 5);
          data[i]     = clamp(avgR + j);
          data[i + 1] = clamp(avgG + j);
          data[i + 2] = clamp(avgB + j);
          data[i + 3] = 255;
        }
      }
    }
  }

  // ── Manual Scan API (called by popup via chrome.scripting.executeScript) ───
  window.__UAI_scanImages = function () {
    // Look for images that are plausibly Gemini-generated:
    // • Larger than 256 px on both axes (excludes icons, avatars, thumbnails)
    // • Hosted on known Gemini image domains OR are blob URLs
    // • De-duplicated by src
    const seen = new Set();
    const results = [];

    document.querySelectorAll('img[src]').forEach(img => {
      const { src, naturalWidth: w, naturalHeight: h } = img;
      if (w < 256 || h < 256) return;
      if (seen.has(src)) return;

      const isGeminiSource =
        src.startsWith('blob:') ||
        src.includes('googleusercontent.com') ||
        src.includes('generativelanguage.googleapis.com') ||
        src.includes('storage.googleapis.com') ||
        src.includes('generatedimage') ||
        /\.(png|jpe?g|webp)(\?|$)/i.test(new URL(src, location.href).pathname);

      if (!isGeminiSource) return;

      seen.add(src);
      results.push({ src, width: w, height: h, alt: img.alt || '' });
    });

    return results.slice(0, 24); // cap at 24 images to keep the grid manageable
  };

  window.__UAI_processAndDownload = async function (url, filename) {
    try {
      const rawBlob   = await fetchImage(url);
      const cleanBlob = await processImage(rawBlob);
      const dataUrl   = await blobToDataURL(cleanBlob);

      // Tell main world to trigger the actual browser download
      window.postMessage({
        gwrType:  'GWR_DOWNLOAD',
        dataUrl,
        filename: normalizeFilename(filename),
      }, '*');

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      return { ok: true };
    } catch (e) {
      log('processAndDownload error:', e.message);
      return { ok: false, error: e.message };
    }
  };

  // Keep old name as alias so background.js fallback still works if page not refreshed
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

  /**
   * Produces a clean filename for the downloaded file.
   * BUG FIX: previous version kept the original extension even when the output
   * format differed (e.g. output was JPEG but filename stayed ".png").
   * Now always replaces any existing image extension with the correct one.
   */
  function normalizeFilename(name) {
    if (!name) return 'unmark-ai-clean.png';
    const ext  = cfg.format === 'jpeg' ? '.jpg' : '.png';
    // Strip any existing image extension, then append the correct one
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
    }, 4000);
  }

  function log(...args) {
    console.log('%c' + TAG, 'color:#38bdf8;font-weight:700', ...args);
  }

})();
