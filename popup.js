/**
 * UnmarkAI — Popup Script
 *
 * Model states: idle → downloading (0–100%) → loading → ready | error
 * Auto-clean:   cfg.autoIntercept — toggle exposed to user
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
// Only three user-controllable settings. Output format is always PNG; visible
// watermark + SynthID removal + notifications are always on — see content.js.
let cfg = {
  enabled:       true,
  autoIntercept: true,
  method:        'smart',
};

// Popup-local view of today's cleaned count (persisted in chrome.storage.local
// by background.js — "Today" resets on a date change, not on SW restart).
let todayCountUI = 0;

// ── "Today" stat helpers ───────────────────────────────────────────────────
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ── Model state ────────────────────────────────────────────────────────────
let modelState = { status: 'unknown', progress: 0, error: null };
let bgPort     = null;
let bgPortRetries = 0;

// Backoff between reconnect attempts: 1s, 2s, 4s, 8s, 16s (cap at 30s).
function reconnectDelay() {
  return Math.min(30_000, 1000 * Math.pow(2, bgPortRetries));
}

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
      // Auto-reconnect with true exponential backoff (max 5 retries)
      if (bgPortRetries < 5) {
        setTimeout(connectBgPort, reconnectDelay());
        bgPortRetries++;
      }
    });
  } catch {
    if (bgPortRetries < 5) {
      setTimeout(connectBgPort, reconnectDelay());
      bgPortRetries++;
    }
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  connectBgPort();

  const [stored, statsData, dailyData, welcomeData] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.sync.get('stats'),
    chrome.storage.local.get('dailyStats'),
    chrome.storage.local.get('welcomeDismissed'),
  ]);

  if (stored.settings) Object.assign(cfg, stored.settings);

  // "Today" count: honour the date in storage. A stale (previous-day) record
  // renders as 0 until background.js increments for today.
  const today = todayKey();
  const todayCount = (dailyData.dailyStats && dailyData.dailyStats.date === today)
    ? dailyData.dailyStats.count
    : 0;

  renderCfg();
  renderStats(statsData.stats, todayCount);

  // Onboarding: show only on truly cold start (no cleans ever) AND not
  // already dismissed. Either of those being true hides it forever.
  const totalEver = statsData.stats?.totalRemoved ?? 0;
  renderWelcome(totalEver === 0 && !welcomeData.welcomeDismissed);

  // Scan hint defaults before any scan runs. If we're on Gemini, a scan will
  // auto-fire in 200ms and overwrite this anyway — but setting it inline
  // avoids the "Loading…" flash for the fraction of a second in between.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onGemini = tab?.url?.includes('gemini.google.com') || tab?.url?.includes('aistudio.google.com');
    if (onGemini) {
      scanHint.textContent = 'Scan for images on this page';
      setTimeout(scanPageImages, 200);
    } else {
      scanHint.textContent = 'Open Gemini or AI Studio to scan';
    }
  } catch {
    scanHint.textContent = 'Open Gemini or AI Studio to scan';
  }
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

function renderStats(stats, todayCount) {
  todayCountUI = todayCount ?? 0;
  statTotal.textContent   = (stats?.totalRemoved ?? 0).toLocaleString();
  statSession.textContent = todayCountUI.toLocaleString();
}

// ── Onboarding ─────────────────────────────────────────────────────────────
const welcomeBanner  = $('welcomeBanner');
const welcomeDismiss = $('welcomeDismiss');

function renderWelcome(show) {
  welcomeBanner.hidden = !show;
}

welcomeDismiss?.addEventListener('click', async () => {
  renderWelcome(false);
  try {
    await chrome.storage.local.set({ welcomeDismissed: true });
  } catch {}
});

// ── Engine info expander ───────────────────────────────────────────────────
const engineInfoToggle = $('engineInfoToggle');
const engineInfoPanel  = $('engineInfoPanel');
const engineInfoLabel  = $('engineInfoLabel');

engineInfoToggle?.addEventListener('click', () => {
  const expanded = engineInfoToggle.getAttribute('aria-expanded') === 'true';
  const next = !expanded;
  engineInfoToggle.setAttribute('aria-expanded', String(next));
  engineInfoPanel.hidden = !next;
  engineInfoLabel.textContent = next ? 'Hide comparison' : 'Which should I pick?';
});

function setStatus(on) {
  statusDot.classList.toggle('off', !on);
  // When on, the subtitle acts as an action-oriented tagline.
  // When off, it reads as hard status.
  statusLabel.textContent = on ? 'Clean Gemini images' : 'Off';
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
          <span class="ms-title">Setting up Pro mode · ${pct}%</span>
          <span class="ms-sub">One-time download · ~198 MB · Works offline after</span>
        </div>
        <button class="ms-retry ms-cancel" id="msCancelBtn" type="button">Cancel</button>
      </div>
      <div class="ms-progress">
        <div class="ms-progress-fill" style="width:${pct}%"></div>
      </div>`;
    setTimeout(() => {
      $('msCancelBtn')?.addEventListener('click', async () => {
        const btn = $('msCancelBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
        try {
          await chrome.runtime.sendMessage({ action: 'cancelModelDownload' });
        } catch {}
      });
    }, 30);

  } else if (status === 'loading') {
    modelStatusInner.innerHTML = `
      <div class="ms-body">
        <div class="ms-spinner"></div>
        <div class="ms-text-wrap">
          <span class="ms-title">Preparing the engine</span>
          <span class="ms-sub">A few seconds and we're ready</span>
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
          <span class="ms-title ready">Pro mode ready</span>
          <span class="ms-sub">Running on your device · No uploads</span>
        </div>
      </div>`;

  } else if (status === 'error') {
    ms.classList.add('ms-state-error');
    const errMsg     = (error || 'Unknown error').toString();
    const isLongMsg  = errMsg.length > 90;
    const errShort   = isLongMsg ? errMsg.slice(0, 87) + '…' : errMsg;

    // Build with DOM APIs so the error message cannot break out via <, >, &, ".
    modelStatusInner.textContent = '';
    const body = document.createElement('div');
    body.className = 'ms-body';

    const dot = document.createElement('div');
    dot.className = 'ms-dot red';

    const textWrap = document.createElement('div');
    textWrap.className = 'ms-text-wrap';

    const title = document.createElement('span');
    title.className = 'ms-title';
    title.textContent = "Couldn't set up Pro mode";

    const sub = document.createElement('span');
    sub.className = 'ms-sub';
    sub.textContent = errShort;

    textWrap.append(title, sub);

    // Inline disclosure: only when the full message was truncated. Clicking
    // expands the full error below the short one; we avoid title= tooltips
    // because a 340px popup pinned to the toolbar clips them awkwardly.
    if (isLongMsg) {
      const details = document.createElement('button');
      details.type = 'button';
      details.className = 'ms-details-btn';
      details.textContent = 'Show details';
      details.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        details.remove();
        const full = document.createElement('pre');
        full.className = 'ms-details-full';
        full.textContent = errMsg;
        textWrap.appendChild(full);
      });
      textWrap.appendChild(details);
    }

    const retry = document.createElement('button');
    retry.className = 'ms-retry';
    retry.id = 'msRetryBtn';
    retry.textContent = 'Retry';

    body.append(dot, textWrap, retry);
    modelStatusInner.appendChild(body);
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
          <span class="ms-title">Pro mode — ready to set up</span>
          <span class="ms-sub">One-time 198 MB download · Runs fully on-device</span>
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
    dlNoticeText.textContent = `Setting up Pro mode · ${pct}% · Cleans start when ready`;
  } else if (status === 'loading') {
    dlNoticeBar.innerHTML = `<div class="dl-notice-fill indeterminate" style="width:40%"></div>`;
    dlNoticeText.textContent = 'Preparing the engine · Almost ready';
  } else if (status === 'error') {
    dlNoticeBar.innerHTML = '';
    dlNoticeText.textContent = 'Pro mode unavailable · Falling back to Quick';
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
  // When the model becomes ready, reset:
  //   - loading-state buttons (still waiting for the model)
  //   - retry-state buttons (previous attempt failed, but the user may want to
  //     try again now that the model is up)
  // We DON'T reset Done buttons — those represent completed cleans.
  document.querySelectorAll('.img-clean-btn').forEach(btn => {
    if (btn.classList.contains('state-loading')) {
      btn.textContent = 'Clean';
      btn.classList.remove('state-loading');
      btn.disabled = false;
      return;
    }
    if (btn.textContent === 'Retry') {
      btn.textContent = 'Clean';
      btn.disabled = false;
    }
  });
}

function isModelReady() { return modelState.status === 'ready'; }

// ── Controls ───────────────────────────────────────────────────────────────
enabledCb.addEventListener('change', () => {
  cfg.enabled = enabledCb.checked;
  document.body.classList.toggle('paused', !cfg.enabled);
  setStatus(cfg.enabled);
  // Single storage write — background.js listens via storage.onChanged and
  // updates its cachedSettings + badge from there. No second RPC needed.
  save();
  popupToast(cfg.enabled ? 'UnmarkAI enabled' : 'UnmarkAI turned off', cfg.enabled ? 'success' : 'warning');
});

autoCleanCb.addEventListener('change', () => {
  cfg.autoIntercept = autoCleanCb.checked;
  document.body.classList.toggle('manual-mode', !cfg.autoIntercept);
  updateAutoCleanSub();
  save();
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

  // Re-render the Clean-all button label — the Pro estimate only shows
  // when we know how many images are staged AND Pro is active.
  if (dlAllBtn && !dlAllBtn.hidden) {
    const n = Number(String(dlAllBtn.textContent).match(/\((\d+)\)/)?.[1] || 0);
    if (n > 1) {
      dlAllBtn.textContent = cfg.method === 'ai'
        ? `Clean all (${n}) · ${batchEstimate(n)}`
        : `Clean all (${n})`;
    }
  }

  save();
  popupToast(cfg.method === 'ai' ? 'Pro engine selected' : 'Quick engine selected', 'success');
}));

// ── Reset stats (two-step click) ─────────────────────────────────────────
// First click arms the action for 3s (button turns amber, shows a shrinking
// bar); a second click within that window commits. Prevents one-tap wipes.
let resetArmed = false;
let resetTimer = null;

function disarmReset() {
  resetArmed = false;
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  resetBtn.textContent = 'Reset stats';
  resetBtn.classList.remove('confirming');
}

resetBtn.addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true;
    resetBtn.textContent = 'Click again to confirm';
    resetBtn.classList.add('confirming');
    resetTimer = setTimeout(disarmReset, 3000);
    return;
  }

  // Confirmed — clear both counters so the zero UI matches the button's promise.
  disarmReset();
  await Promise.all([
    chrome.storage.sync.set({ stats: { totalRemoved: 0, lastReset: Date.now() } }),
    chrome.storage.local.set({ dailyStats: { date: todayKey(), count: 0 } }),
  ]);
  todayCountUI = 0;
  statTotal.textContent   = '0'; bump(statTotal);
  statSession.textContent = '0'; bump(statSession);
  popupToast('Stats reset', 'success');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.stats?.newValue) {
    const total = changes.stats.newValue.totalRemoved ?? 0;
    statTotal.textContent = total.toLocaleString();
    bump(statTotal);
    // First ever clean → hide the onboarding if it's still up
    if (total > 0) renderWelcome(false);
  }
  if (area === 'local' && changes.dailyStats?.newValue) {
    const next = changes.dailyStats.newValue;
    // Only render if the record is for today (guards against midnight edge cases)
    if (next.date === todayKey()) {
      todayCountUI = next.count ?? 0;
      statSession.textContent = todayCountUI.toLocaleString();
      bump(statSession);
    }
  }
});

// ── Scan ───────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', scanPageImages);

// Estimated total wall time for a batch. Pro inference is ~35s per image
// under single-thread WASM; Quick is near-instant so we only annotate Pro.
function batchEstimate(n) {
  const secs = n * 35;
  const mins = Math.max(1, Math.round(secs / 60));
  return `~${mins} min`;
}

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
      dlAllBtn.textContent = cfg.method === 'ai'
        ? `Clean all (${images.length}) · ${batchEstimate(images.length)}`
        : `Clean all (${images.length})`;
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

    // Live elapsed counter so the user knows the batch is alive.
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
        todayCountUI += r.succeeded;
        statSession.textContent = todayCountUI.toLocaleString(); bump(statSession);
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

      // Phase-aware progress overlay. Pro mode takes 30-40s; a static
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
          todayCountUI += 1;
          statSession.textContent = todayCountUI.toLocaleString(); bump(statSession);

          // "View original" link below the Done button
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

            // "Compare" — opens the before/after modal.
            const compareLink = document.createElement('button');
            compareLink.className = 'img-compare-link';
            compareLink.textContent = 'Compare';
            compareLink.title = 'Show before/after comparison';
            compareLink.addEventListener('click', async (e) => {
              e.stopPropagation();
              openPreviewModal(tabId, result.originalId, compareLink);
            });
            overlay.appendChild(compareLink);
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

// ── Before/After modal ─────────────────────────────────────────────────────
// Single modal instance, reused. We fetch the pair lazily each time a card's
// Compare button is clicked (pairs expire after 5 min per content.js TTL).

const previewModal     = $('previewModal');
const previewBackdrop  = $('previewBackdrop');
const previewClose     = $('previewClose');
const previewStage     = $('previewStage');
const previewLoading   = $('previewLoading');
const previewSlider    = $('previewSlider');
const previewClip      = $('previewClip');
const previewDivider   = $('previewDivider');
const previewOriginal  = $('previewOriginal');
const previewCleaned   = $('previewCleaned');

function closePreviewModal() {
  previewModal.hidden = true;
  // Clear the sources so we don't keep ~1 MB of data URLs in the DOM between opens
  previewOriginal.src = '';
  previewCleaned.src  = '';
  document.removeEventListener('keydown', onPreviewKey);
}

function onPreviewKey(e) {
  if (e.key === 'Escape') closePreviewModal();
}

previewClose?.addEventListener('click', closePreviewModal);
previewBackdrop?.addEventListener('click', closePreviewModal);

async function openPreviewModal(tabId, originalId, triggerBtn) {
  if (!tabId || !originalId) return;

  // Reset + show the modal in loading state
  previewSlider.hidden = true;
  previewLoading.hidden = false;
  previewLoading.textContent = 'Loading preview…';
  previewSlider.style.setProperty('--split', '50%');
  previewModal.hidden = false;
  document.addEventListener('keydown', onPreviewKey);

  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Loading…';
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (id) => (window.__UAI_getPreviewPair?.(id) ?? null),
      args: [originalId],
    });
    const pair = res?.[0]?.result;
    if (!pair || !pair.original || !pair.cleaned) {
      previewLoading.textContent = 'Preview no longer available';
      setTimeout(closePreviewModal, 1600);
      return;
    }

    previewOriginal.src = pair.original;
    previewCleaned.src  = pair.cleaned;
    // Wait for both images to actually render before swapping out the loader
    await Promise.all([
      previewOriginal.decode().catch(() => {}),
      previewCleaned.decode().catch(() => {}),
    ]);

    previewLoading.hidden = true;
    previewSlider.hidden  = false;
  } catch (err) {
    previewLoading.textContent = 'Could not load preview';
    setTimeout(closePreviewModal, 1600);
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = 'Compare';
    }
  }
}

// Drag logic: a single pointer listener on the slider updates the --split
// CSS variable, which both the clip-path inset and the divider's left offset
// read from. We use pointer events so mouse and touch both work.
let previewDragging = false;

function setSplitFromClientX(clientX) {
  const rect = previewSlider.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const pct = (x / rect.width) * 100;
  previewSlider.style.setProperty('--split', pct + '%');
}

previewSlider?.addEventListener('pointerdown', (e) => {
  previewDragging = true;
  previewSlider.setPointerCapture?.(e.pointerId);
  setSplitFromClientX(e.clientX);
  e.preventDefault();
});
previewSlider?.addEventListener('pointermove', (e) => {
  if (!previewDragging) return;
  setSplitFromClientX(e.clientX);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt =>
  previewSlider?.addEventListener(evt, (e) => {
    if (!previewDragging) return;
    previewDragging = false;
    try { previewSlider.releasePointerCapture?.(e.pointerId); } catch {}
  })
);

boot();