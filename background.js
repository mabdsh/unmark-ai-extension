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

// Tracks how many clean downloads WE triggered via chrome.downloads.download().
// downloads.onCreated must skip exactly this many upcoming download events so it
// doesn't cancel our own processed output. Incremented before calling
// chrome.downloads.download(), decremented in onCreated when we skip one.
let pendingCleanDownloads = 0;

// Cache whether a Gemini tab is currently the active tab.
// Used to synchronously pre-cancel blob:null downloads (which have no origin
// we can check synchronously) before any async await introduces race-condition
// delays. Updated by tab focus / navigation events.
let geminiTabActive = false;

function updateGeminiTabActive(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    geminiTabActive = GEMINI_HOSTS.some(h => (tab.url || '').includes(h));
  });
}

chrome.tabs.onActivated.addListener((info) => updateGeminiTabActive(info.tabId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && change.url) updateGeminiTabActive(tabId);
});

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

    // Skip our own clean downloads (tracked by counter — see downloadClean handler)
    if (pendingCleanDownloads > 0) {
      pendingCleanDownloads--;
      console.log('[UAI bg] skipping own clean download, remaining pending:', pendingCleanDownloads);
      return;
    }

    // Skip our own data: URL outputs (belt-and-suspenders with the counter above)
    if (item.url.startsWith('data:')) return;

    // ── v3.6 RACE-CONDITION FIX ──────────────────────────────────────────────
    // Blob downloads (the most common Gemini download type) complete nearly
    // instantly — the blob is already in memory, just needs to be written to disk.
    // Any await before chrome.downloads.cancel() gives enough time for the file
    // to be fully saved, making the cancel a no-op.
    //
    // Fix: detect Gemini blob downloads SYNCHRONOUSLY and cancel IMMEDIATELY
    // before the first await.
    //   • blob:https://gemini.google.com/uuid → detected by URL alone
    //   • blob:null/uuid (sandboxed iframe) → URL has no origin, use the
    //     cached geminiTabActive flag which is kept current by tab listeners
    const isKnownGeminiBlob = item.url.startsWith('blob:') &&
      GEMINI_HOSTS.some(h => item.url.includes(h));
    const isNullOriginBlobOnGemini = item.url.startsWith('blob:null') && geminiTabActive;
    const shouldPreCancel = isKnownGeminiBlob || isNullOriginBlobOnGemini;

    if (shouldPreCancel) {
      chrome.downloads.cancel(item.id).catch(() => {}); // fire-and-forget, no await
      console.log('[UAI bg] synchronous pre-cancel for Gemini blob:', item.id,
        isNullOriginBlobOnGemini ? '(blob:null)' : '(known origin)');
    }
    // ── end race-condition fix ────────────────────────────────────────────────

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

    // For non-blob downloads (HTTPS), cancel here (after async checks)
    // For blob downloads we already cancelled synchronously above
    if (!shouldPreCancel) {
      await chrome.downloads.cancel(item.id).catch(() => {});
    }
    // Erase from the downloads shelf so the user doesn't see a cancelled entry
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

    // v3.6: content.js sends processed image data here.
    // chrome.downloads.download() is used instead of <a> click in main-world
    // because: (1) it doesn't need a user gesture, (2) we can track it with
    // pendingCleanDownloads so onCreated doesn't cancel our own output.
    case 'downloadClean': {
      pendingCleanDownloads++;
      chrome.downloads.download(
        {
          url:            msg.dataUrl,
          filename:       msg.filename,
          saveAs:         false,
          conflictAction: 'uniquify',
        },
        (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            // Download never created — undo the counter increment so we don't
            // skip a future real Gemini download by mistake.
            pendingCleanDownloads = Math.max(0, pendingCleanDownloads - 1);
            sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'Download failed to start' });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
      return true; // keep channel open for async callback
    }

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