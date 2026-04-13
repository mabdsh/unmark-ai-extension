/**
 * UnmarkAI v4.0 — Popup Script (Production)
 *
 * Model states: idle → downloading (0–100%) → loading → ready | error
 * Auto-clean: cfg.autoIntercept — toggle exposed to user
 * Live updates: Port('uai-popup') pushes model state in real time
 */
'use strict';

const $ = id => document.getElementById(id);

// ── Refs ───────────────────────────────────────────────────────────────────
const enabledCb      = $('enabledCheckbox');
const autoCleanCb    = $('autoCleanCheckbox');
const autoCleanSub   = $('autoCleanSub');
const statusDot      = $('statusDot');
const statusLabel    = $('statusLabel');
const statTotal      = $('statTotal');
const statSession    = $('statSession');
const resetBtn       = $('resetBtn');
const scanBtn        = $('scanBtn');
const dlAllBtn       = $('dlAllBtn');
const imageGrid      = $('imageGrid');
const scanHint       = $('scanHint');
const modelStatus    = $('modelStatus');
const modelStatusInner = $('modelStatusInner');
const dlNotice       = $('dlNotice');
const dlNoticeBar    = $('dlNoticeBar');
const dlNoticeText   = $('dlNoticeText');
const pillAiBadge    = $('pillAiBadge');
const methodPills    = document.querySelectorAll('.method-pill');

// ── Config ─────────────────────────────────────────────────────────────────
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

// ── Model state ────────────────────────────────────────────────────────────
let modelState = { status: 'unknown', progress: 0, error: null };
let bgPort     = null;

function connectBgPort() {
  try {
    bgPort = chrome.runtime.connect({ name: 'uai-popup' });
    bgPort.onMessage.addListener(msg => {
      if (msg.type !== 'modelStatus') return;
      const prev = modelState.status;
      modelState = { status: msg.status, progress: msg.progress || 0, error: msg.error || null };
      if (cfg.method === 'ai') {
        renderModelStatus();
        updateDownloadNotice();
        updatePillBadge();
      }
      // Refresh grid buttons when model becomes ready
      if (msg.status === 'ready' && prev !== 'ready') refreshGridButtons();
    });
    bgPort.onDisconnect.addListener(() => { bgPort = null; });
  } catch {}
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  connectBgPort();

  const [stored, statsData, sessionData] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.sync.get('stats'),
    chrome.runtime.sendMessage({ action: 'getSession' }).catch(() => ({ sessionCount: 0 })),
  ]);

  if (stored.settings) Object.assign(cfg, stored.settings);

  // Force optimal hidden settings
  cfg.removeVisible     = true;
  cfg.removeSynthID     = true;
  cfg.showNotifications = true;
  cfg.format            = 'png';

  renderCfg();
  renderStats(statsData.stats, sessionData?.sessionCount ?? 0);

  // Auto-scan on Gemini pages
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('gemini.google.com') || tab?.url?.includes('aistudio.google.com')) {
      setTimeout(scanPageImages, 200);
    }
  } catch {}
}

function renderCfg() {
  enabledCb.checked    = cfg.enabled;
  autoCleanCb.checked  = cfg.autoIntercept !== false;
  document.body.classList.toggle('paused', !cfg.enabled);
  document.body.classList.toggle('manual-mode', !cfg.autoIntercept);
  setStatus(cfg.enabled);
  updateAutoCleanSub();

  methodPills.forEach(p => p.classList.toggle('active', p.dataset.method === cfg.method));

  if (cfg.method === 'ai') {
    modelStatus.style.display = '';
    checkModelAndWarm();
  } else {
    modelStatus.style.display = 'none';
    dlNotice.style.display    = 'none';
    pillAiBadge.style.display = 'none';
  }
}

function renderStats(stats, session) {
  statTotal.textContent   = (stats?.totalRemoved ?? 0).toLocaleString();
  statSession.textContent = (session ?? 0).toLocaleString();
}

function setStatus(on) {
  statusDot.classList.toggle('off', !on);
  statusLabel.textContent = on ? 'Active on Gemini' : 'Paused';
}

function updateAutoCleanSub() {
  autoCleanSub.textContent = cfg.autoIntercept
    ? 'Removes watermarks automatically when you click ↓ in Gemini'
    : 'Auto-clean is off — use Scan page below to clean images manually';
}

function save() { chrome.storage.sync.set({ settings: { ...cfg } }).catch(() => {}); }

// ── Model management ───────────────────────────────────────────────────────
async function checkModelAndWarm() {
  try {
    const s = await chrome.runtime.sendMessage({ action: 'getModelStatus' }).catch(() => null);
    if (s) modelState = { status: s.status || 'unknown', progress: s.progress || 0, error: s.error || null };
  } catch {}

  renderModelStatus();
  updateDownloadNotice();
  updatePillBadge();

  if (modelState.status === 'idle' || modelState.status === 'unknown') {
    chrome.runtime.sendMessage({ action: 'preWarmModel' }).catch(() => {});
  }
}

function renderModelStatus() {
  const { status, progress, error } = modelState;
  const ms = modelStatus;

  // Reset state classes
  ms.className = 'model-status';

  if (status === 'downloading') {
    const pct = Math.min(99, progress || 0);
    ms.classList.add('ms-state-downloading');
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-spinner"></div>
        <div class="ms-text-wrap">
          <span class="ms-title">Downloading AI model — ${pct}%</span>
          <span class="ms-sub">One-time download · Saved permanently after this</span>
        </div>
      </div>
      <div class="ms-progress">
        <div class="ms-progress-fill" style="width:${pct}%"></div>
      </div>`;

  } else if (status === 'loading') {
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-spinner"></div>
        <div class="ms-text-wrap">
          <span class="ms-title">Setting up AI engine…</span>
          <span class="ms-sub">Almost ready — this only takes a few seconds</span>
        </div>
      </div>
      <div class="ms-progress">
        <div class="ms-progress-fill indeterminate" style="width:40%"></div>
      </div>`;

  } else if (status === 'ready') {
    ms.classList.add('ms-state-ready');
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-dot green"></div>
        <div class="ms-text-wrap">
          <span class="ms-title ready">AI model ready</span>
          <span class="ms-sub">LaMa neural inpainting active — best quality</span>
        </div>
      </div>`;

  } else if (status === 'error') {
    ms.classList.add('ms-state-error');
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-dot red"></div>
        <div class="ms-text-wrap">
          <span class="ms-title">Download failed</span>
          <span class="ms-sub">Check your internet connection and try again</span>
        </div>
        <button class="ms-retry" id="msRetryBtn">Retry</button>
      </div>`;
    setTimeout(() => {
      $('msRetryBtn')?.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'clearModelCache' }).catch(() => {});
        modelState = { status: 'idle', progress: 0, error: null };
        checkModelAndWarm();
      });
    }, 30);

  } else {
    // idle / unknown
    ms.classList.add('ms-state-idle');
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-dot amber"></div>
        <div class="ms-text-wrap">
          <span class="ms-title">AI model not downloaded</span>
          <span class="ms-sub">Will download automatically (~198 MB, saved for future use)</span>
        </div>
      </div>`;
  }
}

function updateDownloadNotice() {
  // Show a notice strip inside scan section when model is busy
  const { status, progress } = modelState;
  if (cfg.method !== 'ai' || status === 'ready' || status === 'idle' || status === 'unknown') {
    dlNotice.style.display = 'none';
    return;
  }

  dlNotice.style.display = '';
  const pct = Math.min(99, progress || 0);

  if (status === 'downloading') {
    dlNoticeBar.innerHTML = `<div class="dl-notice-fill" style="width:${pct}%"></div>`;
    dlNoticeText.textContent = `AI model downloading (${pct}%) — images will clean automatically once ready`;
  } else if (status === 'loading') {
    dlNoticeBar.innerHTML = `<div class="dl-notice-fill indeterminate" style="width:40%"></div>`;
    dlNoticeText.textContent = 'Setting up AI engine — almost ready, hang tight';
  } else if (status === 'error') {
    dlNoticeBar.innerHTML = '';
    dlNoticeText.textContent = 'AI download failed — Smart mode will be used as fallback';
  }
}

function updatePillBadge() {
  const { status, progress } = modelState;
  if (cfg.method !== 'ai' || status === 'ready') {
    pillAiBadge.style.display = 'none';
    return;
  }
  if (status === 'downloading') {
    pillAiBadge.style.display = '';
    pillAiBadge.textContent = `${Math.min(99, progress || 0)}%`;
  } else {
    pillAiBadge.style.display = 'none';
  }
}

function refreshGridButtons() {
  document.querySelectorAll('.img-clean-btn.state-loading').forEach(btn => {
    btn.textContent = '✦ Clean';
    btn.classList.remove('state-loading');
    btn.disabled = false;
  });
}

function isModelReady() { return modelState.status === 'ready'; }

// ── Controls ───────────────────────────────────────────────────────────────
enabledCb.addEventListener('change', () => {
  cfg.enabled = enabledCb.checked;
  document.body.classList.toggle('paused', !cfg.enabled);
  setStatus(cfg.enabled); save();
  chrome.runtime.sendMessage({ action: 'toggleEnabled', enabled: cfg.enabled }).catch(() => {});
  popupToast(cfg.enabled ? 'Extension enabled' : 'Extension paused', cfg.enabled ? 'success' : 'warning');
});

autoCleanCb.addEventListener('change', () => {
  cfg.autoIntercept = autoCleanCb.checked;
  document.body.classList.toggle('manual-mode', !cfg.autoIntercept);
  updateAutoCleanSub();
  save();
  chrome.runtime.sendMessage({ action: 'setAutoIntercept', autoIntercept: cfg.autoIntercept }).catch(() => {});
  popupToast(
    cfg.autoIntercept ? 'Auto-clean on — downloads will be cleaned automatically' : 'Auto-clean off — use Scan page to clean manually',
    cfg.autoIntercept ? 'success' : 'warning'
  );
});

methodPills.forEach(pill => pill.addEventListener('click', () => {
  cfg.method = pill.dataset.method;
  methodPills.forEach(p => p.classList.toggle('active', p === pill));

  if (cfg.method === 'ai') {
    modelStatus.style.display = '';
    checkModelAndWarm();
  } else {
    modelStatus.style.display = 'none';
    dlNotice.style.display    = 'none';
    pillAiBadge.style.display = 'none';
  }
  save();
  popupToast(cfg.method === 'ai' ? '✦ Advance mode selected' : '⚡ Smart mode selected', 'success');
}));

resetBtn.addEventListener('click', async () => {
  await chrome.storage.sync.set({ stats: { totalRemoved: 0, lastReset: Date.now() } });
  statTotal.textContent = '0'; bump(statTotal);
  popupToast('Stats reset', 'success');
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.stats?.newValue) {
    statTotal.textContent = (changes.stats.newValue.totalRemoved ?? 0).toLocaleString();
    bump(statTotal);
  }
});

// ── Scan ───────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', scanPageImages);

async function scanPageImages() {
  scanBtn.disabled = true; scanBtn.textContent = '…';
  imageGrid.style.display = 'none';
  if (dlAllBtn) dlAllBtn.style.display = 'none';
  scanHint.textContent = 'Scanning…';
  scanHint.classList.remove('highlight');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no tab');

    const isGemini = tab.url?.includes('gemini.google.com') || tab.url?.includes('aistudio.google.com');
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
      scanHint.textContent = 'No images found yet — generate one in Gemini first';
      return;
    }

    scanHint.textContent = `${images.length} image${images.length === 1 ? '' : 's'} found`;
    scanHint.classList.add('highlight');

    if (dlAllBtn && images.length > 1) {
      dlAllBtn.style.display = ''; dlAllBtn.textContent = `Clean all (${images.length})`;
      dlAllBtn.disabled = false; dlAllBtn._tabId = tab.id;
    }

    renderImageGrid(images, tab.id);
    imageGrid.style.display = 'grid';
    if (cfg.method === 'ai') { checkModelAndWarm(); updateDownloadNotice(); }

  } catch {
    scanHint.textContent = 'Could not scan — try refreshing the Gemini page';
  } finally {
    scanBtn.disabled = false; scanBtn.textContent = 'Scan page';
  }
}

// ── Download All ─────────────────────────────────────────────────────────────
if (dlAllBtn) {
  dlAllBtn.addEventListener('click', async () => {
    if (cfg.method === 'ai' && !isModelReady()) {
      popupToast(
        modelState.status === 'downloading'
          ? `AI model downloading ${modelState.progress}% — please wait`
          : 'AI engine is still setting up — please wait',
        'warning'
      );
      return;
    }
    dlAllBtn.disabled = true; dlAllBtn.textContent = 'Processing…';
    const tabId = dlAllBtn._tabId;
    if (!tabId) { dlAllBtn.textContent = 'Error'; return; }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (window.__UAI_downloadAll?.()) ?? { ok: false },
      });
      const r = results?.[0]?.result;
      if (r?.ok) {
        dlAllBtn.textContent = `✓ ${r.succeeded} cleaned`;
        const cur = parseInt(statSession.textContent.replace(/,/g,''), 10) || 0;
        statSession.textContent = (cur + r.succeeded).toLocaleString(); bump(statSession);
        popupToast(`✓ ${r.succeeded} image${r.succeeded !== 1 ? 's' : ''} cleaned`, 'success');
      } else {
        dlAllBtn.textContent = 'Failed'; dlAllBtn.disabled = false;
        popupToast('Something went wrong — try again', 'error');
      }
    } catch { dlAllBtn.textContent = 'Error'; dlAllBtn.disabled = false; }
  });
}

// ── Image Grid ─────────────────────────────────────────────────────────────
function renderImageGrid(images, tabId) {
  imageGrid.innerHTML = '';
  images.forEach(img => {
    const card = document.createElement('div');
    card.className = 'img-card'; card.title = `${img.width}×${img.height}`;

    const thumb = document.createElement('img');
    thumb.src = img.src; thumb.loading = 'lazy'; thumb.alt = '';

    const overlay = document.createElement('div');
    overlay.className = 'img-card-overlay';

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'img-size';
    sizeLabel.textContent = `${img.width}×${img.height}`;

    const btn = document.createElement('button');
    btn.className = 'img-clean-btn';
    const isAi = cfg.method === 'ai', notReady = isAi && !isModelReady();

    if (notReady) {
      const s = modelState.status;
      btn.textContent = s === 'downloading' ? `↓ ${modelState.progress}%` : '↓ Loading…';
      btn.classList.add('state-loading');
    } else {
      btn.textContent = isAi ? '✦ Clean' : '↓ Clean';
    }

    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (btn.disabled) return;

      // Guard: model not ready
      if (cfg.method === 'ai' && !isModelReady()) {
        popupToast(
          modelState.status === 'downloading'
            ? `AI model downloading ${modelState.progress}% — hang tight`
            : 'AI engine is setting up — almost ready',
          'warning'
        );
        return;
      }

      // Start processing
      btn.disabled = true; btn.textContent = '…'; btn.classList.remove('state-loading');

      const proc = document.createElement('div');
      proc.className = 'processing-overlay';
      proc.innerHTML = `
        <div class="processing-spinner"></div>
        <div class="processing-label">${cfg.method === 'ai' ? 'Running AI\ninpainting…' : 'Cleaning…'}</div>`;
      card.appendChild(proc);

      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: (url, name) => {
            const fn = window.__UAI_processAndDownload ?? window.__GWR_processAndDownload;
            return typeof fn === 'function' ? fn(url, name) : { ok: false };
          },
          args: [img.src, `unmark-ai-${Date.now()}.png`],
        });

        proc.remove();
        const result = res?.[0]?.result;

        if (result?.ok) {
          const badge = document.createElement('div');
          badge.className = 'img-done-badge'; badge.textContent = '✓';
          card.appendChild(badge);
          btn.textContent = '✓ Done'; btn.style.background = 'rgba(16,185,129,0.12)';
          btn.style.color = 'var(--green)'; btn.style.borderColor = 'rgba(16,185,129,0.2)';
          // Remove overlay so badge is visible
          overlay.style.display = 'none';
          const cur = parseInt(statSession.textContent.replace(/,/g,''),10)||0;
          statSession.textContent = (cur + 1).toLocaleString(); bump(statSession);
        } else {
          btn.textContent = '↺ Retry'; btn.disabled = false;
          btn.classList.add('state-loading');
          popupToast('Cleaning failed — try again', 'error');
        }
      } catch {
        proc.remove(); btn.textContent = '↺ Retry'; btn.disabled = false;
      }
    });

    overlay.appendChild(sizeLabel); overlay.appendChild(btn);
    card.appendChild(thumb); card.appendChild(overlay);
    imageGrid.appendChild(card);
  });
}

// ── Popup Toast ──────────────────────────────────────────────────────────────
let toastEl = null, toastTmr = null;
function popupToast(msg, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'popup-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.className = `popup-toast ${type}`;
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => toastEl.classList.remove('show'), type === 'error' ? 4000 : 2600);
}

// ── Utilities ────────────────────────────────────────────────────────────────
function bump(el) {
  el.classList.remove('bump'); void el.offsetWidth;
  el.classList.add('bump'); setTimeout(() => el.classList.remove('bump'), 300);
}

boot();