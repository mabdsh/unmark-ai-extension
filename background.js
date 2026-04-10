/**
 * UnmarkAI v3.3 — Background Service Worker
 *
 * TWO INTERCEPTION PATHS:
 *   PRIMARY  — main-world.js prototype overrides (JS-level, instant)
 *   FALLBACK — downloads.onCreated (catches ALL Chrome downloads including
 *              direct URL downloads that bypass JS prototype overrides)
 *
 * DEDUPLICATION: processedUrls Map prevents both paths from firing on the
 * same download, which would produce a double-download for the user.
 *
 * CHANGES v3.3 → v3.4 (direct-download fix):
 *   ROOT CAUSE FIX: downloads.onCreated fallback now calls
 *   chrome.downloads.cancel(item.id) immediately, preventing the watermarked
 *   file from landing on disk before we finish processing.
 *   Previously the original download always completed — users got the
 *   watermarked file even when our fallback ran successfully.
 *
 *   RELIABILITY FIX: replaced referrer-based Gemini detection with an
 *   open-Gemini-tab check. Chrome does not always populate item.referrer
 *   for blob: downloads (there's no HTTP request, so no Referer header),
 *   causing the old isFromGemini() to return false and skip the fallback
 *   entirely for the most common Gemini download type.
 */
'use strict';

const GEMINI_HOSTS  = ['gemini.google.com', 'aistudio.google.com'];
const ACCENT        = '#8B5CF6';
const GRAY          = '#6B7280';

let sessionCount = 0;

// ── URL lock registry ─────────────────────────────────────────────────────
// Entries auto-expire after 30 s so stale locks never block future downloads.
const processedUrls = new Map(); // url → expiry timestamp

function lockUrl(url) {
  processedUrls.set(url, Date.now() + 30_000);
}
function isLocked(url) {
  const exp = processedUrls.get(url);
  if (!exp) return false;
  if (Date.now() > exp) { processedUrls.delete(url); return false; }
  return true;
}
function unlockUrl(url) { processedUrls.delete(url); }

// ── Install ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  await chrome.storage.sync.set({
    settings: {
      enabled:           true,
      removeVisible:     true,
      removeSynthID:     true,
      method:            'smart',
      format:            'png',
      jpegQuality:       0.96,
      showNotifications: true,
    },
    stats: { totalRemoved: 0, lastReset: Date.now() },
  });
  setBadge('ON', ACCENT);
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  sessionCount = 0;
  setupContextMenu();
  chrome.storage.sync.get('settings', ({ settings }) =>
    updateBadge(settings?.enabled !== false)
  );
});

// ── Context Menu ─────────────────────────────────────────────────────────────
function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:                  'uai-clean-download',
      title:               '✦ UnmarkAI — Clean & Download',
      contexts:            ['image'],
      documentUrlPatterns: [
        'https://gemini.google.com/*',
        'https://aistudio.google.com/*',
      ],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'uai-clean-download' || !info.srcUrl) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func:   (url) => window.__UAI_processAndDownload?.(url, 'unmark-ai-clean.png'),
    args:   [info.srcUrl],
  }).catch(console.error);
});

// ── FALLBACK: downloads.onCreated ────────────────────────────────────────────
// Fires for every Chrome download. Acts as the safety net when main-world.js
// fails to intercept (e.g. if the page was loaded before the extension).
//
// v3.4 ROOT CAUSE FIX:
//   1. Immediately cancels the original download so the watermarked file never
//      lands on disk — this was missing before and caused users to always receive
//      the watermarked version even when our fallback processing succeeded.
//   2. Detects "from Gemini" by checking whether ANY Gemini tab is currently
//      open, rather than checking item.referrer. Chrome does not populate
//      referrer for blob: downloads (no HTTP request = no Referer header), so
//      the old isFromGemini() silently returned false for most Gemini downloads.
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    if (!item?.url) return;

    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings?.enabled) return;

    // Skip our own clean-download data URLs
    if (item.url.startsWith('data:')) return;

    // Only process images (by MIME or by URL extension)
    const isImage =
      (item.mime || '').startsWith('image/') ||
      /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.url);
    if (!isImage) return;

    // v3.4 FIX: check for an open Gemini tab instead of relying on referrer.
    // This is reliable for all download types (blob:, https:, data:).
    const geminiTabs = await chrome.tabs.query({
      url: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    }).catch(() => []);
    if (!geminiTabs.length) return;

    // Skip if already handled by main-world.js primary path
    if (isLocked(item.url)) {
      console.log('[UAI bg] fallback skipped — primary already handled:', item.url.slice(0, 80));
      return;
    }

    lockUrl(item.url);
    console.log('[UAI bg] fallback intercept:', item.url.slice(0, 80));

    // v3.4 FIX: cancel the original download IMMEDIATELY so the watermarked
    // file is never written to disk. Do this before the async processing below.
    await chrome.downloads.cancel(item.id).catch(() => {});
    // Erase it from the downloads shelf so the user doesn't see a cancelled entry
    await chrome.downloads.erase({ id: item.id }).catch(() => {});

    // Use the active Gemini tab for processing, fall back to any Gemini tab
    const tab = geminiTabs.find(t => t.active) || geminiTabs[0];

    // Build a clean output filename from whatever Chrome recorded
    const orig  = (item.filename || 'gemini-image').split(/[/\\]/).pop();
    const clean = orig.replace(/(\.[a-z]+)?$/i, '-clean.png');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (url, fname) => {
        if (typeof window.__UAI_processAndDownload !== 'function') {
          return { ok: false, error: 'UnmarkAI not loaded — refresh the Gemini page' };
        }
        return window.__UAI_processAndDownload(url, fname);
      },
      args: [item.url, clean],
    }).catch(e => [{ result: { ok: false, error: e.message } }]);

    const result = results?.[0]?.result;
    if (result?.ok === false) {
      console.warn('[UAI bg] fallback processing failed:', result.error);
    }

    unlockUrl(item.url);
  } catch (e) {
    console.error('[UAI bg] fallback error (silent):', e.message);
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    case 'lockUrl':
      lockUrl(msg.url);
      sendResponse({ ok: true });
      return false;

    case 'fetchImage':
      fetch(msg.url, { credentials: 'include', cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const mime = r.headers.get('content-type') || 'image/png';
          return r.arrayBuffer().then(buf => ({ buf, mime }));
        })
        .then(({ buf, mime }) =>
          sendResponse({
            buffer:   Array.from(new Uint8Array(buf)),
            mimeType: mime,
          })
        )
        .catch(err => sendResponse({ error: err.message }));
      return true; // keep channel open for async response

    case 'watermarkRemoved':
      sessionCount++;
      chrome.storage.sync.get('stats', ({ stats }) => {
        chrome.storage.sync.set({
          stats: {
            totalRemoved: (stats?.totalRemoved || 0) + 1,
            lastReset:    stats?.lastReset || Date.now(),
          },
        });
      });
      updateBadgeCount();
      sendResponse({ ok: true, sessionCount });
      return false;

    case 'toggleEnabled':
      chrome.storage.sync.get('settings', ({ settings }) => {
        chrome.storage.sync.set(
          { settings: { ...settings, enabled: msg.enabled } },
          () => { updateBadge(msg.enabled); sendResponse({ ok: true }); }
        );
      });
      return true;

    case 'getSession':
      sendResponse({ sessionCount });
      return false;
  }
});

// ── Badge Helpers ─────────────────────────────────────────────────────────────
function updateBadge(on) {
  setBadge(on ? 'ON' : 'OFF', on ? ACCENT : GRAY);
}
function updateBadgeCount() {
  if (sessionCount > 0) {
    setBadge(sessionCount > 99 ? '99+' : String(sessionCount), ACCENT);
  }
}
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}