// public/logic.js — pure helpers for the app (no DOM), unit-tested in tests/logic.test.mjs

// ── Courts & items ──

// "3", "C3", "c 03" → "3"; "21"/"RC1" → "RC1"; "22"/"RC2" → "RC2"; anything else → null
export function normalizeCourt(input) {
  const s = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const rc = s.match(/^RC([12])$/);
  if (rc) return 'RC' + rc[1];
  const num = s.replace(/^C/, '');
  if (!/^\d+$/.test(num)) return null;
  const n = parseInt(num, 10);
  if (n === 21) return 'RC1';
  if (n === 22) return 'RC2';
  return n >= 1 ? String(n) : null;
}

export function courtLabel(id) {
  return id.startsWith('RC') ? `Registrar Court ${id.slice(2)}` : `Court ${id}`;
}

// Whole number from 1 up, else null
export function parseItem(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 ? n : null;
}

export const DEFAULT_ALERT_AHEAD = 5;
export const MAX_ALERT_AHEAD = 20;

export function clampAlertAhead(input) {
  const n = parseInt(input, 10);
  if (!Number.isFinite(n)) return DEFAULT_ALERT_AHEAD;
  return Math.min(MAX_ALERT_AHEAD, Math.max(1, n));
}

// Earlier versions saved cases as free text: "1/12, 8/34"
export function migrateLegacyMatters(text) {
  const out = [];
  for (const part of String(text || '').split(/[,\n]/)) {
    const [c, it] = part.split('/');
    const court = normalizeCourt(c);
    const item = parseItem(it);
    if (court && item && !out.some((x) => x.court === court && x.item === item)) out.push({ court, item });
  }
  return out;
}

// ── Where is my case? ──
//
// state:  not-started | waiting | near | close | now | passed | not-listed | off-order
// ahead:  how many items are still before yours (0 = yours is on now)

const CLOSE = 2; // "get ready" zone

function stateFor(ahead, alertAhead) {
  if (ahead < 0) return 'passed';
  if (ahead === 0) return 'now';
  if (ahead <= Math.min(CLOSE, alertAhead)) return 'close';
  if (ahead <= alertAhead) return 'near';
  return 'waiting';
}

export function caseStatus(courtRow, item, alertAhead) {
  const current = courtRow?.current ?? null;
  if (current == null) return { state: 'not-started', ahead: null, current: null };

  const seq = courtRow.sequence || [];
  const result = (ahead) => ({ state: stateFor(ahead, alertAhead), ahead, current });

  if (current === item) return result(0);
  if (!seq.length) return result(item - current); // no announced order → plain numbers

  const idxItem = seq.indexOf(item);
  const idxCurrent = seq.indexOf(current);
  if (idxItem >= 0 && idxCurrent >= 0) return result(idxItem - idxCurrent);

  if (idxItem < 0) {
    // Not in the announced order; still alert if it's close by number
    const ahead = item - current;
    if (ahead >= 0 && ahead <= alertAhead) return result(ahead);
    return { state: 'not-listed', ahead: null, current };
  }
  return { state: 'off-order', ahead: null, current };
}

const ALERT_STATES = new Set(['near', 'close', 'now']);

// Alerts that should fire now. Each case alerts once per item the court reaches,
// per day; `fired` remembers what already went out.
export function dueAlerts(cases, board, alertAhead, fired, day) {
  const due = [];
  for (const c of cases) {
    const s = caseStatus(board?.courts?.[c.court], c.item, alertAhead);
    if (!ALERT_STATES.has(s.state)) continue;
    const key = `${day}|${c.court}/${c.item}@${s.current}`;
    if (fired.has(key)) continue;
    fired.add(key);
    due.push({ court: c.court, item: c.item, ...s });
  }
  return due;
}

export function nextItems(courtRow, count) {
  const seq = courtRow?.sequence || [];
  const idx = courtRow?.current == null ? -1 : seq.indexOf(courtRow.current);
  return idx < 0 ? [] : seq.slice(idx + 1, idx + 1 + count);
}

// ── Judges ──

const titleCaseWord = (w) =>
  /^([A-Z]\.)+[A-Z]?$/i.test(w) // initials: J.K. / B.V.
    ? w.toUpperCase()
    : w.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (_, p, ch) => p + ch.toUpperCase());

// "HON'BLE MR. JUSTICE J.K. MAHESHWARI" → "Justice J.K. Maheshwari"
export function formatJudgeName(raw) {
  const s = String(raw || '').replace(/HON['’]?BLE\s*/gi, '').replace(/\s+/g, ' ').trim();
  if (/^THE CHIEF JUSTICE$/i.test(s)) return 'Chief Justice of India';
  const m = s.match(/^(MR|MS|MRS|DR)\.?\s*JUSTICE\s+(.+)$/i);
  const prefix = !m ? '' : m[1].toUpperCase() === 'DR' ? 'Justice (Dr.) ' : 'Justice ';
  const name = m ? m[2] : s;
  return prefix + name.split(' ').map(titleCaseWord).join(' ');
}
