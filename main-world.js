/**
 * UnmarkAI v3.2 — MAIN WORLD Script
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
 *   1. Gemini clicks download → Angular creates blob → URL.createObjectURL
 *   2. Angular creates <a download> and calls .click() → intercepted here
 *   3. Post GWR_INTERCEPT to isolated world (content.js)
 *   4. content.js fetches, processes, creates clean data URL
 *   5. content.js posts GWR_DOWNLOAD back
 *   6. We create <a> with clean data URL and trigger real browser download
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
  HTMLAnchorElement.prototype.click = function () {
    if (this._uaiDone || !enabled || !this.hasAttribute('download')) {
      return _origClick.apply(this, arguments);
    }
    const href = this.href;
    if (!looksLikeGeminiImage(href)) {
      return _origClick.apply(this, arguments);
    }
    log('Intercepted .click() on', href.slice(0, 70));
    sendIntercept(href, this.getAttribute('download') || 'gemini-image.png');
    // Do NOT call _origClick — we handle the download ourselves
  };

  // ── Override: dispatchEvent (catches React/Angular synthetic clicks) ─────
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      enabled &&
      !this._uaiDone &&
      this instanceof HTMLAnchorElement &&
      event instanceof MouseEvent &&
      event.type === 'click' &&
      this.hasAttribute('download') &&
      looksLikeGeminiImage(this.href)
    ) {
      log('Intercepted dispatchEvent click on', this.href.slice(0, 70));
      sendIntercept(this.href, this.getAttribute('download') || 'gemini-image.png');
      return true; // pretend event fired normally
    }
    return _origDispatch.apply(this, arguments);
  };

  // ── MutationObserver: catch "append → click → remove" anchor pattern ─────
  // Angular/React often creates a temporary <a> in the DOM, clicks it
  // programmatically, then removes it. We capture-listen before that click fires.
  new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLAnchorElement)) continue;
        if (!node.hasAttribute('download') || node._uaiDone) continue;
        if (!looksLikeGeminiImage(node.href)) continue;

        node.addEventListener('click', function captureHandler(e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          node.removeEventListener('click', captureHandler, true);
          log('Intercepted MutationObserver click on', node.href.slice(0, 70));
          sendIntercept(node.href, node.getAttribute('download') || 'gemini-image.png');
        }, true /* capture phase — fires before Angular handlers */);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function sendIntercept(url, filename) {
    window.postMessage({
      gwrType:  'GWR_INTERCEPT',
      url,
      filename,
      hasBlob:  blobMap.has(url),
    }, '*');
    // Transfer blob separately if available (Blob is structured-cloneable)
    const blob = blobMap.get(url);
    if (blob) {
      window.postMessage({ gwrType: 'GWR_BLOB', url, blob }, '*');
    }
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

  /**
   * Returns true only for URLs that look like Gemini-generated images.
   * Deliberately narrow to avoid intercepting unrelated downloads.
   */
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

  function log(...args) {
    console.log('%c' + TAG, 'color:#8B5CF6;font-weight:700', ...args);
  }

  log('MAIN world interceptors installed ✦');
})();
