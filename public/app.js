// public/app.js — SC Case Alert System (improved)

const $ = (sel) => document.querySelector(sel);
const mattersEl    = $('#matters');
const thresholdEl  = $('#threshold');
const alertsEl     = $('#alerts');
const courtsEl     = $('#courts');
const updatedEl    = $('#updated');
const saveBtn      = $('#save');
const clearBtn     = $('#clear');
const testBtn      = $('#test');
const pulseEl      = $('#pulse');
const statusTextEl = $('#status-text');
const toastBox     = $('#toast-container');
const notifBanner  = $('#notif-banner');
const notifLog     = $('#notif-log');
const logCard      = $('#log-card');

const fired    = new Set();
let pollTimer  = null;
let lastBoard  = null;
let coramData  = null;
let coramTimer = null;
const logItems = [];       // in-app notification history
const MAX_LOG  = 30;

// ── HTML escape (defense-in-depth) ──
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Toast system ──
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastBox.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ── Audio ──
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

// Urgency-aware beep: closer → higher pitch, longer, louder
function beep(urgency = 'far') {
  try {
    if (!audioCtx) return;
    const profiles = {
      far:   { freq: 660,  dur: 300, vol: 0.06, count: 1 },
      close: { freq: 880,  dur: 400, vol: 0.10, count: 2 },
      now:   { freq: 1100, dur: 500, vol: 0.14, count: 3 },
    };
    const p = profiles[urgency] || profiles.far;

    for (let i = 0; i < p.count; i++) {
      const startAt = audioCtx.currentTime + i * (p.dur / 1000 + 0.08);
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = p.freq + i * 60; // slight pitch climb per repeat
      o.connect(g);
      g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, startAt);
      g.gain.exponentialRampToValueAtTime(p.vol, startAt + 0.02);
      o.start(startAt);
      g.gain.exponentialRampToValueAtTime(0.0001, startAt + p.dur / 1000);
      o.stop(startAt + p.dur / 1000 + 0.01);
    }
  } catch {}
}

function vibrate(urgency = 'far') {
  if (!navigator.vibrate) return;
  const patterns = {
    far:   [120],
    close: [150, 80, 150],
    now:   [200, 100, 200, 100, 300],
  };
  try { navigator.vibrate(patterns[urgency] || patterns.far); } catch {}
}

// ── Notifications ──
async function ensurePermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const p = await Notification.requestPermission();
  return p === 'granted';
}

function updateBanner() {
  if (!('Notification' in window) || Notification.permission === 'granted') {
    notifBanner.classList.remove('show');
    return;
  }
  // Don't show if user dismissed this session
  if (sessionStorage.getItem('banner-dismissed')) return;
  notifBanner.classList.add('show');
}

$('#enable-notif')?.addEventListener('click', async () => {
  const ok = await ensurePermission();
  updateBanner();
  if (ok) toast('Notifications enabled!', 'success');
  else toast('Notifications blocked. Check browser settings.', 'error');
});
$('#dismiss-banner')?.addEventListener('click', () => {
  notifBanner.classList.remove('show');
  sessionStorage.setItem('banner-dismissed', '1');
});

async function showNativeNotification(title, body, urgency = 'far') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body,
    tag: title,
    renotify: true,
    requireInteraction: urgency === 'now',  // NOW stays until dismissed
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: urgency === 'now' ? [200, 100, 200, 100, 300]
           : urgency === 'close' ? [150, 80, 150]
           : [120],
  };

  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, opts);
  } catch {
    try { new Notification(title, { body }); } catch {}
  }
}

function addToLog(title, body) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logItems.unshift({ title, body, time });
  if (logItems.length > MAX_LOG) logItems.pop();
  renderLog();
}
function renderLog() {
  if (!logItems.length) { logCard.style.display = 'none'; return; }
  logCard.style.display = '';
  notifLog.innerHTML = logItems.map(l =>
    `<div class="notif-log-item"><span>${esc(l.title)} — ${esc(l.body)}</span><span class="time">${l.time}</span></div>`
  ).join('');
}

async function notify(title, body, urgency = 'far') {
  ensureAudio();
  beep(urgency);
  vibrate(urgency);
  addToLog(title, body);

  const ok = await ensurePermission();
  if (!ok) { updateBanner(); return; }
  showNativeNotification(title, body, urgency);
}

// ── Storage & parsing ──
function getStored() {
  try {
    return {
      matters: localStorage.getItem('matters') || '',
      threshold: Number(localStorage.getItem('threshold') || '5')
    };
  } catch { return { matters: '', threshold: 5 }; }
}
function setStored({ matters, threshold }) {
  try {
    localStorage.setItem('matters', matters);
    localStorage.setItem('threshold', String(threshold));
  } catch {}
}

function parseMatters(input) {
  return input
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [c, it] = s.split('/').map(x => x.trim());
      const court = c.replace(/^C/i, '').toUpperCase();
      if (court === 'RC1' || court === 'RC2') return { court, item: Number(it) };
      return { court: String(parseInt(court, 10)), item: Number(it) };
    })
    .filter(m => Number.isFinite(m.item));
}

function preAlertWindow(seq, target, nBefore) {
  const idx = seq.indexOf(target);
  if (idx >= 0) {
    const start = Math.max(0, idx - nBefore);
    return seq.slice(start, idx + 1);
  }
  const start = Math.max(1, target - nBefore);
  const arr = [];
  for (let v = start; v <= target; v++) arr.push(v);
  return arr;
}

// ── Fetch Coram (bench composition) ──
async function fetchCoram() {
  try {
    const res = await fetch('/api/coram', { cache: 'no-store' });
    if (!res.ok) return;
    coramData = await res.json();
    // Re-render courts with coram data if board is ready
    if (lastBoard) {
      const matters = parseMatters(mattersEl.value);
      const threshold = Math.max(1, Number(thresholdEl.value) || 5);
      renderCourts(lastBoard);
    }
  } catch (e) {
    console.error('Coram fetch error:', e);
  }
}

// ── Fetch ──
async function fetchBoard() {
  const res = await fetch('/api/board', { cache: 'no-store' });
  if (!res.ok) throw new Error('board fetch failed');
  return res.json();
}

// ── Render: Coram helper ──
function renderCoram(courtId) {
  if (!coramData?.courts?.[courtId]) return '';
  const c = coramData.courts[courtId];
  if (!c.primaryJudges) return '';

  // Clean up judge names: "HON'BLE MR. JUSTICE J.K. MAHESHWARI" → "Justice J.K. Maheshwari"
  const raw = c.primaryJudges;
  const judgeNames = raw.split(',').map(name => {
    return name.trim()
      .replace(/HON['']?BLE\s*/gi, '')
      .replace(/MR\.\s*JUSTICE\s*/gi, 'Justice ')
      .replace(/MS\.\s*JUSTICE\s*/gi, 'Justice ')
      .replace(/MRS\.\s*JUSTICE\s*/gi, 'Justice ')
      .replace(/DR\.\s*JUSTICE\s*/gi, 'Justice (Dr.) ')
      .replace(/THE\s+CHIEF\s+JUSTICE/gi, 'Chief Justice of India')
      .replace(/\s+/g, ' ')
      .trim();
  }).filter(Boolean);

const session = c.primarySession && c.primarySession.toLowerCase() !== 'whole day'
    ? `<span class="session-tag">${esc(c.primarySession)}</span>`
    : '';

  const judgeListHTML = judgeNames.map(j =>
    `<div class="judge-name-item"><span class="judge-dot"></span>${esc(j)}</div>`
  ).join('');

  return `
    <div class="coram">
      <div class="bench-header">
        <span class="bench-label">Bench</span>
        ${session}
      </div>
      <div class="judge-list">${judgeListHTML}</div>
    </div>`;
}

// ── Render: Courts ──
function renderCourts(data) {
  const entries = Object.entries(data.courts);
  const countEl = document.getElementById('court-count');
  if (countEl) countEl.textContent = entries.length ? `${entries.length} courts` : '';

  if (!entries.length) {
    courtsEl.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21"/></svg></div>No court data available yet.</div>';
    return;
  }

  courtsEl.innerHTML = '';
  entries.forEach(([id, row]) => {
    const seq = row.sequence || [];
    const idx = seq.indexOf(row.current);
    const nextFew = idx >= 0 ? seq.slice(idx + 1, idx + 6) : [];
    const progress = (seq.length && idx >= 0) ? Math.round(((idx + 1) / seq.length) * 100) : 0;

    const div = document.createElement('div');

    let statusClass = 'idle';
    if (row.status && row.status.toUpperCase().includes('HEARING')) statusClass = 'hearing';
    else if (row.status && row.status.toUpperCase().includes('MENTION')) statusClass = 'mentioning';
    div.className = `tile ${statusClass}`;

    div.innerHTML = `
      <div class="head">
        <span class="court-label">Court ${esc(id)}</span>
        <span class="judge-name">${esc(row.name || '')}</span>
      </div>
      <div class="current-item">${row.current ?? '—'}</div>
      <div class="meta">Status: <strong>${esc(row.status || '—')}</strong></div>
      <div class="meta">Next: ${nextFew.length ? nextFew.join(', ') : '—'}</div>
      ${seq.length ? `<div class="progress-bar"><div class="fill" style="width:${progress}%"></div></div>` : ''}
${renderCoram(id)}
      <details>
        <summary>Full details</summary>
        <div>${esc(row.registration || '—')}</div>
        <div>${esc(row.petitioner || '—')} vs ${esc(row.respondent || '—')}</div>
        <div style="white-space:pre-wrap;margin-top:4px">${esc(row.sequenceText || '—')}</div>
      </details>
    `;
    courtsEl.appendChild(div);
  });
}

// ── Render: Alerts ──
function renderAlerts(matters, data, threshold) {
  if (!matters.length) {
    alertsEl.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg></div>Enter matters above (e.g. <code>1/12</code>) and Save to start tracking.</div>';
    return;
  }

  alertsEl.innerHTML = '';
  matters.forEach(m => {
    const row = data.courts[m.court];
    const current = row ? row.current : null;
    const seq = row ? row.sequence : [];
    const windowList = preAlertWindow(seq, m.item, threshold);

    let status = 'Waiting for session';
    let distance = null;
    let urgency = 'waiting'; // waiting | far | close | now | passed

    if (current != null) {
      const idxInWindow = windowList.indexOf(current);
      if (idxInWindow >= 0) {
        distance = windowList.length - idxInWindow - 1;

        if (distance === 0) {
          status = 'NOW — Your item is being heard';
          urgency = 'now';
        } else if (distance <= 2) {
          status = `${distance} away — Get ready!`;
          urgency = 'close';
        } else {
          status = `${distance} away`;
          urgency = 'far';
        }

        // fire notification
        const key = `${m.court}-${current}`;
        if (!fired.has(key)) {
          fired.add(key);
          const detail = row?.registration ? ` · ${row.registration}` : '';
          const nTitle = urgency === 'now'
            ? `🔴 Court ${m.court}: YOUR ITEM ${m.item}`
            : `Court ${m.court}: Item ${current}`;
          const nBody = urgency === 'now'
            ? `Item ${m.item} is being heard NOW${detail}`
            : `${distance} away from item ${m.item}${detail}`;
          notify(nTitle, nBody, urgency);
        }
      } else {
        const idxTarget = seq.indexOf(m.item);
        const idxCurrent = seq.indexOf(current);
        if (idxTarget >= 0 && idxCurrent >= 0) {
          distance = idxTarget - idxCurrent;
          if (distance < 0) {
            status = 'Passed';
            urgency = 'passed';
          } else if (distance === 0) {
            status = 'NOW — Your item is being heard';
            urgency = 'now';
          } else if (distance <= 2) {
            status = `${distance} away — Get ready!`;
            urgency = 'close';
          } else {
            status = `${distance} away`;
            urgency = 'far';
          }
        } else if (idxTarget < 0) {
          status = 'Not in declared sequence';
        } else {
          status = 'In session';
        }
      }
    }

    const distLabel = distance != null && distance >= 0
      ? `<div class="alert-distance ${urgency === 'now' ? 'now' : urgency === 'close' ? 'close' : 'far'}">${distance === 0 ? 'NOW' : distance}</div>`
      : '';

    const div = document.createElement('div');
    div.className = `tile alert-${urgency}`;
    div.innerHTML = `
      <div class="head">
        <span class="alert-matter">C${esc(m.court)}/${m.item}</span>
        ${distLabel}
      </div>
      <div class="meta">${esc(status)}</div>
      <div class="meta">Current item: <strong>${current ?? '—'}</strong></div>
    `;
    alertsEl.appendChild(div);
  });
}

// ── Ticker (update without resetting CSS animation) ──
let lastTickerText = '';
function updateTicker(text) {
  if (text === lastTickerText) return;
  lastTickerText = text;
  const tickerEl = document.getElementById('ticker');
  if (tickerEl) tickerEl.textContent = text || '—';
}

// ── Main loop ──
async function loop() {
  try {
    const data = await fetchBoard();
    lastBoard = data;

    updatedEl.textContent = data.updatedAt || new Date().toLocaleString();
    updatedEl.style.color = '';
    pulseEl.classList.remove('error');
    statusTextEl.textContent = 'Live';

    updateTicker(data.tickerText || '—');

    const matters = parseMatters(mattersEl.value);
    const threshold = Math.max(1, Number(thresholdEl.value) || 5);
    renderCourts(data);
    renderAlerts(matters, data, threshold);
  } catch (e) {
    console.error(e);
    updatedEl.textContent = 'Connection error — retrying…';
    updatedEl.style.color = '#dc2626';
    pulseEl.classList.add('error');
    statusTextEl.textContent = 'Disconnected';
  } finally {
    pollTimer = setTimeout(loop, 10000);
  }
}

// ── Visibility: pause in background, resume on focus ──
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  } else {
    if (!pollTimer) loop();
  }
});

// ── UI Events ──
function doSave() {
  ensureAudio();
  setStored({ matters: mattersEl.value, threshold: thresholdEl.value });
  fired.clear();

// Visual feedback on button
  const saveSvg = saveBtn.querySelector('svg');
  saveBtn.textContent = '✓ Saved';
  saveBtn.classList.add('saved');
  setTimeout(() => {
    saveBtn.textContent = '';
    if (saveSvg) saveBtn.appendChild(saveSvg);
    saveBtn.appendChild(document.createTextNode(' Save'));
    saveBtn.classList.remove('saved');
  }, 1200);

  toast('Matters saved', 'success');

  // Re-render alerts immediately with current data
  if (lastBoard) {
    const matters = parseMatters(mattersEl.value);
    const threshold = Math.max(1, Number(thresholdEl.value) || 5);
    renderAlerts(matters, lastBoard, threshold);
  }
}

saveBtn.addEventListener('click', doSave);

// Auto-save when user leaves textarea or threshold
mattersEl.addEventListener('blur', () => {
  const stored = getStored();
  if (mattersEl.value !== stored.matters) doSave();
});
thresholdEl.addEventListener('change', doSave);

clearBtn.addEventListener('click', () => {
  mattersEl.value = '';
  setStored({ matters: '', threshold: thresholdEl.value });
  alertsEl.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg></div>Enter matters above (e.g. <code>1/12</code>) and Save to start tracking.</div>';
  toast('Cleared');
});

testBtn.addEventListener('click', async () => {
  ensureAudio();
  const ok = await ensurePermission();
  updateBanner();
  if (!ok) {
    toast('Please allow notifications first.', 'error');
    return;
  }

  try {
    if (!lastBoard) lastBoard = await fetchBoard();
    const matters = parseMatters(mattersEl.value);

    if (!matters.length) {
      toast('Enter at least one matter first (e.g. 1/12)', 'error');
      return;
    }
    const threshold = Math.max(1, Number(thresholdEl.value) || 5);

    let delay = 0;

    matters.forEach(m => {
      const row = lastBoard.courts[m.court];
      const seq = row ? row.sequence : [];
      const windowList = preAlertWindow(seq, m.item, threshold);
      const detail = row?.registration ? ` · ${row.registration}` : '';

      windowList.forEach((num, idx) => {
        const dist = windowList.length - idx - 1;
        const u = dist === 0 ? 'now' : dist <= 2 ? 'close' : 'far';
        setTimeout(() => {
          const title = dist === 0
            ? `TEST 🔴 Court ${m.court}: YOUR ITEM ${m.item}`
            : `TEST • Court ${m.court}: Item ${num}`;
          const body = dist === 0
            ? `Item ${m.item} is being heard NOW${detail}`
            : `${dist} away from item ${m.item}${detail}`;
          notify(title, body, u);
        }, delay + idx * 1200);
      });
      delay += windowList.length * 1200 + 600;
    });

    toast('Test notifications firing…');
  } catch (e) {
    console.error(e);
    toast('Test failed. Try again.', 'error');
  }
});

// ── Init ──
(function init() {
  const { matters, threshold } = getStored();
  mattersEl.value = matters;
  thresholdEl.value = threshold;

  document.addEventListener('click', ensureAudio, { once: true });

updateBanner();

  // ── Theme toggle ──
  const themeBtn = document.getElementById('theme-toggle');


function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
  }

  // Load saved preference, default to light
  const savedTheme = localStorage.getItem('theme');
  applyTheme(savedTheme === 'dark');

  themeBtn.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });

  
  // Fetch coram on load, then every 5 minutes
  fetchCoram();
  coramTimer = setInterval(fetchCoram, 5 * 60 * 1000);

  loop();
})();