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

  // ── Override: programmatic .click() on anchor elements ──────────────────
  // ROOT CAUSE FIX v3.4: removed `!this.hasAttribute('download')` guard.
  // Gemini creates plain <a href="..."> without a download attribute, which
  // caused all three interception paths to silently pass through before.
  HTMLAnchorElement.prototype.click = function () {
    if (this._uaiDone || !enabled) {
      return _origClick.apply(this, arguments);
    }
    const href = this.href;
    if (!looksLikeGeminiImage(href)) {
      return _origClick.apply(this, arguments);
    }
    log('Intercepted .click() on', href.slice(0, 70));
    // Use download attr if present, otherwise guess from URL
    sendIntercept(href, this.getAttribute('download') || guessFilename(href));
    // Do NOT call _origClick — we handle the download ourselves
  };

  // ── Override: dispatchEvent (catches React/Angular synthetic clicks) ─────
  // ROOT CAUSE FIX v3.4: removed `this.hasAttribute('download')` guard.
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      enabled &&
      !this._uaiDone &&
      this instanceof HTMLAnchorElement &&
      event instanceof MouseEvent &&
      event.type === 'click' &&
      looksLikeGeminiImage(this.href)
    ) {
      log('Intercepted dispatchEvent click on', this.href.slice(0, 70));
      sendIntercept(this.href, this.getAttribute('download') || guessFilename(this.href));
      return true; // pretend event fired normally
    }
    return _origDispatch.apply(this, arguments);
  };

  // ── MutationObserver: catch "append → click → remove" anchor pattern ─────
  // Angular often creates a temporary <a> in the DOM, clicks it, then removes it.
  // ROOT CAUSE FIX v3.4: removed `!node.hasAttribute('download')` guard.
  new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLAnchorElement)) continue;
        if (node._uaiDone) continue;
        if (!looksLikeGeminiImage(node.href)) continue;

        node.addEventListener('click', function captureHandler(e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          node.removeEventListener('click', captureHandler, true);
          log('Intercepted MutationObserver click on', node.href.slice(0, 70));
          sendIntercept(node.href, node.getAttribute('download') || guessFilename(node.href));
        }, true /* capture phase — fires before Angular handlers */);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Helpers ──────────────────────────────────────────────────────────────

  // v3.5 FIX: sendIntercept is now async.
  //
  // For blobs we captured via our URL.createObjectURL override (main-frame blobs):
  //   FileReader converts them to a data URL HERE in the main world, then sends
  //   GWR_BLOB(dataUrl). Content.js receives a plain string it can fetch() directly
  //   — no blob: scheme needed, no Chrome security restriction.
  //
  // For blob:null blobs (sandboxed iframe — we never captured them):
  //   We walk the DOM for a large <img> pointing to the same image via an HTTPS URL
  //   and pass it as imgHint. Content.js uses this as the authoritative fallback.
  async function sendIntercept(url, filename) {
    const blob = blobMap.get(url);

    if (blob) {
      // Convert to data URL inside the main world — content.js can always fetch these
      try {
        const dataUrl = await blobToDataUrl(blob);
        window.postMessage({ gwrType: 'GWR_BLOB', url, dataUrl }, '*');
      } catch (e) {
        log('blobToDataUrl failed:', e.message);
      }
    }

    // Always look for a nearby HTTPS image URL as a fallback for blob:null downloads
    const imgHint = findNearestGeminiImageUrl();

    window.postMessage({
      gwrType:  'GWR_INTERCEPT',
      url,
      filename,
      hasBlob:  !!blob,
      imgHint,  // may be null if no accessible image found
    }, '*');
  }

  // Convert a Blob to a data URL using FileReader (main-world has full access)
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader   = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  // Walk the DOM for large Gemini-generated images — same URL patterns as
  // __UAI_scanImages so imgHint always matches what manual scan can find.
  //
  // v3.6 FIX: only skip blob:null. blob:https://gemini.google.com/uuid are
  // same-origin blobs (accessible) and are what Gemini uses for <img src>.
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