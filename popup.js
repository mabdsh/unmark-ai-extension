/**
 * Gemini Watermark Remover v3 — Popup Script
 */
'use strict';

const $  = id => document.getElementById(id);
const enabledCb       = $('enabledCheckbox');
const removeVisibleCb = $('removeVisibleCheckbox');
const removeSynthIDCb = $('removeSynthIDCheckbox');
const notifCb         = $('notifCheckbox');
const statusDot       = $('statusDot');
const statusLabel     = $('statusLabel');
const statTotal       = $('statTotal');
const statSession     = $('statSession');
const methodBtns      = document.querySelectorAll('.method-btn');
const formatPng       = $('formatPng');
const formatJpeg      = $('formatJpeg');
const resetBtn        = $('resetBtn');
const scanBtn         = $('scanBtn');
const imageGrid       = $('imageGrid');
const scanHint        = $('scanHint');

let cfg = {
  enabled: true, removeVisible: true, removeSynthID: true,
  method: 'smart', format: 'png', showNotifications: true,
};

// ── Boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  const [stored, statsData, sessionData] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.sync.get('stats'),
    chrome.runtime.sendMessage({ action: 'getSession' }).catch(() => ({ sessionCount: 0 })),
  ]);
  if (stored.settings) Object.assign(cfg, stored.settings);
  renderCfg();
  renderStats(statsData.stats, sessionData?.sessionCount || 0);
}

function renderCfg() {
  enabledCb.checked       = cfg.enabled;
  removeVisibleCb.checked = cfg.removeVisible;
  removeSynthIDCb.checked = cfg.removeSynthID;
  notifCb.checked         = cfg.showNotifications;
  document.body.classList.toggle('paused', !cfg.enabled);
  setStatus(cfg.enabled);
  methodBtns.forEach(b => b.classList.toggle('active', b.dataset.method === cfg.method));
  formatPng.checked  = cfg.format !== 'jpeg';
  formatJpeg.checked = cfg.format === 'jpeg';
}

function renderStats(stats, session) {
  statTotal.textContent   = (stats?.totalRemoved || 0).toLocaleString();
  statSession.textContent = (session || 0).toLocaleString();
}

function setStatus(on) {
  statusDot.classList.toggle('off', !on);
  statusLabel.textContent = on
    ? 'Active — intercepting downloads'
    : 'Paused — downloads pass through';
}

function save() { chrome.storage.sync.set({ settings: cfg }); }

// ── Controls ───────────────────────────────────────────────────────────────────
enabledCb.addEventListener('change', () => {
  cfg.enabled = enabledCb.checked;
  document.body.classList.toggle('paused', !cfg.enabled);
  setStatus(cfg.enabled);
  save();
  chrome.runtime.sendMessage({ action: 'toggleEnabled', enabled: cfg.enabled }).catch(() => {});
});

removeVisibleCb.addEventListener('change', () => { cfg.removeVisible = removeVisibleCb.checked; save(); });
removeSynthIDCb.addEventListener('change', () => { cfg.removeSynthID = removeSynthIDCb.checked; save(); });
notifCb.addEventListener('change', () => { cfg.showNotifications = notifCb.checked; save(); });

methodBtns.forEach(btn => btn.addEventListener('click', () => {
  cfg.method = btn.dataset.method;
  methodBtns.forEach(b => b.classList.toggle('active', b === btn));
  save();
}));
formatPng.addEventListener('change',  () => { cfg.format = 'png';  save(); });
formatJpeg.addEventListener('change', () => { cfg.format = 'jpeg'; save(); });

resetBtn.addEventListener('click', async () => {
  await chrome.storage.sync.set({ stats: { totalRemoved: 0, lastReset: Date.now() } });
  statTotal.textContent = '0';
  bump(statTotal);
});

// ── Manual Scan ────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', scanPageImages);

async function scanPageImages() {
  scanBtn.disabled    = true;
  scanBtn.textContent = '…';
  imageGrid.style.display = 'none';
  scanHint.textContent    = 'Scanning…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    const isGemini = tab.url?.includes('gemini.google.com') ||
                     tab.url?.includes('aistudio.google.com');
    if (!isGemini) {
      scanHint.textContent = 'Open Gemini or AI Studio first.';
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => typeof window.__GWR_scanImages === 'function'
                      ? window.__GWR_scanImages()
                      : [],
    });

    const images = results?.[0]?.result || [];
    if (images.length === 0) {
      scanHint.textContent = 'No images found. Generate an image in Gemini first.';
      return;
    }

    scanHint.textContent = `Found ${images.length} image${images.length !== 1 ? 's' : ''} — click ↓ Clean to download without watermark`;
    renderImageGrid(images, tab.id);
    imageGrid.style.display = 'grid';
  } catch (e) {
    scanHint.textContent = 'Error: ' + e.message;
  } finally {
    scanBtn.disabled    = false;
    scanBtn.textContent = 'Scan';
  }
}

function renderImageGrid(images, tabId) {
  imageGrid.innerHTML = '';

  images.forEach((img) => {
    const card = document.createElement('div');
    card.className = 'img-card';
    card.title = `${img.width}×${img.height}`;

    const thumb   = document.createElement('img');
    thumb.src     = img.src;
    thumb.loading = 'lazy';

    const overlay = document.createElement('div');
    overlay.className = 'img-card-overlay';

    const info = document.createElement('span');
    info.textContent = `${img.width}×${img.height}`;

    const dlBtn = document.createElement('button');
    dlBtn.textContent = '↓ Clean';

    dlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      // Prevent double-click
      if (dlBtn.disabled) return;
      dlBtn.disabled    = true;
      dlBtn.textContent = '…';

      const ring = document.createElement('div');
      ring.className = 'processing-ring';
      ring.innerHTML  = '<div class="spinner"></div>';
      card.appendChild(ring);

      try {
        const execResult = await chrome.scripting.executeScript({
          target: { tabId },
          func:   (url, name) => {
            if (typeof window.__GWR_processAndDownload !== 'function') {
              return { ok: false, error: 'GWR not loaded — try refreshing the page' };
            }
            return window.__GWR_processAndDownload(url, name);
          },
          args: [img.src, `gemini-clean-${Date.now()}.png`],
        });

        const result = execResult?.[0]?.result;
        ring.remove();

        if (result?.ok) {
          const done      = document.createElement('div');
          done.className  = 'img-done';
          done.textContent = '✓';
          card.appendChild(done);
          dlBtn.textContent = '✓ Done';
        } else {
          dlBtn.textContent = '✗ Failed';
          dlBtn.disabled    = false;
          console.error('[GWR popup]', result?.error);
        }
      } catch (err) {
        ring.remove();
        dlBtn.textContent = '✗ Error';
        dlBtn.disabled    = false;
        console.error('[GWR popup]', err);
      }
    });

    overlay.appendChild(info);
    overlay.appendChild(dlBtn);
    card.appendChild(thumb);
    card.appendChild(overlay);
    imageGrid.appendChild(card);
  });
}

// ── Live updates ───────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.stats?.newValue) {
    statTotal.textContent = (changes.stats.newValue.totalRemoved || 0).toLocaleString();
    bump(statTotal);
  }
});

function bump(el) {
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 300);
}

boot();
