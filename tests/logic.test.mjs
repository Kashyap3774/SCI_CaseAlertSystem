import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCourt, courtLabel, parseItem, clampAlertAhead, migrateLegacyMatters,
  caseStatus, dueAlerts, formatJudgeName, nextItems,
} from '../public/logic.js';

const row = (current, sequence = []) => ({ current, sequence });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('court input accepts the ways people write it; 21/22 are the registrar courts', () => {
  const cases = { '3': '3', ' c3 ': '3', 'C 03': '3', '21': 'RC1', '22': 'RC2', 'rc1': 'RC1', 'RC 2': 'RC2' };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeCourt(input), want, input);
  for (const bad of ['', '0', '-2', 'x', 'RC3', '3a']) assert.equal(normalizeCourt(bad), null, bad);
});

test('court labels are spelled out', () => {
  assert.equal(courtLabel('3'), 'Court 3');
  assert.equal(courtLabel('RC2'), 'Registrar Court 2');
});

test('item numbers must be whole numbers from 1 up', () => {
  assert.equal(parseItem(' 12 '), 12);
  for (const bad of ['', '0', '-1', '12a', '1.5', null, undefined]) assert.equal(parseItem(bad), null, String(bad));
});

test('alert distance is kept between 1 and 20, default 5', () => {
  assert.equal(clampAlertAhead('8'), 8);
  assert.equal(clampAlertAhead('0'), 1);
  assert.equal(clampAlertAhead('99'), 20);
  assert.equal(clampAlertAhead('abc'), 5);
});

test('old saved "court/item" text is carried over, skipping junk and duplicates', () => {
  assert.deepEqual(migrateLegacyMatters('1/12\n8/34, 21/5, 1/, x/3, 1/12, C14/19'), [
    { court: '1', item: 12 }, { court: '8', item: 34 }, { court: 'RC1', item: 5 }, { court: '14', item: 19 },
  ]);
});

test('status: court not started when there is no current item', () => {
  assert.deepEqual(caseStatus(undefined, 12, 5), { state: 'not-started', ahead: null, current: null });
  assert.deepEqual(caseStatus(row(null, [1, 2]), 12, 5), { state: 'not-started', ahead: null, current: null });
});

test('status follows the announced order, not the raw numbers', () => {
  const seq = [1, 2, 3, 40, 41, 4, 5];
  assert.deepEqual(caseStatus(row(3, seq), 4, 5), { state: 'near', ahead: 3, current: 3 });
  assert.deepEqual(caseStatus(row(41, seq), 4, 5), { state: 'close', ahead: 1, current: 41 });
  assert.deepEqual(caseStatus(row(4, seq), 4, 5), { state: 'now', ahead: 0, current: 4 });
  assert.deepEqual(caseStatus(row(5, seq), 4, 5), { state: 'passed', ahead: -1, current: 5 });
  assert.deepEqual(caseStatus(row(1, seq), 5, 2), { state: 'waiting', ahead: 6, current: 1 });
});

test('status uses plain numbers when the court announced no order', () => {
  assert.deepEqual(caseStatus(row(7), 12, 5), { state: 'near', ahead: 5, current: 7 });
  assert.deepEqual(caseStatus(row(7), 30, 5), { state: 'waiting', ahead: 23, current: 7 });
  assert.deepEqual(caseStatus(row(9), 8, 5), { state: 'passed', ahead: -1, current: 9 });
});

test('status: item missing from the announced order', () => {
  assert.deepEqual(caseStatus(row(3, range(1, 10)), 50, 5), { state: 'not-listed', ahead: null, current: 3 });
  // still close by number → still worth an alert
  assert.deepEqual(caseStatus(row(10, range(1, 10)), 12, 5), { state: 'close', ahead: 2, current: 10 });
});

test('status: court is on an item outside its announced order', () => {
  assert.deepEqual(caseStatus(row(99, range(1, 10)), 5, 5), { state: 'off-order', ahead: null, current: 99 });
});

test('two cases in the same court each get their own alert, once per step', () => {
  const board = { courts: { '1': row(7, range(1, 20)) } };
  const cases = [{ court: '1', item: 9 }, { court: '1', item: 10 }];
  const fired = new Set();
  const first = dueAlerts(cases, board, 5, fired, 'day1');
  assert.deepEqual(first.map((a) => [a.item, a.state, a.ahead]), [[9, 'close', 2], [10, 'near', 3]]);
  assert.deepEqual(dueAlerts(cases, board, 5, fired, 'day1'), []); // same step → no repeat
  assert.equal(dueAlerts(cases, board, 5, fired, 'day2').length, 2); // next day → alerts again
});

test('no alerts for waiting, passed or not-started cases', () => {
  const board = { courts: { '1': row(2, range(1, 30)), '2': row(null) } };
  const cases = [{ court: '1', item: 20 }, { court: '1', item: 1 }, { court: '2', item: 3 }, { court: '9', item: 1 }];
  assert.deepEqual(dueAlerts(cases, board, 5, new Set(), 'd'), []);
});

test('judge names are tidied into normal capitalisation', () => {
  assert.equal(formatJudgeName("HON'BLE MR. JUSTICE J.K. MAHESHWARI"), 'Justice J.K. Maheshwari');
  assert.equal(formatJudgeName('HON’BLE MS. JUSTICE B.V. NAGARATHNA'), 'Justice B.V. Nagarathna');
  assert.equal(formatJudgeName("HON'BLE THE CHIEF JUSTICE"), 'Chief Justice of India');
  assert.equal(formatJudgeName("HON'BLE DR. JUSTICE D'SOUZA-RAO"), "Justice (Dr.) D'Souza-Rao");
  assert.equal(formatJudgeName('REGISTRAR X'), 'Registrar X');
});

test('next items are the ones after the current item in the announced order', () => {
  assert.deepEqual(nextItems(row(3, [1, 2, 3, 9, 4, 5, 6, 7]), 4), [9, 4, 5, 6]);
  assert.deepEqual(nextItems(row(null, [1, 2]), 4), []);
  assert.deepEqual(nextItems(row(50, [1, 2]), 4), []);
});
