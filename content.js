/**
 * Gemini Watermark Remover v3 — ISOLATED WORLD Content Script
 *
 * Has access to Chrome APIs but cannot intercept page JS (that's main-world.js).
 * Communicates with main-world.js via window.postMessage.
 *
 * RESPONSIBILITIES:
 *   • Receive GWR_INTERCEPT messages → fetch image → process → send GWR_DOWNLOAD
 *   • Expose __GWR_scanImages / __GWR_processAndDownload for popup manual scan
 *   • Sync settings to main world
 *   • Update background stats
 */

(function () {
  'use strict';

  const TAG = '[GWR-iso]';

  // ── Settings ────────────────────────────────────────────────────────────────
  let cfg = {
    enabled:           true,
    removeVisible:     true,
    removeSynthID:     true,
    method:            'smart',
    format:            'png',
    showNotifications: true,
  };

  // ── Boot ────────────────────────────────────────────────────────────────────
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

  // Push settings to main world so it knows whether to intercept
  function syncSettings() {
    window.postMessage({ gwrType: 'GWR_SETTINGS', enabled: cfg.enabled }, '*');
  }

  // ── Blob passthrough from main world ────────────────────────────────────────
  // main-world.js can't send the actual Blob object across worlds reliably,
  // so we fall back to fetching the URL directly (works for same-origin blobs).
  const pendingIntercepts = new Map(); // url → { filename }

  // ── Message bridge ──────────────────────────────────────────────────────────
  function installMessageBridge() {
    window.addEventListener('message', async (e) => {
      if (!e.data || typeof e.data.gwrType !== 'string') return;
      // Only trust messages from the same page (same origin)
      if (e.origin !== window.location.origin && e.origin !== 'null') return;

      switch (e.data.gwrType) {
        case 'GWR_INTERCEPT':
          if (!cfg.enabled) {
            // Pass through unchanged
            window.postMessage({ gwrType: 'GWR_FALLBACK', url: e.data.url, filename: e.data.filename }, '*');
            return;
          }
          // Queue the intercept
          pendingIntercepts.set(e.data.url, e.data.filename);
          await processIntercept(e.data.url, e.data.filename);
          break;
      }
    });
  }

  async function processIntercept(url, filename) {
    toast('🔄 Removing watermark…', 'info');
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
      toast('✅ Watermark removed!', 'success');
      log('Processed:', filename);
    } catch (err) {
      log('Error:', err.message);
      toast('⚠️ Processing failed — downloading original', 'error');
      window.postMessage({ gwrType: 'GWR_FALLBACK', url, filename }, '*');
    } finally {
      pendingIntercepts.delete(url);
    }
  }

  // ── Image Fetch ─────────────────────────────────────────────────────────────
  async function fetchImage(url) {
    // Blob URLs: fetch directly (isolated world can access same-tab blobs)
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`blob fetch failed: ${r.status}`);
      return r.blob();
    }

    // HTTPS: ask background to fetch cross-origin
    const result = await chrome.runtime.sendMessage({ action: 'fetchImage', url });
    if (result?.error) throw new Error(result.error);
    return new Blob([new Uint8Array(result.buffer)], { type: result.mimeType || 'image/png' });
  }

  // ── Image Processing Pipeline ───────────────────────────────────────────────
  async function processImage(blob) {
    const bitmap = await createImageBitmap(blob);
    const W = bitmap.width, H = bitmap.height;
    log('Processing', W, 'x', H);

    const canvas  = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx     = canvas.getContext('2d', { willReadFrequently: true });

    // ① Draw — this single pass inherently destroys SynthID invisible watermark
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // ② Remove visible watermark
    if (cfg.removeVisible && cfg.method !== 'strip') {
      removeVisibleWatermarks(ctx, W, H);
    }

    const mime = cfg.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const qual = cfg.format === 'jpeg' ? 0.96 : undefined;

    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), mime, qual)
    );
  }

  // ── Watermark Removal ───────────────────────────────────────────────────────
  function removeVisibleWatermarks(ctx, W, H) {
    const imgData  = ctx.getImageData(0, 0, W, H);
    const { data } = imgData;
    let modified   = false;

    // Sparkle: Gemini's ✦ mark (lavender, bottom-right ~91-98%)
    // Detected by LOCAL CONTRAST — empirically validated on real Gemini exports.
    // This is the only watermark type Gemini currently adds to downloaded images.
    const sparkle = detectSparkle(data, W, H);
    if (sparkle) {
      log('Sparkle detected:', sparkle);
      fillWithBackground(data, W, H, sparkle);
      modified = true;
    } else {
      log('No sparkle found — SynthID strip only');
    }

    // NOTE: "Made with Gemini" badge detection is intentionally disabled.
    // The badge (a dark text bar) cannot be reliably distinguished from normal
    // dark image content (e.g. dark backgrounds, icon shadows) using pixel
    // brightness alone — it causes false positives on images with dark regions.
    // Badge removal is available via the "Crop" method which trims the bottom.

    if (modified) ctx.putImageData(imgData, 0, 0);
  }

  // ── Sparkle Detector ────────────────────────────────────────────────────────
  /**
   * Detects Gemini's ✦ watermark using TWO independent methods combined:
   *
   * METHOD 1 — COLOR FINGERPRINT (background-independent):
   *   The sparkle is ALWAYS rendered as lavender-gray: R≈G≈127-148, B≈155-178.
   *   Empirically measured from multiple real Gemini downloads.
   *   This works on ANY background because we check the pixel's OWN color,
   *   not how it compares to surroundings.
   *
   * METHOD 2 — STRUCTURAL SHAPE (4-pointed star signature):
   *   The ✦ has 4 arms in N/S/E/W directions. At the center, luminance along
   *   cardinal axes (N/S/E/W) should DIFFER from diagonal axes (NE/NW/SE/SW).
   *   This detects the star geometry regardless of absolute color.
   *
   * SCAN AREA — Fixed absolute corner size (not %) because the sparkle is
   *   always the same absolute pixel size regardless of image dimensions.
   *   Last 120×120 px for images ≥512px, scaled for smaller images.
   *
   * A pixel is flagged if it passes METHOD 1 OR METHOD 2.
   * Final result must form a compact cluster (< 90px bounding box).
   */
  function detectSparkle(data, W, H) {
    // Fixed absolute scan window — sparkle is same physical size regardless of image size
    const SCAN = Math.min(120, Math.floor(Math.min(W, H) * 0.14));
    const SX   = W - SCAN;
    const SY   = H - SCAN;
    const ARM  = 8;   // arm length for 4-fold symmetry test

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let count = 0;

    for (let y = SY + ARM; y < H - ARM; y++) {
      for (let x = SX + ARM; x < W - ARM; x++) {
        const ci = (y * W + x) * 4;
        const r  = data[ci], g = data[ci + 1], b = data[ci + 2];

        // ── Method 1: Lavender-gray color fingerprint ─────────────────────────
        // Sparkle is ALWAYS approximately R≈G (neutral) and B > R+G (blue tint).
        // Range validated from multiple real Gemini 1024px exports.
        const isSparkleColor = (
          r >= 105 && r <= 158 &&
          g >= 105 && g <= 158 &&
          b >= 142 && b <= 182 &&
          Math.abs(r - g) < 20 &&   // R and G are close (gray-ish)
          b > r + 8                  // Blue channel dominates → lavender hue
        );

        // ── Method 2: 4-fold star shape (arms brighter/darker than gaps) ─────
        // Sample cardinal axes (N S E W = "arms" of the star)
        const N  = lum(data[((y-ARM)*W+ x   )*4], data[((y-ARM)*W+ x   )*4+1], data[((y-ARM)*W+ x   )*4+2]);
        const S  = lum(data[((y+ARM)*W+ x   )*4], data[((y+ARM)*W+ x   )*4+1], data[((y+ARM)*W+ x   )*4+2]);
        const E  = lum(data[( y     *W+(x+ARM))*4], data[( y     *W+(x+ARM))*4+1], data[( y     *W+(x+ARM))*4+2]);
        const Ww = lum(data[( y     *W+(x-ARM))*4], data[( y     *W+(x-ARM))*4+1], data[( y     *W+(x-ARM))*4+2]);
        // Sample diagonal axes (NE NW SE SW = "gaps" between star arms)
        const d  = Math.round(ARM * 0.707);
        const NE = lum(data[((y-d)*W+(x+d))*4], data[((y-d)*W+(x+d))*4+1], data[((y-d)*W+(x+d))*4+2]);
        const NW = lum(data[((y-d)*W+(x-d))*4], data[((y-d)*W+(x-d))*4+1], data[((y-d)*W+(x-d))*4+2]);
        const SE = lum(data[((y+d)*W+(x+d))*4], data[((y+d)*W+(x+d))*4+1], data[((y+d)*W+(x+d))*4+2]);
        const SW = lum(data[((y+d)*W+(x-d))*4], data[((y+d)*W+(x-d))*4+1], data[((y+d)*W+(x-d))*4+2]);

        const axisAvg = (N + S + E + Ww) / 4;
        const diagAvg = (NE + NW + SE + SW) / 4;
        // A 4-pointed star has arms that contrast with gaps — axis ≠ diag
        const isStarShape = Math.abs(axisAvg - diagAvg) > 16;

        if (isSparkleColor || isStarShape) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          count++;
        }
      }
    }

    if (count < 6 || count > 6000 || minX === Infinity) return null;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // Sparkle bounding box must be compact (empirically ~50-90px on 1024px image)
    if (bw > 110 || bh > 110) return null;
    if (bw <   4 || bh <   4) return null;

    const pad = 7;
    return {
      x:      Math.max(0, minX - pad),
      y:      Math.max(0, minY - pad),
      width:  Math.min(W, maxX + pad + 1) - Math.max(0, minX - pad),
      height: Math.min(H, maxY + pad + 1) - Math.max(0, minY - pad),
    };
  }

  // ── Fill with sampled background ────────────────────────────────────────────
  function fillWithBackground(data, W, H, bounds) {
    const { x, y, width: bw, height: bh } = bounds;
    const samplePad = Math.max(14, Math.round(W * 0.014));

    // Sample a ring of pixels AROUND the watermark region
    let rS = 0, gS = 0, bS = 0, n = 0;
    const sx1 = Math.max(0, x - samplePad), sy1 = Math.max(0, y - samplePad);
    const sx2 = Math.min(W, x + bw + samplePad), sy2 = Math.min(H, y + bh + samplePad);

    for (let sy = sy1; sy < sy2; sy++) {
      for (let sx = sx1; sx < sx2; sx++) {
        if (sx >= x && sx < x + bw && sy >= y && sy < y + bh) continue;
        const i = (sy * W + sx) * 4;
        rS += data[i]; gS += data[i + 1]; bS += data[i + 2]; n++;
      }
    }

    const aR = n ? Math.round(rS / n) : 18;
    const aG = n ? Math.round(gS / n) : 19;
    const aB = n ? Math.round(bS / n) : 50;

    // Fill with tiny luminance jitter to avoid obvious flat patch
    for (let row = y; row < Math.min(H, y + bh); row++) {
      for (let col = x; col < Math.min(W, x + bw); col++) {
        const i = (row * W + col) * 4;
        const j = Math.round((Math.random() - 0.5) * 3);
        data[i]     = clamp(aR + j);
        data[i + 1] = clamp(aG + j);
        data[i + 2] = clamp(aB + j);
        data[i + 3] = 255;
      }
    }
  }

  // ── Manual Scan API (called by popup via scripting.executeScript) ────────────
  window.__GWR_scanImages = function () {
    const imgs = [...document.querySelectorAll('img[src]')];
    return imgs
      .filter(img => img.naturalWidth > 200 && img.naturalHeight > 200)
      .map(img => ({
        src:    img.src,
        width:  img.naturalWidth,
        height: img.naturalHeight,
        alt:    img.alt || '',
      }))
      .slice(0, 20);
  };

  window.__GWR_processAndDownload = async function (url, filename) {
    try {
      const rawBlob   = await fetchImage(url);
      const cleanBlob = await processImage(rawBlob);
      const dataUrl   = await blobToDataURL(cleanBlob);

      // Tell main world to trigger the real download
      window.postMessage({
        gwrType:  'GWR_DOWNLOAD',
        dataUrl,
        filename: normalizeFilename(filename),
      }, '*');

      await chrome.runtime.sendMessage({ action: 'watermarkRemoved' }).catch(() => {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // ── Utilities ───────────────────────────────────────────────────────────────
  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
  function clamp(v)      { return Math.max(0, Math.min(255, Math.round(v))); }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const reader  = new FileReader();
      reader.onload  = () => res(reader.result);
      reader.onerror = () => rej(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  function normalizeFilename(name) {
    if (!name) return 'gemini-clean.png';
    const ext = cfg.format === 'jpeg' ? '.jpg' : '.png';
    return /\.(png|jpe?g|webp|gif)$/i.test(name) ? name : name + ext;
  }

  // ── Toast Notifications ─────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg, type = 'info') {
    if (!cfg.showNotifications) return;
    let el = document.getElementById('gwr-toast-v3');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gwr-toast-v3';
      el.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px',
        'padding:11px 17px', 'border-radius:10px',
        'font:500 13px/1.4 "Google Sans",Roboto,sans-serif',
        'z-index:2147483647', 'pointer-events:none',
        'transition:opacity .3s,transform .3s',
        'box-shadow:0 4px 18px rgba(0,0,0,.3)',
        'color:#fff', 'max-width:300px',
      ].join(';');
      document.body.appendChild(el);
    }
    el.style.background = { info: '#1a73e8', success: '#188038', error: '#c5221f' }[type] || '#1a73e8';
    el.style.opacity    = '1';
    el.style.transform  = 'translateY(0)';
    el.textContent      = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 4000);
  }

  function log(...a) {
    console.log('%c' + TAG, 'color:#38bdf8;font-weight:700', ...a);
  }

})();