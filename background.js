/**
 * UnmarkAI v3.2 — Background Service Worker
 *
 * TWO INTERCEPTION PATHS:
 *   PRIMARY  — main-world.js prototype overrides (JS-level, instant)
 *   FALLBACK — downloads.onCreated (catches ALL Chrome downloads including
 *              direct URL downloads that bypass JS prototype overrides)
 *
 * DEDUPLICATION: processedUrls Set prevents both paths from firing on the
 * same download, which would produce a double-download for the user.
 */
'use strict';

const GEMINI_HOSTS  = ['gemini.google.com', 'aistudio.google.com'];
const ACCENT        = '#8B5CF6';
const GRAY          = '#6B7280';

let sessionCount = 0;

// Track URLs currently being processed to prevent double-download.
// Entries are auto-expired after 30 s so stale locks never block future downloads.
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
// Fires for every Chrome download. Filtered to Gemini images only.
// Skipped when main-world.js already intercepted the same URL (via processedUrls lock).
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings?.enabled) return;

    // Skip our own clean-download data URLs — they start with data:
    if (item.url.startsWith('data:')) return;

    // Only process image MIME types or clear image URL patterns
    const isImage =
      (item.mime || '').startsWith('image/') ||
      /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.url);
    if (!isImage) return;

    // Only from Gemini / AI Studio
    const fromGemini = GEMINI_HOSTS.some(
      h => item.referrer?.includes(h) || item.url?.includes(h)
    );
    if (!fromGemini) return;

    // Skip if already handled by main-world.js primary path
    if (isLocked(item.url)) {
      console.log('[UAI bg] fallback skipped — primary already handled:', item.url.slice(0, 80));
      return;
    }

    lockUrl(item.url);
    console.log('[UAI bg] fallback intercept:', item.url.slice(0, 80));

    // Find an open Gemini tab to run processing in
    const tabs = await chrome.tabs.query({
      url: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    }).catch(() => []);

    const tab = tabs.find(t => t.active) || tabs[0];
    if (!tab) {
      console.warn('[UAI bg] No Gemini tab found for fallback processing');
      unlockUrl(item.url);
      return;
    }

    // Build a clean output filename
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
