/**
 * Gemini Watermark Remover v3.2 — Background Service Worker
 *
 * TWO INTERCEPTION PATHS:
 *   PRIMARY  — main-world.js prototype overrides (JS-level, instant)
 *   FALLBACK — downloads.onCreated (catches ALL Chrome downloads including
 *              direct URL downloads that bypass JS prototype overrides)
 */
'use strict';

const GEMINI_HOSTS = ['gemini.google.com', 'aistudio.google.com'];
const ACCENT = '#8B5CF6';
const GRAY   = '#6B7280';
let sessionCount = 0;

// ── Install ────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  await chrome.storage.sync.set({
    settings: { enabled:true, removeVisible:true, removeSynthID:true,
                method:'smart', format:'png', showNotifications:true },
    stats: { totalRemoved:0, lastReset:Date.now() },
  });
  setBadge('ON', ACCENT);
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  sessionCount = 0;
  setupContextMenu();
  chrome.storage.sync.get('settings', ({ settings }) => updateBadge(settings?.enabled !== false));
});

// ── Context Menu ───────────────────────────────────────────────────────────────
function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'gwr-clean-download', title: '💎 Clean & Download (remove watermark)',
      contexts: ['image'],
      documentUrlPatterns: ['https://gemini.google.com/*','https://aistudio.google.com/*'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'gwr-clean-download' || !info.srcUrl) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (url) => window.__GWR_processAndDownload?.(url, 'gemini-clean.png'),
    args: [info.srcUrl],
  }).catch(console.error);
});

// ── FALLBACK: downloads.onCreated ─────────────────────────────────────────────
// Fires for every Chrome download. We filter to Gemini images only.
// This catches cases where main-world.js didn't intercept (e.g. page not refreshed,
// or Gemini uses a download mechanism other than programmatic <a> click).
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings?.enabled) return;

    // Skip our own clean-download data URLs to avoid loops
    if (item.url.startsWith('data:')) return;

    // Only image MIME types or clear image URL patterns
    const isImage = (item.mime || '').startsWith('image/') ||
                    /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.url);
    if (!isImage) return;

    // Only from Gemini / AI Studio (check referrer or URL)
    const fromGemini = GEMINI_HOSTS.some(h =>
      item.referrer?.includes(h) || item.url?.includes(h)
    );
    if (!fromGemini) return;

    console.log('[GWR bg] fallback intercept:', item.url.slice(0, 100));

    // Find the open Gemini tab to run processing in
    const tabs = await chrome.tabs.query({
      url: ['https://gemini.google.com/*','https://aistudio.google.com/*'],
    }).catch(() => []);

    const tab = tabs.find(t => t.active) || tabs[0];
    if (!tab) { console.warn('[GWR bg] No Gemini tab found'); return; }

    // Build output filename
    const orig = (item.filename || 'Gemini_Generated_Image').split(/[/\\]/).pop();
    const clean = orig.replace(/(\.[a-z]+)?$/i, '-clean.png');

    // Execute processing in page context (content.js isolated world has fetch access to blobs)
    // __GWR_processAndDownload: fetches url, processes canvas, posts GWR_DOWNLOAD to main-world
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (url, fname) => {
        if (typeof window.__GWR_processAndDownload !== 'function') {
          return { ok: false, error: 'GWR not loaded — refresh the Gemini page' };
        }
        return window.__GWR_processAndDownload(url, fname);
      },
      args: [item.url, clean],
    }).catch(e => [{ result: { ok: false, error: e.message } }]);

    const result = results?.[0]?.result;
    if (result?.ok === false) {
      console.warn('[GWR bg] fallback processing failed:', result.error);
    }

  } catch (e) {
    console.error('[GWR bg] fallback error (silent):', e.message);
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    case 'fetchImage':
      fetch(msg.url, { credentials:'include', cache:'no-store' })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const mime = r.headers.get('content-type') || 'image/png';
          return r.arrayBuffer().then(buf => ({ buf, mime }));
        })
        .then(({ buf, mime }) =>
          sendResponse({ buffer: Array.from(new Uint8Array(buf)), mimeType: mime })
        )
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'watermarkRemoved':
      sessionCount++;
      chrome.storage.sync.get('stats', ({ stats }) => {
        chrome.storage.sync.set({ stats: {
          totalRemoved: (stats?.totalRemoved||0)+1,
          lastReset: stats?.lastReset||Date.now(),
        }});
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

function updateBadge(on) { setBadge(on?'ON':'OFF', on?ACCENT:GRAY); }
function updateBadgeCount() { if(sessionCount>0) setBadge(sessionCount>99?'99+':String(sessionCount),ACCENT); }
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
