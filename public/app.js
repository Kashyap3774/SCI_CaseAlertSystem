// public/app.js — SC Case Alerts (UI). Pure logic lives in ./logic.js.

import {
  normalizeCourt, courtLabel, parseItem, clampAlertAhead, migrateLegacyMatters,
  caseStatus, dueAlerts, nextItems, formatJudgeName, DEFAULT_ALERT_AHEAD,
} from './logic.js';

const POLL_MS = 10_000;
const CORAM_MS = 5 * 60_000;
const DEFAULT_COURTS = [...Array.from({ length: 17 }, (_, i) => String(i + 1)), 'RC1', 'RC2'];
const ALERT_AHEAD_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const MAX_LOG = 30;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Replace an element's HTML only when it actually changed, so open panels,
// focus and scroll position survive the 10-second refresh.
function patch(el, html) {
  if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
}

// ── Storage that never throws (some browsers block it); falls back to memory ──
const store = (() => {
  const mem = new Map();
  let persistent = true;
  try { localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); } catch { persistent = false; }
  return {
    persistent,
    get(key, fallback = null) {
      if (persistent) { try { const v = localStorage.getItem(key); if (v !== null) return v; } catch {} }
      return mem.has(key) ? mem.get(key) : fallback;
    },
    set(key, value) {
      mem.set(key, String(value));
      if (persistent) { try { localStorage.setItem(key, String(value)); } catch {} }
    },
    remove(key) {
      mem.delete(key);
      if (persistent) { try { localStorage.removeItem(key); } catch {} }
    },
  };
})();

function loadCases() {
  try {
    const saved = JSON.parse(store.get('cases', 'null'));
    if (Array.isArray(saved)) {
      return saved
        .map((c) => ({ court: normalizeCourt(c?.court), item: parseItem(c?.item) }))
        .filter((c) => c.court && c.item);
    }
  } catch {}
  // First run after the redesign: carry over the old free-text list
  const migrated = migrateLegacyMatters(store.get('matters', ''));
  if (migrated.length) {
    store.set('cases', JSON.stringify(migrated));
    const oldThreshold = store.get('threshold');
    if (oldThreshold) store.set('alertAhead', clampAlertAhead(oldThreshold));
  }
  store.remove('matters');
  store.remove('threshold');
  return migrated;
}

const state = {
  cases: loadCases(),
  alertAhead: clampAlertAhead(store.get('alertAhead', DEFAULT_ALERT_AHEAD)),
  soundOn: store.get('soundOn', '1') === '1',
  wakeWanted: store.get('keepScreenOn', '0') === '1',
  onlyMine: store.get('onlyMine', '0') === '1',
  board: null,
  coram: null,
  lastOk: null,
  error: null, // null | 'offline' | 'server' | 'auth'
  fired: new Set(),
  log: [],
};

const saveCases = () => store.set('cases', JSON.stringify(state.cases));
const caseKey = (c) => `${c.court}/${c.item}`;

// ═══════════════════════════════════════════════════════════════
// Sound, vibration, notifications
// ═══════════════════════════════════════════════════════════════

let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().then(renderSetup, () => {});
  } catch {}
  renderSetup();
}
const audioReady = () => audioCtx?.state === 'running';

const SOUND = {
  near:  { freq: 660,  dur: 0.30, vol: 0.06, count: 1 },
  close: { freq: 880,  dur: 0.40, vol: 0.10, count: 2 },
  now:   { freq: 1100, dur: 0.50, vol: 0.14, count: 3 },
};
function beep(level) {
  if (!state.soundOn || !audioReady()) return;
  const p = SOUND[level] || SOUND.near;
  try {
    for (let i = 0; i < p.count; i++) {
      const t = audioCtx.currentTime + i * (p.dur + 0.08);
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = p.freq + i * 60; // slight climb per repeat
      o.connect(g);
      g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(p.vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + p.dur);
      o.start(t);
      o.stop(t + p.dur + 0.01);
    }
  } catch {}
}

const VIBRATE = { near: [120], close: [150, 80, 150], now: [200, 100, 200, 100, 300] };
function vibrate(level) {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // blocked before the first tap
  try { navigator.vibrate?.(VIBRATE[level] || VIBRATE.near); } catch {}
}

const notifSupported = () => 'Notification' in window;
const isIOS = () =>
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
  !window.matchMedia?.('(display-mode: standalone)')?.matches;

async function askNotificationPermission() {
  if (!notifSupported() || Notification.permission !== 'default') return;
  try { await Notification.requestPermission(); } catch {}
  renderSetup();
}

async function showSystemNotification(title, body, level, tag) {
  if (!notifSupported() || Notification.permission !== 'granted') return;
  const opts = {
    body,
    tag,
    renotify: true,
    requireInteraction: level === 'now', // "now" stays until dismissed
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: VIBRATE[level],
  };
  try {
    // getRegistration() resolves even when no worker is installed (ready would hang)
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
  } catch {}
  try { new Notification(title, { body, tag }); } catch {}
}

function alertText(a) {
  const where = courtLabel(a.court);
  if (a.state === 'now') {
    return { title: `${where}: your case is on now`, body: `Item ${a.item} is being heard now.` };
  }
  if (a.state === 'close') {
    return { title: `${where}: get ready`, body: `${plural(a.ahead, 'case')} before your item ${a.item}. Now hearing item ${a.current}.` };
  }
  return { title: `${where}: ${plural(a.ahead, 'case')} before yours`, body: `Your item ${a.item} is coming up. Now hearing item ${a.current}.` };
}

function fireAlert(a, { test = false } = {}) {
  const { title, body } = alertText(a);
  const fullTitle = test ? `Test: ${title}` : title;
  beep(a.state);
  vibrate(a.state);
  addToLog(fullTitle, body, a.state);
  $('#announcer').textContent = `${fullTitle}. ${body}`;
  showSystemNotification(fullTitle, body, a.state, test ? `test-${a.state}` : `case-${a.court}-${a.item}`);
}

function addToLog(title, body, level) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.log.unshift({ title, body, level, time });
  if (state.log.length > MAX_LOG) state.log.pop();
  renderLog();
}

// ═══════════════════════════════════════════════════════════════
// Keep screen on (Screen Wake Lock)
// ═══════════════════════════════════════════════════════════════

let wakeLock = null;
let wakeRefused = false; // the browser said no (e.g. battery saver)
const wakeSupported = () => 'wakeLock' in navigator;

async function applyWakeLock() {
  if (!wakeSupported()) return renderSetup();
  try {
    if (state.wakeWanted && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeRefused = false;
      wakeLock.addEventListener('release', () => { wakeLock = null; renderSetup(); });
    } else if (!state.wakeWanted) {
      wakeRefused = false;
      if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    }
  } catch {
    wakeLock = null;
    wakeRefused = state.wakeWanted;
  }
  renderSetup();
}

// ═══════════════════════════════════════════════════════════════
// Toasts
// ═══════════════════════════════════════════════════════════════

function toast(message, { type = '', action = null, duration = 3000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); el.remove(); });
    el.appendChild(btn);
  }
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════

const STATUS_COPY = {
  'not-started': () => ({ title: "Court hasn't started yet", hint: 'We will start tracking as soon as the court begins.' }),
  waiting: (s) => ({ title: `${plural(s.ahead, 'case')} before yours`, hint: `We will alert you when it is ${plural(state.alertAhead, 'case')} away.` }),
  near: (s) => ({ title: `${plural(s.ahead, 'case')} before yours`, hint: 'Coming up. Keep this page open.' }),
  close: (s) => ({ title: `Get ready: ${plural(s.ahead, 'case')} before yours`, hint: 'Make your way to the court now.' }),
  now: () => ({ title: 'Your case is being heard now', hint: 'Go in now.' }),
  passed: () => ({ title: 'The court has moved past your item', hint: 'If your case was passed over, it may be called again later.' }),
  'not-listed': () => ({ title: 'Not in the court’s announced order', hint: 'Check the item number. We will keep watching in case it is added.' }),
  'off-order': () => ({ title: 'Court is taking another matter', hint: 'It is outside the announced order. We will keep watching.' }),
  loading: () => ({ title: 'Checking the court board…', hint: '' }),
};

function statusFor(c) {
  if (!state.board) return { state: 'loading', ahead: null, current: null };
  return caseStatus(state.board.courts?.[c.court], c.item, state.alertAhead);
}

const caseCards = new Map(); // caseKey → element

function renderCases() {
  const list = $('#case-list');
  const keys = new Set(state.cases.map(caseKey));

  for (const [key, el] of caseCards) {
    if (!keys.has(key)) { el.remove(); caseCards.delete(key); }
  }

  if (!state.cases.length) {
    patch(list, `<div class="empty-state">
      <p class="empty-title">No cases yet</p>
      <p>Add one above, for example <strong>Court 3</strong>, item <strong>12</strong>.<br>Or tap <strong>Track a case here</strong> on any court below.</p>
    </div>`);
    return;
  }
  if (list.querySelector('.empty-state')) { list.innerHTML = ''; list.__html = null; }

  for (const c of state.cases) {
    const key = caseKey(c);
    let card = caseCards.get(key);
    if (!card) {
      card = document.createElement('article');
      card.className = 'case-card';
      card.innerHTML = `
        <div class="case-head">
          <span class="case-id"><span class="case-court">${esc(courtLabel(c.court))}</span><span class="case-item">Item ${c.item}</span></span>
          <button type="button" class="icon-btn" data-remove="${esc(key)}" aria-label="Stop tracking ${esc(courtLabel(c.court))}, item ${c.item}" title="Remove">
            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
          </button>
        </div>
        <div class="case-body"></div>`;
      caseCards.set(key, card);
    }
    list.appendChild(card); // keeps cards in the user's order

    const s = statusFor(c);
    const copy = STATUS_COPY[s.state](s);
    card.dataset.state = s.state;
    patch(card.querySelector('.case-body'), `
      <p class="case-status">${esc(copy.title)}</p>
      ${copy.hint ? `<p class="case-hint">${esc(copy.hint)}</p>` : ''}
      <div class="case-nums">
        <div><span class="num-label">Now hearing</span><span class="num">${s.current ?? '–'}</span></div>
        <div><span class="num-label">Your item</span><span class="num">${c.item}</span></div>
      </div>`);
  }
}

function renderHotBanner() {
  const banner = $('#hot-banner');
  const hot = state.cases
    .map((c) => ({ ...c, ...statusFor(c) }))
    .filter((s) => s.state === 'now' || s.state === 'close')
    .sort((a, b) => a.ahead - b.ahead);

  if (!hot.length) {
    banner.hidden = true;
    document.title = 'SC Case Alerts · Supreme Court of India';
    return;
  }
  const top = hot[0];
  const text = top.state === 'now'
    ? `${courtLabel(top.court)}, item ${top.item}: your case is being heard now`
    : `${courtLabel(top.court)}, item ${top.item}: ${plural(top.ahead, 'case')} before yours. Get ready.`;
  banner.hidden = false;
  banner.dataset.state = top.state;
  patch(banner, `<span class="hot-dot" aria-hidden="true"></span><span>${esc(text)}</span>`);
  // Visible in the browser tab even when you're on another tab
  document.title = top.state === 'now' ? `NOW: ${courtLabel(top.court)} item ${top.item}` : `${top.ahead} before yours · ${courtLabel(top.court)}`;
}

function chipFor(row) {
  if (!row || row.current == null) return { cls: 'idle', text: 'Not started' };
  const raw = (row.status || '').trim();
  const up = raw.toUpperCase();
  const text = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : 'In session';
  if (up.includes('HEAR')) return { cls: 'hearing', text };
  if (up.includes('MENTION')) return { cls: 'mention', text };
  return { cls: 'sitting', text };
}

function benchHTML(courtId) {
  const benches = (state.coram?.courts?.[courtId]?.coram || []).filter((b) => b.judges);
  if (!benches.length) return '';
  return `<div class="bench">
    <span class="bench-label">Bench</span>
    ${benches.map((b) => {
      const session = b.session && !/^whole day$/i.test(b.session)
        ? `<span class="session-tag">${esc(b.session.replace(/\s*:\s*/, ': '))}</span>` : '';
      const judges = b.judges.split(',').map(formatJudgeName).filter(Boolean);
      return `<div class="bench-group">${session}<ul class="judge-list">${judges.map((j) => `<li>${esc(j)}</li>`).join('')}</ul></div>`;
    }).join('')}
  </div>`;
}

const courtTiles = new Map(); // courtId → element

function courtIds() {
  const ids = [...DEFAULT_COURTS];
  for (const id of Object.keys(state.board?.courts || {})) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function renderCourts() {
  const grid = $('#courts');
  const courts = state.board?.courts || {};
  const ids = Object.keys(courts);
  if (!state.board) return;

  grid.setAttribute('aria-busy', 'false');
  grid.querySelectorAll('.skeleton').forEach((el) => el.remove());
  $('#court-count').textContent = ids.length ? `${ids.length} courts` : '';

  if (!ids.length) {
    grid.innerHTML = '<div class="empty-state"><p class="empty-title">No court data right now</p><p>The board may be empty outside court hours.</p></div>';
    courtTiles.clear();
    return;
  }
  grid.querySelector('.empty-state')?.remove();

  for (const id of ids) {
    const row = courts[id];
    let tile = courtTiles.get(id);
    if (!tile) {
      tile = document.createElement('article');
      tile.className = 'court-tile';
      tile.dataset.court = id;
      tile.innerHTML = `
        <div class="tile-head"><h3>${esc(courtLabel(id))}</h3><span class="chip"></span></div>
        <div class="tile-body"></div>
        <details class="more"><summary>More details</summary><div class="more-body"></div></details>
        <button type="button" class="link-btn track-here" data-track="${esc(id)}">+ Track a case here</button>`;
      courtTiles.set(id, tile);
      grid.appendChild(tile);
    }

    const chip = chipFor(row);
    const chipEl = tile.querySelector('.chip');
    chipEl.className = `chip chip-${chip.cls}`;
    chipEl.textContent = chip.text;

    const mine = state.cases.filter((c) => c.court === id);
    tile.classList.toggle('has-mine', mine.length > 0);
    const next = nextItems(row, 5);
    const mineHTML = mine.length ? `<ul class="mine">${mine.map((c) => {
      const s = statusFor(c);
      const short = s.state === 'now' ? 'on now' : (s.state === 'near' || s.state === 'close' || s.state === 'waiting') ? `${s.ahead} before yours` : STATUS_COPY[s.state](s).title.toLowerCase();
      return `<li data-state="${s.state}">Your item ${c.item}: ${esc(short)}</li>`;
    }).join('')}</ul>` : '';

    patch(tile.querySelector('.tile-body'), `
      <div class="tile-now">
        <span class="num-label">Now hearing</span>
        <span class="big">${row.current ?? '–'}</span>
      </div>
      <p class="tile-next"><span class="num-label">Next</span> ${next.length ? next.join(', ') : '–'}</p>
      ${mineHTML}
      ${benchHTML(id)}`);

    patch(tile.querySelector('.more-body'), `
      ${row.registration ? `<p><span class="more-label">Case</span> ${esc(row.registration)}</p>` : ''}
      ${row.petitioner || row.respondent ? `<p><span class="more-label">Parties</span> ${esc(row.petitioner || '–')} <em>vs</em> ${esc(row.respondent || '–')}</p>` : ''}
      ${row.name ? `<p><span class="more-label">Board name</span> ${esc(row.name)}</p>` : ''}
      <p class="more-label">Announced order</p>
      <p class="seq-text">${esc(row.sequenceText || 'Not announced')}</p>`);
  }
  for (const [id, tile] of courtTiles) {
    if (!(id in courts)) { tile.remove(); courtTiles.delete(id); }
  }
}

function applyOnlyMine() {
  const hasCases = state.cases.length > 0;
  const box = $('#only-mine');
  box.disabled = !hasCases;
  box.checked = state.onlyMine && hasCases;
  $('#only-mine-label').classList.toggle('disabled', !hasCases);
  $('#courts').classList.toggle('only-mine', box.checked);
}

function renderCourtOptions() {
  const select = $('#court-select');
  const current = select.value;
  const html = '<option value="">Choose a court</option>' +
    courtIds().map((id) => `<option value="${esc(id)}">${esc(courtLabel(id))}</option>`).join('');
  if (select.__html !== html) {
    select.innerHTML = html;
    select.__html = html;
    select.value = current;
  }
}

function renderAlertAheadOptions() {
  const select = $('#alert-ahead');
  select.innerHTML = ALERT_AHEAD_CHOICES.map((n) => `<option value="${n}">${plural(n, 'case')}</option>`).join('');
  if (!ALERT_AHEAD_CHOICES.includes(state.alertAhead)) {
    select.insertAdjacentHTML('beforeend', `<option value="${state.alertAhead}">${plural(state.alertAhead, 'case')}</option>`);
  }
  select.value = String(state.alertAhead);
}

function setRow(rowId, ok, warn = false) {
  const row = $(rowId);
  row.dataset.ok = ok ? 'yes' : warn ? 'warn' : 'no';
}

function renderSetup() {
  // Notifications
  const btn = $('#notif-btn');
  const desc = $('#notif-desc');
  if (!notifSupported()) {
    setRow('#row-notif', false, true);
    btn.hidden = true;
    desc.textContent = isIOS()
      ? 'On iPhone/iPad: tap Share, then “Add to Home Screen”, and open the app from there to get notifications.'
      : 'Not available in this browser. You will still get sound and on-screen alerts.';
  } else if (Notification.permission === 'granted') {
    setRow('#row-notif', true);
    btn.hidden = true;
    desc.textContent = 'On. You will get a pop-up even while using other tabs.';
  } else if (Notification.permission === 'denied') {
    setRow('#row-notif', false, true);
    btn.hidden = true;
    desc.textContent = 'Blocked. To fix: click the lock icon next to the web address, set Notifications to “Allow”, then reload this page.';
  } else {
    setRow('#row-notif', false);
    btn.hidden = false;
    desc.textContent = 'Off. Turn on to get pop-up messages, even while using other tabs.';
  }

  // Sound
  const soundSwitch = $('#sound-switch');
  soundSwitch.setAttribute('aria-checked', String(state.soundOn));
  const soundDesc = $('#sound-desc');
  if (!state.soundOn) {
    setRow('#row-sound', false);
    soundDesc.textContent = 'Off. Good for a quiet courtroom; you will still get notifications and vibration.';
  } else if (!audioReady()) {
    setRow('#row-sound', false, true);
    soundDesc.textContent = 'Tap anywhere on this page once so your browser allows sound.';
  } else {
    setRow('#row-sound', true);
    soundDesc.textContent = 'On. Beeps get louder as your case gets closer.';
  }

  // Keep screen on
  const wakeSwitch = $('#wake-switch');
  const wakeDesc = $('#wake-desc');
  if (!wakeSupported()) {
    setRow('#row-wake', false, true);
    wakeSwitch.disabled = true;
    wakeSwitch.setAttribute('aria-checked', 'false');
    wakeDesc.textContent = 'Not available in this browser. Keep your screen awake yourself if your phone sleeps.';
  } else {
    wakeSwitch.setAttribute('aria-checked', String(state.wakeWanted));
    setRow('#row-wake', !!wakeLock, state.wakeWanted && !wakeLock);
    wakeDesc.textContent = wakeLock
      ? 'On. Your screen will stay awake while this page is open.'
      : !state.wakeWanted
        ? 'Off. Turn on so your phone does not sleep while you wait.'
        : wakeRefused
          ? 'Your browser did not allow this (battery saver can block it). Keep your screen awake yourself.'
          : 'Will turn on when this page is on screen.';
  }
}

function renderStatus() {
  const strip = $('#status-strip');
  const text = $('#status-text');
  const time = state.lastOk?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (state.error === 'offline') {
    strip.dataset.state = 'error';
    text.textContent = `No internet connection. Retrying…${time ? ` Last update ${time}.` : ''}`;
  } else if (state.error === 'auth') {
    strip.dataset.state = 'error';
    text.textContent = 'Sign-in needed. Please reload the page.';
  } else if (state.error === 'server') {
    strip.dataset.state = 'error';
    text.textContent = `Court board is not responding. Retrying…${time ? ` Last update ${time}.` : ''}`;
  } else if (state.lastOk) {
    strip.dataset.state = 'live';
    text.textContent = `Live · checked at ${time}`;
  } else {
    strip.dataset.state = 'connecting';
    text.textContent = 'Connecting to the court board…';
  }
}

function renderLog() {
  const card = $('#log-card');
  card.hidden = state.log.length === 0;
  patch($('#notif-log'), state.log.map((l) =>
    `<li data-level="${esc(l.level)}"><span class="log-text"><strong>${esc(l.title)}</strong> ${esc(l.body)}</span><time>${esc(l.time)}</time></li>`
  ).join(''));
}

function renderAll() {
  renderCases();
  renderHotBanner();
  renderCourts();
  applyOnlyMine();
  renderSetup();
}

// ═══════════════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════════════

let pollTimer = null;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    const res = await fetch('/api/board', { cache: 'no-store' });
    if (res.status === 401) { state.error = 'auth'; return; }
    if (!res.ok) throw new Error(`board ${res.status}`);
    state.board = await res.json();
    state.lastOk = new Date();
    state.error = null;
    renderCourtOptions();
    renderAll();
    for (const a of dueAlerts(state.cases, state.board, state.alertAhead, state.fired, new Date().toDateString())) {
      fireAlert(a);
    }
  } catch (e) {
    console.warn('Board check failed:', e.message);
    state.error = navigator.onLine === false ? 'offline' : 'server';
  } finally {
    polling = false;
    renderStatus();
    // Keeps running while the tab is in the background (browsers may slow it down)
    pollTimer = setTimeout(poll, POLL_MS);
  }
}

async function fetchCoram() {
  try {
    const res = await fetch('/api/coram', { cache: 'no-store' });
    if (!res.ok) return;
    state.coram = await res.json();
    renderCourts();
  } catch (e) {
    console.error('Bench info unavailable:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════

function showFormError(message, field) {
  const el = $('#add-error');
  el.textContent = message;
  el.hidden = !message;
  for (const f of ['#court-select', '#item-input']) $(f).removeAttribute('aria-invalid');
  if (field) { $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); }
}

function addCase(e) {
  e.preventDefault();
  unlockAudio();
  const courtSelect = $('#court-select');
  const itemInput = $('#item-input');
  let court = courtSelect.value;
  let itemText = itemInput.value.trim();

  // Forgiving input: "3/12" typed into the item box
  const combined = itemText.match(/^(\S+)\s*\/\s*(\S+)$/);
  if (combined && normalizeCourt(combined[1])) {
    court = normalizeCourt(combined[1]);
    itemText = combined[2];
  }

  if (!court) return showFormError('Please choose a court.', '#court-select');
  if (!courtIds().includes(court)) {
    return showFormError(`There is no ${courtLabel(court)} on the board. Please choose a court from the list.`, '#court-select');
  }
  const item = parseItem(itemText);
  if (!item) return showFormError('Please type the item number as a whole number, like 12.', '#item-input');
  if (state.cases.some((c) => c.court === court && c.item === item)) {
    return showFormError(`You are already tracking ${courtLabel(court)}, item ${item}.`, '#item-input');
  }

  showFormError('');
  state.cases.push({ court, item });
  saveCases();
  itemInput.value = '';
  renderCourtOptions();
  courtSelect.value = court; // keep the court, ready for the next item
  renderAll();
  toast(`Tracking ${courtLabel(court)}, item ${item}`, { type: 'success' });
  checkNow();
  askNotificationPermission(); // asked right after the user's click, when browsers allow it
}

function removeCase(key) {
  const idx = state.cases.findIndex((c) => caseKey(c) === key);
  if (idx < 0) return;
  const [removed] = state.cases.splice(idx, 1);
  saveCases();
  renderAll();
  toast(`Removed ${courtLabel(removed.court)}, item ${removed.item}`, {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: () => {
        state.cases.splice(Math.min(idx, state.cases.length), 0, removed);
        saveCases();
        renderAll();
      },
    },
  });
}

// Fire alerts for newly added/changed cases straight away
function checkNow() {
  if (!state.board) return;
  for (const a of dueAlerts(state.cases, state.board, state.alertAhead, state.fired, new Date().toDateString())) {
    fireAlert(a);
  }
}

function trackHere(courtId) {
  renderCourtOptions();
  $('#court-select').value = courtId;
  showFormError('');
  $('#my-cases').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  $('#item-input').focus({ preventScroll: true });
}

async function runTest() {
  unlockAudio();
  await askNotificationPermission();
  const c = state.cases[0] || { court: '3', item: 12 };
  const steps = [
    { state: 'near', ahead: 3 },
    { state: 'close', ahead: 1 },
    { state: 'now', ahead: 0 },
  ];
  toast('Playing 3 test alerts over 4 seconds…');
  steps.forEach((s, i) => setTimeout(() => fireAlert({ ...c, ...s, current: Math.max(1, c.item - s.ahead) }, { test: true }), 600 + i * 1800));
}

function setTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  const btn = $('#theme-toggle');
  btn.setAttribute('aria-pressed', String(dark));
  $('#theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

function setGuide(show) {
  $('#guide').hidden = !show;
  if (!show) store.set('guideDone', '1');
}

// ═══════════════════════════════════════════════════════════════
// Wire up
// ═══════════════════════════════════════════════════════════════

function init() {
  setTheme(document.documentElement.classList.contains('dark'));
  $('#storage-note').hidden = store.persistent;
  setGuide(store.get('guideDone') !== '1');
  renderCourtOptions();
  renderAlertAheadOptions();
  renderAll();
  renderStatus();

  $('#add-form').addEventListener('submit', addCase);
  $('#court-select').addEventListener('change', () => showFormError(''));
  $('#item-input').addEventListener('input', () => { if (!$('#add-error').hidden) showFormError(''); });

  $('#case-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeCase(btn.dataset.remove);
  });
  $('#courts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-track]');
    if (btn) trackHere(btn.dataset.track);
  });

  $('#alert-ahead').addEventListener('change', (e) => {
    state.alertAhead = clampAlertAhead(e.target.value);
    store.set('alertAhead', state.alertAhead);
    renderAll();
    checkNow();
    toast(`Alerts will start ${plural(state.alertAhead, 'case')} before yours`);
  });

  $('#only-mine').addEventListener('change', (e) => {
    state.onlyMine = e.target.checked;
    store.set('onlyMine', state.onlyMine ? '1' : '0');
    applyOnlyMine();
  });

  $('#notif-btn').addEventListener('click', async () => {
    unlockAudio();
    await askNotificationPermission();
    if (Notification.permission === 'granted') toast('Notifications are on', { type: 'success' });
    else if (Notification.permission === 'denied') toast('Notifications are blocked. See the steps in the Alerts box.', { type: 'error', duration: 5000 });
  });

  $('#sound-switch').addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    store.set('soundOn', state.soundOn ? '1' : '0');
    unlockAudio();
    if (state.soundOn) setTimeout(() => beep('near'), 50); // let them hear it
    renderSetup();
  });

  $('#wake-switch').addEventListener('click', () => {
    state.wakeWanted = !state.wakeWanted;
    store.set('keepScreenOn', state.wakeWanted ? '1' : '0');
    applyWakeLock();
  });

  $('#test-btn').addEventListener('click', runTest);
  $('#theme-toggle').addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('dark');
    store.set('theme', dark ? 'dark' : 'light');
    setTheme(dark);
  });
  $('#guide-close').addEventListener('click', () => { setGuide(false); $('#court-select').focus(); });
  $('#guide-open').addEventListener('click', () => { setGuide(true); $('#guide').scrollIntoView({ block: 'start' }); });

  // Browsers only allow sound after the first tap/click/key press
  for (const evt of ['pointerdown', 'keydown']) document.addEventListener(evt, unlockAudio, { once: true, capture: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      poll(); // refresh straight away when you come back
      applyWakeLock(); // the browser drops the screen lock when hidden
    }
  });
  window.addEventListener('online', poll);

  applyWakeLock();
  fetchCoram();
  setInterval(fetchCoram, CORAM_MS);
  poll();
}

init();
