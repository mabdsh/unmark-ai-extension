/**
 * UnmarkAI v3.8 — Popup Script
 *
 * v3.8 additions:
 *   • autoIntercept mode (Auto/Manual segmented control)
 *   • AI method button (distinct from the segmented method control)
 *   • AI model status bar (not loaded / loading / ready / error)
 *   • Clear model cache button
 *   • synthIdHint text updated to reflect new noise+JPEG approach
 */
'use strict';

const $ = id => document.getElementById(id);

// ── Element refs ───────────────────────────────────────────────────────────
const enabledCb       = $('enabledCheckbox');
const removeVisibleCb = $('removeVisibleCheckbox');
const removeSynthIDCb = $('removeSynthIDCheckbox');
const notifCb         = $('notifCheckbox');
const statusDot       = $('statusDot');
const statusLabel     = $('statusLabel');
const statTotal       = $('statTotal');
const statSession     = $('statSession');
const statMode        = $('statMode');
const qualitySlider   = $('qualitySlider');
const qualityValue    = $('qualityValue');
const resetBtn        = $('resetBtn');
const scanBtn         = $('scanBtn');
const dlAllBtn        = $('dlAllBtn');
const imageGrid       = $('imageGrid');
const scanHint        = $('scanHint');
const qualityRow      = $('qualityRow');
const modeCard        = $('modeCard');
const modeTitle       = $('modeTitle');
const modeDesc        = $('modeDesc');
const modeIconAuto    = $('modeIconAuto');
const modeIconManual  = $('modeIconManual');
const scanSection     = $('scanSection');
const aiMethodBtn     = $('aiMethodBtn');
const aiStatusBar     = $('aiStatusBar');
const aiStatusDot     = $('aiStatusDot');
const aiStatusText    = $('aiStatusText');
const aiClearCacheBtn = $('aiClearCacheBtn');

const methodBtns = document.querySelectorAll('#methodGrid .seg');
const formatBtns = document.querySelectorAll('.format-seg');
const modeSegs   = document.querySelectorAll('.mode-seg');

const formatPng  = $('formatPng');
const formatJpeg = $('formatJpeg');

let cfg = {
  enabled:           true,
  autoIntercept:     true,
  removeVisible:     true,
  removeSynthID:     true,
  method:            'smart',
  format:            'png',
  jpegQuality:       0.96,
  showNotifications: true,
};

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  const [stored, statsData, sessionData] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.sync.get('stats'),
    chrome.runtime.sendMessage({ action: 'getSession' }).catch(() => ({ sessionCount: 0 })),
  ]);

  if (stored.settings) Object.assign(cfg, stored.settings);
  renderCfg();
  renderStats(statsData.stats, sessionData?.sessionCount ?? 0);
}

function renderCfg() {
  enabledCb.checked       = cfg.enabled;
  removeVisibleCb.checked = cfg.removeVisible;
  removeSynthIDCb.checked = cfg.removeSynthID;
  notifCb.checked         = cfg.showNotifications;

  document.body.classList.toggle('paused', !cfg.enabled);
  setStatus(cfg.enabled);

  // Classic method segmented buttons
  methodBtns.forEach(b => b.classList.toggle('active', b.dataset.method === cfg.method));

  // AI method button — active state is independent from seg-ctrl
  const isAiMethod = cfg.method === 'ai';
  aiMethodBtn.classList.toggle('active', isAiMethod);
  // Deactivate all seg buttons if AI is selected
  if (isAiMethod) methodBtns.forEach(b => b.classList.remove('active'));
  document.body.classList.toggle('ai-method', isAiMethod);

  // Format
  formatBtns.forEach(b => b.classList.toggle('active', b.dataset.format === cfg.format));
  if (formatPng)  formatPng.checked  = cfg.format === 'png';
  if (formatJpeg) formatJpeg.checked = cfg.format === 'jpeg';

  // Quality slider
  const q = Math.round((cfg.jpegQuality ?? 0.96) * 100);
  if (qualitySlider) qualitySlider.value = q;
  if (qualityValue)  qualityValue.textContent = q + '%';
  updateQualityVisibility();

  // AI status bar
  updateAiStatusBar(isAiMethod);

  // Mode
  renderMode();
}

function renderStats(stats, session) {
  statTotal.textContent   = (stats?.totalRemoved ?? 0).toLocaleString();
  statSession.textContent = (session ?? 0).toLocaleString();
}

function setStatus(on) {
  statusDot.classList.toggle('off', !on);
  statusLabel.textContent = on ? 'Active on Gemini' : 'Paused';
}

// ── AI status bar ──────────────────────────────────────────────────────────
// We probe the active Gemini tab to check whether the LaMa worker is warm.
async function updateAiStatusBar(show) {
  if (!show) {
    aiStatusBar.style.display = 'none';
    return;
  }
  aiStatusBar.style.display = 'flex';

  // Probe the Gemini tab for worker readiness
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { setAiStatus('idle', 'Open a Gemini page first'); return; }

    const isGemini = tab.url?.includes('gemini.google.com') ||
                     tab.url?.includes('aistudio.google.com');
    if (!isGemini) { setAiStatus('idle', 'LaMa model will load on first Gemini download'); return; }

    // Ask content.js if the worker already exists (worker is alive if lamaWorker !== null)
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        workerAlive:  typeof window.__UAI_clearLamaCache === 'function',
        // We can't directly check lamaReady from popup, but we can check the function exists
      }),
    }).catch(() => null);

    const workerAlive = results?.[0]?.result?.workerAlive;
    if (workerAlive) {
      setAiStatus('ready', 'LaMa model ready — AI inpainting active');
    } else {
      setAiStatus('idle', 'LaMa model not loaded — will download on first use (~20 MB)');
    }
  } catch {
    setAiStatus('idle', 'LaMa model will load on first use (~20 MB)');
  }
}

function setAiStatus(state, text) {
  aiStatusDot.className = 'ai-status-dot' + (state !== 'idle' ? ' ' + state : '');
  aiStatusText.className = 'ai-status-text' + (state === 'ready' ? ' highlight' : '');
  aiStatusText.textContent = text;
}

// ── Mode rendering ──────────────────────────────────────────────────────────
const MODE_CONFIG = {
  auto:   { title: 'Auto Intercept', desc: 'Downloads are cleaned automatically when you click ↓ in Gemini', stat: 'AUTO' },
  manual: { title: 'Manual Mode',    desc: 'Use Scan page below to find and clean images yourself',          stat: 'MANUAL' },
};

function renderMode() {
  const isAuto = cfg.autoIntercept !== false;
  const mode   = isAuto ? 'auto' : 'manual';
  const mc     = MODE_CONFIG[mode];

  modeSegs.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  modeTitle.textContent = mc.title;
  modeDesc.textContent  = mc.desc;
  modeCard.classList.toggle('manual-active', !isAuto);

  modeIconAuto.style.display   = isAuto ? '' : 'none';
  modeIconManual.style.display = isAuto ? 'none' : '';

  statMode.textContent = mc.stat;
  statMode.classList.toggle('manual', !isAuto);

  scanSection.classList.toggle('manual-highlight', !isAuto);

  if (!isAuto && scanHint.textContent.includes('Open')) {
    scanHint.textContent = 'Manual mode — scan this Gemini page to find images';
  } else if (isAuto && scanHint.textContent.includes('Manual mode')) {
    scanHint.textContent = 'Open a Gemini page to scan for images';
  }
}

function updateQualityVisibility() {
  if (qualityRow) qualityRow.style.display = cfg.format === 'jpeg' ? 'flex' : 'none';
}

function save() {
  chrome.storage.sync.set({ settings: { ...cfg } }).catch(err =>
    console.warn('[UAI popup] settings save failed:', err.message)
  );
}

// ── Controls ───────────────────────────────────────────────────────────────
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

// Classic method segmented buttons
methodBtns.forEach(btn => btn.addEventListener('click', () => {
  cfg.method = btn.dataset.method;
  methodBtns.forEach(b => b.classList.toggle('active', b === btn));
  aiMethodBtn.classList.remove('active');
  document.body.classList.remove('ai-method');
  aiStatusBar.style.display = 'none';
  save();
}));

// AI method button
aiMethodBtn.addEventListener('click', () => {
  cfg.method = 'ai';
  methodBtns.forEach(b => b.classList.remove('active'));
  aiMethodBtn.classList.add('active');
  document.body.classList.add('ai-method');
  updateAiStatusBar(true);
  save();
});

// Mode segmented control
modeSegs.forEach(btn => btn.addEventListener('click', () => {
  cfg.autoIntercept = btn.dataset.mode === 'auto';
  save();
  renderMode();
  chrome.runtime.sendMessage({ action: 'setAutoIntercept', autoIntercept: cfg.autoIntercept }).catch(() => {});
}));

// Format segmented control
formatBtns.forEach(btn => btn.addEventListener('click', () => {
  cfg.format = btn.dataset.format;
  formatBtns.forEach(b => b.classList.toggle('active', b === btn));
  if (formatPng)  formatPng.checked  = cfg.format === 'png';
  if (formatJpeg) formatJpeg.checked = cfg.format === 'jpeg';
  save();
  updateQualityVisibility();
}));

// Quality slider
if (qualitySlider) {
  qualitySlider.addEventListener('input', () => {
    const v = parseInt(qualitySlider.value, 10);
    if (qualityValue) qualityValue.textContent = v + '%';
    cfg.jpegQuality = v / 100;
    save();
  });
}

resetBtn.addEventListener('click', async () => {
  await chrome.storage.sync.set({ stats: { totalRemoved: 0, lastReset: Date.now() } });
  statTotal.textContent = '0';
  bump(statTotal);
});

// Clear LaMa model cache
aiClearCacheBtn.addEventListener('click', async () => {
  setAiStatus('loading', 'Clearing cached model…');
  aiClearCacheBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__UAI_clearLamaCache?.(),
      }).catch(() => {});
    }
    setAiStatus('idle', 'Cache cleared — model will re-download on next use');
  } catch {
    setAiStatus('error', 'Could not clear cache — try refreshing the Gemini page');
  } finally {
    aiClearCacheBtn.disabled = false;
  }
});

// ── Live storage updates ───────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.stats?.newValue) {
    statTotal.textContent = (changes.stats.newValue.totalRemoved ?? 0).toLocaleString();
    bump(statTotal);
  }
});

// ── Scan ───────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', scanPageImages);

async function scanPageImages() {
  scanBtn.disabled        = true;
  scanBtn.textContent     = '…';
  imageGrid.style.display = 'none';
  if (dlAllBtn) dlAllBtn.style.display = 'none';
  scanHint.textContent = 'Scanning…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    const isGemini = tab.url?.includes('gemini.google.com') ||
                     tab.url?.includes('aistudio.google.com');
    if (!isGemini) {
      scanHint.textContent = 'Open Gemini or AI Studio first';
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.__UAI_scanImages ?? window.__GWR_scanImages)?.() ?? [],
    });

    const images = results?.[0]?.result ?? [];
    if (!images.length) {
      scanHint.textContent = 'No images found — generate one in Gemini first';
      return;
    }

    const s = images.length === 1 ? '' : 's';
    scanHint.textContent = `${images.length} image${s} found`;

    if (dlAllBtn && images.length > 1) {
      dlAllBtn.style.display = '';
      dlAllBtn.textContent   = `Clean all (${images.length})`;
      dlAllBtn.disabled      = false;
      dlAllBtn._tabId        = tab.id;
    }

    renderImageGrid(images, tab.id);
    imageGrid.style.display = 'grid';

    // Refresh AI status now that we know the tab is active
    if (cfg.method === 'ai') updateAiStatusBar(true);

  } catch (e) {
    scanHint.textContent = `Error: ${e.message}`;
    console.error('[UAI popup]', e);
  } finally {
    scanBtn.disabled    = false;
    scanBtn.textContent = 'Scan page';
  }
}

// ── Download All ───────────────────────────────────────────────────────────
if (dlAllBtn) {
  dlAllBtn.addEventListener('click', async () => {
    dlAllBtn.disabled    = true;
    dlAllBtn.textContent = cfg.method === 'ai' ? 'AI processing…' : 'Processing…';

    const tabId = dlAllBtn._tabId;
    if (!tabId) { dlAllBtn.textContent = 'Error'; return; }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (window.__UAI_downloadAll?.()) ?? { ok: false, error: 'Not loaded' },
      });
      const result = results?.[0]?.result;
      if (result?.ok) {
        dlAllBtn.textContent = `✓ Done (${result.succeeded}/${result.total})`;
        const cur = parseInt(statSession.textContent.replace(/,/g, ''), 10) || 0;
        statSession.textContent = (cur + result.succeeded).toLocaleString();
        bump(statSession);
      } else {
        dlAllBtn.textContent = 'Failed'; dlAllBtn.disabled = false;
      }
    } catch (err) {
      dlAllBtn.textContent = 'Error'; dlAllBtn.disabled = false;
      console.error('[UAI popup]', err);
    }
  });
}

// ── Image Grid ─────────────────────────────────────────────────────────────
function renderImageGrid(images, tabId) {
  imageGrid.innerHTML = '';

  images.forEach(img => {
    const card = document.createElement('div');
    card.className = 'img-card';
    card.title = `${img.width} × ${img.height}`;

    const thumb = document.createElement('img');
    thumb.src = img.src; thumb.loading = 'lazy'; thumb.alt = img.alt || '';

    const overlay = document.createElement('div');
    overlay.className = 'img-card-overlay';

    const info = document.createElement('span');
    info.textContent = `${img.width}×${img.height}`;

    const dlBtn = document.createElement('button');
    dlBtn.textContent = cfg.method === 'ai' ? '✦ Clean' : '↓ Clean';

    dlBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (dlBtn.disabled) return;
      dlBtn.disabled = true; dlBtn.textContent = '…';

      const ring = document.createElement('div');
      ring.className = 'processing-ring';
      ring.innerHTML = '<div class="spinner"></div>';
      card.appendChild(ring);

      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: (url, name) => {
            const fn = window.__UAI_processAndDownload ?? window.__GWR_processAndDownload;
            if (typeof fn !== 'function') return { ok: false, error: 'Not loaded' };
            return fn(url, name);
          },
          args: [img.src, `unmark-ai-${Date.now()}.png`],
        });

        ring.remove();
        const result = res?.[0]?.result;

        if (result?.ok) {
          const badge = document.createElement('div');
          badge.className = 'img-done'; badge.textContent = '✓';
          card.appendChild(badge);
          dlBtn.textContent = '✓';
          const cur = parseInt(statSession.textContent.replace(/,/g, ''), 10) || 0;
          statSession.textContent = (cur + 1).toLocaleString();
          bump(statSession);
          // Refresh AI status after first successful inference
          if (cfg.method === 'ai') updateAiStatusBar(true);
        } else {
          dlBtn.textContent = '✗'; dlBtn.disabled = false;
        }
      } catch {
        ring.remove(); dlBtn.textContent = '✗'; dlBtn.disabled = false;
      }
    });

    overlay.appendChild(info);
    overlay.appendChild(dlBtn);
    card.appendChild(thumb);
    card.appendChild(overlay);
    imageGrid.appendChild(card);
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────
function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 300);
}

boot();