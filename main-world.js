/**
 * UnmarkAI v3.3 — MAIN WORLD Script
 *
 * WHY THIS FILE EXISTS:
 *   Chrome content scripts run in an "isolated world" — a sandboxed JS context.
 *   Prototype overrides there (like HTMLAnchorElement.prototype.click) do NOT
 *   affect the page's own JavaScript. Gemini's Angular code runs in the "main
 *   world" and never sees isolated-world overrides.
 *
 *   This file runs in the MAIN world (manifest "world": "MAIN") so its overrides
 *   genuinely intercept Gemini's download calls before Chrome ever sees them.
 *   This is the PRIMARY interception path — the fallback in background.js only
 *   fires for downloads that escape this layer.
 *
 *   NO Chrome extension APIs are available here (no chrome.runtime, no storage).
 *   All communication with the isolated world happens via window.postMessage.
 *
 * FLOW:
 *   1. Gemini clicks download → Angular creates blob OR uses direct image URL
 *   2. Angular creates <a> (with OR without download attr) and calls .click()
 *   3. We intercept → Post GWR_BLOB + GWR_INTERCEPT to isolated world (content.js)
 *   4. content.js uses cached Blob directly OR fetches the URL
 *   5. content.js posts GWR_DOWNLOAD back
 *   6. We create <a> with clean data URL and trigger real browser download
 *
 * CHANGES v3.3 → v3.4 (direct-download fix):
 *   ROOT CAUSE FIX: All three intercept methods (.click, dispatchEvent,
 *   MutationObserver) previously required hasAttribute('download'). Gemini's
 *   Angular download handler creates <a href="..."> WITHOUT a download attribute
 *   and calls .click() — so all three guards fired 'pass-through' and the
 *   original watermarked download proceeded unchecked.
 *   → Removed the download-attribute gate from all intercept paths.
 *   → Added guessFilename(url) so we always produce a sensible filename even
 *     when Gemini doesn't supply one via the download attribute.
 *
 * CHANGES v3.4 → v3.5 (blob:null fix):
 *   CHROME SECURITY ISSUE: Gemini creates image blobs inside a sandboxed
 *   iframe (null origin). These produce blob:null/uuid URLs that content.js
 *   (isolated world) CANNOT fetch — Chrome blocks it with
 *   "URL scheme blob is not supported" regardless of host_permissions.
 *   TWO-PART FIX:
 *   1. sendIntercept is now async. When a blob IS in our blobMap (main-frame
 *      blobs we captured), we use FileReader to convert it to a data URL HERE
 *      in the main world and pass that data URL via GWR_BLOB. Content.js then
 *      does fetch(dataUrl) which always works — no blob: scheme needed.
 *   2. When the blob is NOT in blobMap (sandboxed iframe blobs we can't
 *      capture), we walk the DOM for a nearby <img src> pointing to the same
 *      image via an accessible HTTPS URL, and pass that as imgHint in
 *      GWR_INTERCEPT. Content.js uses it as the authoritative fallback URL.
 *   Both paths ensure content.js never tries to fetch a blob:null URL.
 */

(function () {
  'use strict';

  const TAG = '[UAI-main]';
  let enabled = true; // optimistic default; updated by isolated world via GWR_SETTINGS

  // ── Listen for control messages from isolated world ──────────────────────
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data.gwrType !== 'string') return;
    // Only accept messages from the same page origin
    if (e.origin !== window.location.origin && e.origin !== 'null') return;

    switch (e.data.gwrType) {
      case 'GWR_SETTINGS':
        enabled = !!e.data.enabled;
        break;

      case 'GWR_DOWNLOAD':
        // Isolated world finished processing — trigger real browser download
        doDownload(e.data.dataUrl, e.data.filename);
        break;

      case 'GWR_FALLBACK':
        // Processing failed — let original URL download go through
        doDownload(e.data.url, e.data.filename);
        break;
    }
  });

  // ── Save originals BEFORE any override ──────────────────────────────────
  const _origClick        = HTMLAnchorElement.prototype.click;
  const _origDispatch     = EventTarget.prototype.dispatchEvent;
  const _origCreateObjURL = URL.createObjectURL.bind(URL);

  // ── Blob registry: captures image blobs created by page code ────────────
  // Keyed by the blob URL; auto-expiry after 90 s to avoid memory leaks.
  const blobMap = new Map();

  URL.createObjectURL = function (obj) {
    const url = _origCreateObjURL(obj);
    if (obj instanceof Blob && obj.type && obj.type.startsWith('image/')) {
      blobMap.set(url, obj);
      setTimeout(() => blobMap.delete(url), 90_000);
    }
    return url;
  };

  // ── Track which image the user is hovering ────────────────────────────────
  // CORE INSIGHT: button.image-button — the large clickable wrapper around
  // each generated image — is NEVER moved to a CDK portal. It always stays
  // in its original overlay-container in the main DOM.
  //
  // Angular CDK TemplatePortal creates BRAND NEW DOM nodes for the overlay
  // controls, so any annotation we put on the original download button node
  // does NOT survive to the portal copy. Every DOM-walk and annotation
  // approach fails for this reason.
  //
  // button.image-button is what triggers the hover state that shows the
  // download controls. The user MUST move their cursor over it to reveal
  // the download button. We record which image they hovered, and use a
  // 5-second window so only the most recently hovered image is used.
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
    // Write to the DOM so content.js can read it SYNCHRONOUSLY.
    // window.postMessage is async and loses the race against background.js's
    // downloads.onCreated fallback which calls __UAI_processAndDownload
    // synchronously before the message event fires.
    document.documentElement.dataset.uaiHoveredSrc  = img.src;
    document.documentElement.dataset.uaiHoveredTime = Date.now().toString();
    window.postMessage({ gwrType: 'GWR_HOVER', src: img.src }, '*');
  }, true);

  let pendingImageSrc = null;   // set by click listener, consumed by sendIntercept
  let trustedClickX = 0, trustedClickY = 0;

  // General click listener — capture coords and try jslog cross-reference
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    trustedClickX = e.clientX;
    trustedClickY = e.clientY;

    // jslog rc_ cross-reference: walk up from e.target looking for any
    // element whose jslog contains a Gemini rc_ candidate ID, then find
    // the single-image element in the main DOM that shares that ID.
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
          // Write to DOM synchronously — content.js reads this at Stage 6/7
          // even when background.js's scripting.executeScript runs later.
          document.documentElement.dataset.uaiClickedSrc  = img.src;
          document.documentElement.dataset.uaiClickedTime = Date.now().toString();
          log('jslog rc_ hit:', m[1], '→', img.src.slice(0, 60));
          return;
        }
      }
      el = el.parentElement;
    }
    // jslog failed — coords fallback and hover-based fallback remain available
  }, true);

  // ── Capture real user clicks on download anchor elements ─────────────────
  document.addEventListener('click', function uaiCaptureClick(e) {
    if (!enabled) return;
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

  // ── Override: programmatic .click() on anchor elements ──────────────────
  HTMLAnchorElement.prototype.click = function () {
    if (this._uaiDone || !enabled) return _origClick.apply(this, arguments);
    const href = this.href;
    if (!looksLikeGeminiImage(href)) return _origClick.apply(this, arguments);
    log('Intercepted .click() on', href.slice(0, 70));
    sendIntercept(href, this.getAttribute('download') || guessFilename(href));
  };

  // ── Override: dispatchEvent (catches React/Angular synthetic clicks) ─────
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      enabled && !this._uaiDone &&
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

  // ── MutationObserver: catch "append → click → remove" anchor pattern ─────
  new MutationObserver((mutations) => {
    if (!enabled) return;
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

    // Priority 1: jslog rc_ cross-reference from click (most precise)
    // Priority 2: last hovered image-button within 5 seconds (reliable — never in portal)
    // Priority 3: bounding-rect check against click coordinates
    // Priority 4: last Gemini image in DOM (last resort)
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

  // Bounding-rect fallback: find the Gemini image whose screen rect contains
  // the trusted click coordinates. The download controls are visually positioned
  // over the image so the click point should be within the image's bounds.
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
    // closest center fallback
    let best = null, bestD = Infinity;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      const d = (x - r.left - r.width/2)**2 + (y - r.top - r.height/2)**2;
      if (d < bestD) { bestD = d; best = img; }
    }
    return best?.src ?? null;
  }



  // Fallback page scan — used when lastHoveredImageSrc is null.
  // Returns the last large Gemini image in DOM order.
  function findNearestGeminiImageUrl() {
    const imgs = Array.from(document.querySelectorAll('img[src]'));
    for (let i = imgs.length - 1; i >= 0; i--) {
      const img = imgs[i];
      if (img.naturalWidth < 256 || img.naturalHeight < 256) continue;
      const { src } = img;

      // Only skip null-origin blobs (sandboxed iframe — truly inaccessible)
      if (src.startsWith('blob:null')) continue;

      // Same-origin blob (blob:https://gemini.google.com/...) — accept
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

    // Blob URLs created by Gemini's own JS (captured in blobMap)
    if (url.startsWith('blob:')) return true;

    // Explicit image data URLs
    if (url.startsWith('data:image/')) return true;

    // Known Gemini image-serving domains
    if (
      url.includes('googleusercontent.com') ||
      url.includes('generativelanguage.googleapis.com') ||
      url.includes('storage.googleapis.com')
    ) return true;

    // URL path has a recognised image extension
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/.test(path)) return true;
    } catch {}

    return false;
  }

  /**
   * Produces a reasonable download filename when the <a> element has no
   * download attribute. Extracts the last path segment and appends .png
   * if it has no recognised image extension.
   */
  function guessFilename(url) {
    try {
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        return 'gemini-image.png';
      }
      const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || 'gemini-image';
      return /\.(png|jpe?g|jpg|webp|gif|avif)$/i.test(seg) ? seg : seg + '.png';
    } catch {
      return 'gemini-image.png';
    }
  }

  function log(...args) {
    console.log('%c' + TAG, 'color:#8B5CF6;font-weight:700', ...args);
  }

  log('MAIN world interceptors installed ✦ v3.4');
})();