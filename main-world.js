/**
 * Gemini Watermark Remover v3 — MAIN WORLD Script
 *
 * WHY THIS FILE EXISTS:
 *   Chrome content scripts run in an "isolated world" — a sandboxed JS context.
 *   Prototype overrides there (like HTMLAnchorElement.prototype.click) do NOT
 *   affect the page's own JavaScript. Gemini's Angular code runs in the "main
 *   world" and never sees isolated-world overrides.
 *
 *   This file runs in the MAIN world (manifest "world": "MAIN") so its overrides
 *   genuinely intercept Gemini's download calls.
 *
 *   It has NO access to Chrome extension APIs (no chrome.runtime, no storage).
 *   All communication with the isolated world happens via window.postMessage.
 *
 * FLOW:
 *   1. Gemini clicks download → Angular code creates blob → URL.createObjectURL
 *   2. Angular creates <a download> and calls .click() → WE intercept here
 *   3. We post GWR_INTERCEPT to isolated world (content.js)
 *   4. content.js fetches, processes, creates clean data URL
 *   5. content.js posts GWR_DOWNLOAD back to us
 *   6. We create <a> with clean data URL and trigger real browser download
 */

(function () {
  'use strict';

  const TAG = '[GWR-main]';
  let enabled = true; // optimistic; updated by isolated world

  // ── Listen for settings/processed image from isolated world ─────────────────
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data.gwrType !== 'string') return;

    if (e.data.gwrType === 'GWR_SETTINGS') {
      enabled = !!e.data.enabled;
    }

    if (e.data.gwrType === 'GWR_DOWNLOAD') {
      // Isolated world has finished processing — trigger real browser download
      doDownload(e.data.dataUrl, e.data.filename);
    }

    if (e.data.gwrType === 'GWR_FALLBACK') {
      // Processing failed — just let original download go through
      doDownload(e.data.url, e.data.filename);
    }
  });

  // ── Save originals BEFORE any override ─────────────────────────────────────
  const _origClick       = HTMLAnchorElement.prototype.click;
  const _origDispatch    = EventTarget.prototype.dispatchEvent;
  const _origCreateObjURL = URL.createObjectURL.bind(URL);

  // ── Blob registry: captures blobs created by page code ─────────────────────
  const blobMap = new Map();  // blobUrl → Blob

  URL.createObjectURL = function (obj) {
    const url = _origCreateObjURL(obj);
    if (obj instanceof Blob && obj.type && obj.type.startsWith('image/')) {
      blobMap.set(url, obj);
      setTimeout(() => blobMap.delete(url), 90_000);
    }
    return url;
  };

  // ── Override: programmatic .click() on anchor elements ─────────────────────
  HTMLAnchorElement.prototype.click = function () {
    // Skip: our own clean-download anchors, disabled state, or non-downloads
    if (this._gwrDone || !enabled || !this.hasAttribute('download')) {
      return _origClick.apply(this, arguments);
    }

    const href = this.href;
    if (!looksLikeImage(href)) {
      return _origClick.apply(this, arguments);
    }

    log('Intercepted .click() on', href.slice(0, 60));
    sendIntercept(href, this.getAttribute('download') || 'gemini-image.png');
    // Do NOT call _origClick — we handle the download ourselves
  };

  // ── Override: dispatchEvent (catches React/Angular synthetic clicks) ─────────
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      enabled &&
      !this._gwrDone &&
      this instanceof HTMLAnchorElement &&
      event instanceof MouseEvent &&
      event.type === 'click' &&
      this.hasAttribute('download') &&
      looksLikeImage(this.href)
    ) {
      log('Intercepted dispatchEvent click on', this.href.slice(0, 60));
      sendIntercept(this.href, this.getAttribute('download') || 'gemini-image.png');
      return true; // pretend event fired normally
    }
    return _origDispatch.apply(this, arguments);
  };

  // ── MutationObserver: catch "append → click → remove" anchor pattern ────────
  new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLAnchorElement)) continue;
        if (!node.hasAttribute('download') || node._gwrDone) continue;
        if (!looksLikeImage(node.href)) continue;

        // Attach a high-priority capture listener BEFORE Angular can click it
        node.addEventListener('click', function captureHandler(e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          node.removeEventListener('click', captureHandler, true);
          log('Intercepted MutationObserver click on', node.href.slice(0, 60));
          sendIntercept(node.href, node.getAttribute('download') || 'gemini-image.png');
        }, true);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function sendIntercept(url, filename) {
    // Attach the blob (if we have it) so isolated world can process it directly
    const blob = blobMap.get(url) || null;
    window.postMessage({
      gwrType:  'GWR_INTERCEPT',
      url,
      filename,
      hasBlob:  !!blob,
    }, '*');

    // If we have the blob, transfer it via a second message
    // (Blob is clonable, not transferable, so this is a copy)
    if (blob) {
      window.postMessage({
        gwrType: 'GWR_BLOB',
        url,   // use URL as key
        blob,
      }, '*');
    }
  }

  function doDownload(urlOrData, filename) {
    const a    = document.createElement('a');
    a._gwrDone = true;
    a.href     = urlOrData;
    a.download = filename;
    document.body.appendChild(a);
    _origClick.call(a);
    setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 2000);
  }

  function looksLikeImage(url) {
    if (!url) return false;
    if (url.startsWith('blob:') || url.startsWith('data:image')) return true;
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (/\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/.test(p)) return true;
    } catch {}
    return (
      url.includes('googleusercontent') ||
      url.includes('googleapis.com') ||
      url.includes('generatedimage') ||
      url.includes('gemini')
    );
  }

  function log(...args) {
    console.log('%c' + TAG, 'color:#8B5CF6;font-weight:700', ...args);
  }

  log('MAIN world interceptors installed');
})();
