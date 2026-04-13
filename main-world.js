/**
 * UnmarkAI v3.8 — MAIN WORLD Script
 *
 * CHANGES v3.7 → v3.8:
 *   NEW: autoIntercept flag.
 *     When false (Manual mode), ALL four intercept paths (prototype .click,
 *     dispatchEvent override, DOM click listener, MutationObserver) pass
 *     through without intercepting — native Gemini downloads proceed normally.
 *     The `enabled` flag still controls the master on/off; autoIntercept is
 *     an independent second gate checked ONLY when enabled=true.
 *     Received from content.js via GWR_SETTINGS message.
 *
 * WHY THIS FILE EXISTS:
 *   Chrome content scripts run in an "isolated world" — a sandboxed JS context.
 *   Prototype overrides there do NOT affect the page's own JavaScript.
 *   This file runs in the MAIN world so its overrides genuinely intercept
 *   Gemini's download calls before Chrome ever sees them.
 *   NO Chrome extension APIs are available here (no chrome.runtime, no storage).
 *   All communication with the isolated world happens via window.postMessage.
 *
 * FLOW (Auto mode):
 *   1. Gemini clicks download → Angular creates blob OR uses direct image URL
 *   2. Angular creates <a> and calls .click()
 *   3. We intercept → Post GWR_BLOB + GWR_INTERCEPT to content.js
 *   4. content.js fetches + processes the image
 *   5. content.js sends downloadClean to background → chrome.downloads.download()
 *
 * FLOW (Manual mode — autoIntercept=false):
 *   1. All prototype/event overrides pass through → native Chrome download
 *   2. User opens popup → Scan page → clean individual images via popup UI
 */

(function () {
  'use strict';

  const TAG = '[UAI-main]';

  // Optimistic defaults — updated by isolated world via GWR_SETTINGS
  let enabled       = true;
  let autoIntercept = true; // v3.8 — when false, all intercept paths pass through

  // ── Listen for control messages from isolated world ──────────────────────
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data.gwrType !== 'string') return;
    if (e.origin !== window.location.origin && e.origin !== 'null') return;

    switch (e.data.gwrType) {
      case 'GWR_SETTINGS':
        enabled       = !!e.data.enabled;
        // v3.8: default true if key absent (backward compat with older content.js)
        autoIntercept = e.data.autoIntercept !== false;
        break;

      case 'GWR_DOWNLOAD':
        doDownload(e.data.dataUrl, e.data.filename);
        break;

      case 'GWR_FALLBACK':
        doDownload(e.data.url, e.data.filename);
        break;
    }
  });

  // ── Save originals BEFORE any override ──────────────────────────────────
  const _origClick        = HTMLAnchorElement.prototype.click;
  const _origDispatch     = EventTarget.prototype.dispatchEvent;
  const _origCreateObjURL = URL.createObjectURL.bind(URL);

  // ── Blob registry ────────────────────────────────────────────────────────
  const blobMap = new Map();

  URL.createObjectURL = function (obj) {
    const url = _origCreateObjURL(obj);
    if (obj instanceof Blob && obj.type && obj.type.startsWith('image/')) {
      blobMap.set(url, obj);
      setTimeout(() => blobMap.delete(url), 90_000);
    }
    return url;
  };

  // ── Track hovered image ──────────────────────────────────────────────────
  let lastHoveredSrc  = null;
  let lastHoveredTime = 0;

  document.addEventListener('mouseover', (e) => {
    const btn = e.target.closest?.('button.image-button');
    if (!btn) return;
    const img = btn.querySelector('img[src]');
    if (!img?.src || img.src.startsWith('blob:null')) return;
    if (!looksLikeGeminiImage(img.src)) return;
    lastHoveredSrc  = img.src;
    lastHoveredTime = Date.now();
    log('Hovered image-button:', img.src.slice(0, 60));
    document.documentElement.dataset.uaiHoveredSrc  = img.src;
    document.documentElement.dataset.uaiHoveredTime = Date.now().toString();
    window.postMessage({ gwrType: 'GWR_HOVER', src: img.src }, '*');
  }, true);

  let pendingImageSrc = null;
  let trustedClickX = 0, trustedClickY = 0;

  // General click listener — capture coords and try jslog cross-reference
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    trustedClickX = e.clientX;
    trustedClickY = e.clientY;

    let el = e.target;
    for (let d = 0; d < 15; d++) {
      if (!el || el === document.documentElement) break;
      const jslog = el.getAttribute?.('jslog') || '';
      const m = jslog.match(/"(rc_[a-f0-9]+)"/);
      if (m) {
        const si = document.querySelector(`single-image[jslog*="${m[1]}"]`);
        const img = si?.querySelector('img[src]');
        if (img?.src && !img.src.startsWith('blob:null') && looksLikeGeminiImage(img.src)) {
          pendingImageSrc = img.src;
          document.documentElement.dataset.uaiClickedSrc  = img.src;
          document.documentElement.dataset.uaiClickedTime = Date.now().toString();
          document.documentElement.dataset.uaiClickedRcId  = m[1]; // OPT 8: filename preservation
          log('jslog rc_ hit:', m[1], '→', img.src.slice(0, 60));
          return;
        }
      }
      el = el.parentElement;
    }
  }, true);

  // ── Real user click on download anchor ───────────────────────────────────
  document.addEventListener('click', function uaiCaptureClick(e) {
    // v3.8: skip intercept when disabled OR in manual mode
    if (!enabled || !autoIntercept) return;
    const anchor = e.target.closest('a');
    if (!anchor || anchor._uaiDone) return;
    const href = anchor.href;
    if (!href || !looksLikeGeminiImage(href)) return;
    if (!anchor.hasAttribute('download')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const filename = anchor.getAttribute('download') || guessFilename(href);
    log('Intercepted real user click on', href.slice(0, 70));
    sendIntercept(href, filename);
  }, true);

  // ── Override: programmatic .click() on anchors ───────────────────────────
  HTMLAnchorElement.prototype.click = function () {
    // v3.8: pass through if extension off OR in manual mode
    if (this._uaiDone || !enabled || !autoIntercept) return _origClick.apply(this, arguments);
    const href = this.href;
    if (!looksLikeGeminiImage(href)) return _origClick.apply(this, arguments);
    log('Intercepted .click() on', href.slice(0, 70));
    sendIntercept(href, this.getAttribute('download') || guessFilename(href));
  };

  // ── Override: dispatchEvent (synthetic clicks) ───────────────────────────
  EventTarget.prototype.dispatchEvent = function (event) {
    // v3.8: pass through if extension off OR in manual mode
    if (
      enabled && autoIntercept &&
      !this._uaiDone &&
      this instanceof HTMLAnchorElement &&
      event instanceof MouseEvent && event.type === 'click' &&
      looksLikeGeminiImage(this.href)
    ) {
      log('Intercepted dispatchEvent click on', this.href.slice(0, 70));
      sendIntercept(this.href, this.getAttribute('download') || guessFilename(this.href));
      return true;
    }
    return _origDispatch.apply(this, arguments);
  };

  // ── MutationObserver: catch append-click-remove anchor pattern ───────────
  new MutationObserver((mutations) => {
    // v3.8: skip observer work entirely in manual mode
    if (!enabled || !autoIntercept) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLAnchorElement) || node._uaiDone) continue;
        if (!looksLikeGeminiImage(node.href)) continue;
        node.addEventListener('click', function captureHandler(e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          node.removeEventListener('click', captureHandler, true);
          log('Intercepted MutationObserver click on', node.href.slice(0, 70));
          sendIntercept(node.href, node.getAttribute('download') || guessFilename(node.href));
        }, true);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function sendIntercept(url, filename) {
    const blob = blobMap.get(url);

    const recentHover = (Date.now() - lastHoveredTime < 5000) ? lastHoveredSrc : null;
    const imgHint = pendingImageSrc || recentHover || findImageByCoords() || findNearestGeminiImageUrl();
    pendingImageSrc = null;
    log('imgHint:', imgHint ? imgHint.slice(0, 80) : 'none',
        '| hover age:', Math.round((Date.now() - lastHoveredTime) / 1000) + 's');

    if (blob) {
      try {
        const dataUrl = await blobToDataUrl(blob);
        window.postMessage({ gwrType: 'GWR_BLOB', url, dataUrl }, '*');
      } catch (e) {
        log('blobToDataUrl failed:', e.message);
      }
    }

    window.postMessage({ gwrType: 'GWR_INTERCEPT', url, filename, hasBlob: !!blob, imgHint }, '*');
  }

  function findImageByCoords() {
    const imgs = Array.from(document.querySelectorAll('img[src]'))
      .filter(i => i.naturalWidth >= 256 && i.naturalHeight >= 256)
      .filter(i => !i.src.startsWith('blob:null') && looksLikeGeminiImage(i.src));
    if (imgs.length <= 1) return imgs[0]?.src ?? null;

    const x = trustedClickX, y = trustedClickY;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return img.src;
    }
    let best = null, bestD = Infinity;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      const d = (x - r.left - r.width/2)**2 + (y - r.top - r.height/2)**2;
      if (d < bestD) { bestD = d; best = img; }
    }
    return best?.src ?? null;
  }

  function findNearestGeminiImageUrl() {
    const imgs = Array.from(document.querySelectorAll('img[src]'));
    for (let i = imgs.length - 1; i >= 0; i--) {
      const img = imgs[i];
      if (img.naturalWidth < 256 || img.naturalHeight < 256) continue;
      const { src } = img;
      if (src.startsWith('blob:null')) continue;
      if (src.startsWith('blob:')) return src;
      if (
        src.includes('googleusercontent.com') ||
        src.includes('generativelanguage.googleapis.com') ||
        src.includes('storage.googleapis.com') ||
        src.includes('generatedimage')
      ) return src;
      try {
        const path = new URL(src).pathname;
        if (/\.(png|jpe?g|webp)(\?|$)/i.test(path)) return src;
      } catch {}
    }
    return null;
  }

  function doDownload(urlOrData, filename) {
    const a    = document.createElement('a');
    a._uaiDone = true;
    a.href     = urlOrData;
    a.download = filename;
    document.body.appendChild(a);
    _origClick.call(a);
    setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 2000);
  }

  function looksLikeGeminiImage(url) {
    if (!url) return false;
    if (url.startsWith('blob:')) return true;
    if (url.startsWith('data:image/')) return true;
    if (
      url.includes('googleusercontent.com') ||
      url.includes('generativelanguage.googleapis.com') ||
      url.includes('storage.googleapis.com')
    ) return true;
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/.test(path)) return true;
    } catch {}
    return false;
  }

  function guessFilename(url) {
    try {
      if (url.startsWith('blob:') || url.startsWith('data:')) return 'gemini-image.png';
      const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || 'gemini-image';
      return /\.(png|jpe?g|jpg|webp|gif|avif)$/i.test(seg) ? seg : seg + '.png';
    } catch {
      return 'gemini-image.png';
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const r   = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = () => rej(new Error('FileReader failed'));
      r.readAsDataURL(blob);
    });
  }

  function log(...args) {
    console.log('%c' + TAG, 'color:#2DD4BF;font-weight:700', ...args);
  }

  log('MAIN world interceptors installed ✦ v3.8 | autoIntercept=', autoIntercept);
})();