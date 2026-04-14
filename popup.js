/**
 * UnmarkAI v4.0.6 — Popup Script (Production)
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

// v4.0.1: hold session count in state (was parsed from DOM textContent — fragile)
let sessionCountUI = 0;

// ── Model state ────────────────────────────────────────────────────────────
let modelState = { status: 'unknown', progress: 0, error: null };
let bgPort     = null;
let bgPortRetries = 0;

function connectBgPort() {
  try {
    bgPort = chrome.runtime.connect({ name: 'uai-popup' });
    bgPortRetries = 0;
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
    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      // Auto-reconnect with exponential backoff (max 5 retries)
      if (bgPortRetries++ < 5) {
        setTimeout(connectBgPort, 1000 * bgPortRetries);
      }
    });
  } catch {
    if (bgPortRetries++ < 5) {
      setTimeout(connectBgPort, 1000 * bgPortRetries);
    }
  }
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
    modelStatus.hidden = false;
    checkModelAndWarm();
  } else {
    modelStatus.hidden = true;
    dlNotice.hidden    = true;
    pillAiBadge.hidden = true;
  }
}

function renderStats(stats, session) {
  sessionCountUI = session ?? 0;
  statTotal.textContent   = (stats?.totalRemoved ?? 0).toLocaleString();
  statSession.textContent = sessionCountUI.toLocaleString();
}

function setStatus(on) {
  statusDot.classList.toggle('off', !on);
  statusLabel.textContent = on ? 'Watermark remover' : 'Paused';
}

function updateAutoCleanSub() {
  autoCleanSub.textContent = cfg.autoIntercept
    ? 'Clean automatically when you save from Gemini'
    : 'Manual mode — use Scan below to clean images';
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
          <span class="ms-title">Downloading model · ${pct}%</span>
          <span class="ms-sub">First-time setup · ~198 MB · Saved permanently</span>
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
          <span class="ms-title">Initializing engine</span>
          <span class="ms-sub">Almost ready</span>
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
          <span class="ms-title ready">Pro engine ready</span>
          <span class="ms-sub">Neural inpainting active</span>
        </div>
      </div>`;

  } else if (status === 'error') {
    ms.classList.add('ms-state-error');
    const errMsg = (error || 'Unknown error').toString();
    const errShort = errMsg.length > 90 ? errMsg.slice(0, 87) + '…' : errMsg;
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-dot red"></div>
        <div class="ms-text-wrap">
          <span class="ms-title">Model download failed</span>
          <span class="ms-sub" title="${errMsg.replace(/"/g, '&quot;')}">${errShort}</span>
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
          <span class="ms-title">Model not downloaded</span>
          <span class="ms-sub">Will download once · ~198 MB</span>
        </div>
      </div>`;
  }
}

function updateDownloadNotice() {
  const { status, progress } = modelState;
  if (cfg.method !== 'ai' || status === 'ready' || status === 'idle' || status === 'unknown') {
    dlNotice.hidden = true;
    return;
  }

  dlNotice.hidden = false;
  const pct = Math.min(99, progress || 0);

  if (status === 'downloading') {
    dlNoticeBar.innerHTML = `<div class="dl-notice-fill" style="width:${pct}%"></div>`;
    dlNoticeText.textContent = `Downloading model · ${pct}% · Cleans will start once ready`;
  } else if (status === 'loading') {
    dlNoticeBar.innerHTML = `<div class="dl-notice-fill indeterminate" style="width:40%"></div>`;
    dlNoticeText.textContent = 'Initializing engine · Almost ready';
  } else if (status === 'error') {
    dlNoticeBar.innerHTML = '';
    dlNoticeText.textContent = 'Pro engine unavailable · Quick will be used instead';
  }
}

function updatePillBadge() {
  const { status, progress } = modelState;
  if (cfg.method !== 'ai' || status === 'ready') {
    pillAiBadge.hidden = true;
    return;
  }
  if (status === 'downloading') {
    pillAiBadge.hidden = false;
    pillAiBadge.textContent = `${Math.min(99, progress || 0)}%`;
  } else {
    pillAiBadge.hidden = true;
  }
}

function refreshGridButtons() {
  document.querySelectorAll('.img-clean-btn.state-loading').forEach(btn => {
    btn.textContent = 'Clean';
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
  popupToast(cfg.enabled ? 'Enabled' : 'Paused', cfg.enabled ? 'success' : 'warning');
});

autoCleanCb.addEventListener('change', () => {
  cfg.autoIntercept = autoCleanCb.checked;
  document.body.classList.toggle('manual-mode', !cfg.autoIntercept);
  updateAutoCleanSub();
  save();
  chrome.runtime.sendMessage({ action: 'setAutoIntercept', autoIntercept: cfg.autoIntercept }).catch(() => {});
  popupToast(
    cfg.autoIntercept ? 'Auto-clean on' : 'Auto-clean off',
    cfg.autoIntercept ? 'success' : 'warning'
  );
});

methodPills.forEach(pill => pill.addEventListener('click', () => {
  cfg.method = pill.dataset.method;
  methodPills.forEach(p => p.classList.toggle('active', p === pill));

  if (cfg.method === 'ai') {
    modelStatus.hidden = false;
    checkModelAndWarm();
  } else {
    modelStatus.hidden = true;
    dlNotice.hidden    = true;
    pillAiBadge.hidden = true;
  }
  save();
  popupToast(cfg.method === 'ai' ? 'Pro engine selected' : 'Quick engine selected', 'success');
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
  imageGrid.hidden = true;
  if (dlAllBtn) dlAllBtn.hidden = true;
  scanHint.textContent = 'Scanning…';
  scanHint.classList.remove('highlight');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no tab');

    const isGemini = tab.url?.includes('gemini.google.com') || tab.url?.includes('aistudio.google.com');
    if (!isGemini) {
      scanHint.textContent = 'Open Gemini or AI Studio to scan';
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.__UAI_scanImages ?? window.__GWR_scanImages)?.() ?? [],
    });

    const images = results?.[0]?.result ?? [];
    if (!images.length) {
      scanHint.textContent = 'No images found · Generate one in Gemini first';
      return;
    }

    scanHint.textContent = `${images.length} image${images.length === 1 ? '' : 's'} found`;
    scanHint.classList.add('highlight');

    if (dlAllBtn && images.length > 1) {
      dlAllBtn.hidden = false;
      dlAllBtn.textContent = `Clean all (${images.length})`;
      dlAllBtn.disabled = false; dlAllBtn._tabId = tab.id;
    }

    renderImageGrid(images, tab.id);
    imageGrid.hidden = false;
    if (cfg.method === 'ai') { checkModelAndWarm(); updateDownloadNotice(); }

  } catch {
    scanHint.textContent = 'Scan failed · Try refreshing the page';
  } finally {
    scanBtn.disabled = false; scanBtn.textContent = 'Scan';
  }
}

// ── Download All ─────────────────────────────────────────────────────────────
if (dlAllBtn) {
  dlAllBtn.addEventListener('click', async () => {
    if (cfg.method === 'ai' && !isModelReady()) {
      popupToast(
        modelState.status === 'downloading'
          ? `Model still downloading · ${modelState.progress}%`
          : 'Model initializing',
        'warning'
      );
      return;
    }
    dlAllBtn.disabled = true;
    const tabId = dlAllBtn._tabId;
    if (!tabId) { dlAllBtn.textContent = 'Error'; return; }

    // v4.0.6: live elapsed counter so user knows the batch is alive.
    // Multi-image AI cleans can take several minutes total.
    const baseLabel = cfg.method === 'ai' ? 'Cleaning' : 'Cleaning';
    dlAllBtn.textContent = `${baseLabel}…`;
    const startTime = Date.now();
    const dlTick = setInterval(() => {
      if (!dlAllBtn) { clearInterval(dlTick); return; }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      dlAllBtn.textContent = `${baseLabel} · ${elapsed}s`;
    }, 1000);

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (window.__UAI_downloadAll?.()) ?? { ok: false },
      });
      clearInterval(dlTick);
      const r = results?.[0]?.result;
      if (r?.ok) {
        dlAllBtn.textContent = `${r.succeeded} done`;
        sessionCountUI += r.succeeded;
        statSession.textContent = sessionCountUI.toLocaleString(); bump(statSession);
        popupToast(`${r.succeeded} image${r.succeeded !== 1 ? 's' : ''} cleaned`, 'success');
      } else {
        dlAllBtn.textContent = 'Retry'; dlAllBtn.disabled = false;
        popupToast('Clean failed · Try again', 'error');
      }
    } catch {
      clearInterval(dlTick);
      dlAllBtn.textContent = 'Retry'; dlAllBtn.disabled = false;
    }
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
      btn.textContent = s === 'downloading' ? `${modelState.progress}%` : 'Loading';
      btn.classList.add('state-loading');
    } else {
      btn.textContent = 'Clean';
    }

    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (btn.disabled) return;

      // Guard: model not ready
      if (cfg.method === 'ai' && !isModelReady()) {
        popupToast(
          modelState.status === 'downloading'
            ? `Model still downloading · ${modelState.progress}%`
            : 'Model initializing',
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
        <div class="processing-label" data-phase></div>
        <div class="processing-timer" data-timer></div>`;
      card.appendChild(proc);

      // v4.0.6: phase-aware progress overlay. Pro mode takes 30-40s; a static
      // label looks frozen. Cycle through honest phase labels based on
      // elapsed time, with a small monospace seconds counter underneath.
      const phaseEl = proc.querySelector('[data-phase]');
      const timerEl = proc.querySelector('[data-timer]');
      const startTime = Date.now();
      let procTick = null;

      if (cfg.method === 'ai') {
        const phases = [
          { until:  3, label: 'Detecting watermark' },
          { until:  6, label: 'Preparing image'     },
          { until: 12, label: 'Loading AI engine'   },
          { until: 35, label: 'Removing watermark'  },
          { until: 60, label: 'Almost done'         },
          { until: Infinity, label: 'Finishing up'  },
        ];
        const tickFn = () => {
          const sec = Math.floor((Date.now() - startTime) / 1000);
          const phase = phases.find(p => sec < p.until);
          phaseEl.textContent = phase.label + '…';
          timerEl.textContent = sec >= 1 ? `${sec}s` : '';
        };
        tickFn();
        procTick = setInterval(tickFn, 500);
      } else {
        // Quick mode is near-instant
        phaseEl.textContent = 'Cleaning…';
        timerEl.textContent = '';
      }

      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: (url, name) => {
            const fn = window.__UAI_processAndDownload ?? window.__GWR_processAndDownload;
            return typeof fn === 'function' ? fn(url, name) : { ok: false };
          },
          args: [img.src, `unmark-ai-${Date.now()}.png`],
        });

        if (procTick) clearInterval(procTick);
        proc.remove();
        const result = res?.[0]?.result;

        if (result?.ok) {
          const badge = document.createElement('div');
          badge.className = 'img-done-badge'; badge.textContent = '✓';
          card.appendChild(badge);
          btn.textContent = 'Done';
          btn.style.background = 'rgba(16,185,129,0.15)';
          btn.style.color = 'var(--green)';
          btn.style.borderColor = 'rgba(16,185,129,0.3)';
          sessionCountUI += 1;
          statSession.textContent = sessionCountUI.toLocaleString(); bump(statSession);

          // v4.0.8: "View original" link below the Done button
          if (result.originalId) {
            const originalLink = document.createElement('button');
            originalLink.className = 'img-original-link';
            originalLink.textContent = 'View original';
            originalLink.title = 'Download the unprocessed image';
            originalLink.addEventListener('click', async (e) => {
              e.stopPropagation();
              originalLink.disabled = true;
              originalLink.textContent = 'Saving…';
              try {
                const r = await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (id) => window.__UAI_downloadOriginal?.(id) ?? false,
                  args: [result.originalId],
                });
                const ok = r?.[0]?.result;
                originalLink.textContent = ok ? 'Saved ✓' : 'Failed';
                if (!ok) {
                  popupToast('Original no longer available', 'error');
                  originalLink.disabled = false;
                  originalLink.textContent = 'Retry original';
                }
              } catch {
                originalLink.textContent = 'Failed';
                popupToast('Could not save original', 'error');
              }
            });
            overlay.appendChild(originalLink);
          }
        } else {
          btn.textContent = 'Retry'; btn.disabled = false;
          btn.classList.add('state-loading');
          popupToast('Clean failed · Try again', 'error');
        }
      } catch {
        if (procTick) clearInterval(procTick);
        proc.remove(); btn.textContent = 'Retry'; btn.disabled = false;
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