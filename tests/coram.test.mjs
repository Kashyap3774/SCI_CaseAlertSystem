import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCourtLinks, parseCoramFromDetail, onRequest } from '../functions/api/coram.js';

const BASE = 'https://wdb.sci.gov.in/';

test('each detail link is paired with the court row it sits in, even when a court has no link', () => {
  const html = `<table>
    <tr><td id="cl_1">1</td><td><a href="display_court_all_cases.php?t=AAA">view</a></td></tr>
    <tr><td id="cl_2">2</td><td>Not sitting</td></tr>
    <tr><td id="cl_3">3</td><td><a href="display_court_all_cases.php?t=CCC">view</a></td></tr>
  </table>`;
  assert.deepEqual(extractCourtLinks(html), [
    { court: '1', url: BASE + 'display_court_all_cases.php?t=AAA' },
    { court: '3', url: BASE + 'display_court_all_cases.php?t=CCC' },
  ]);
});

test('coram endpoint keys courts like /api/board does (21 → RC1) and keeps each bench with its court', async (t) => {
  const pages = {
    'get_board.php': `<td id="cl_5"></td><a href="display_court_all_cases.php?t=5">v</a>
                      <td id="cl_21"></td><a href="display_court_all_cases.php?t=21">v</a>`,
    't=5': `COURT - 5 [Coram : HON'BLE MR. JUSTICE A.B. SHARMA] [Whole Day]`,
    't=21': `[Coram : REGISTRAR X] [Time : 10:30 AM]`,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(pages).find((k) => String(url).includes(k));
    return key ? new Response(pages[key]) : new Response('not found', { status: 404 });
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.caches; });

  const res = await onRequest({ request: new Request('https://x/api/coram'), env: {}, waitUntil: () => {} });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body.courts).sort(), ['5', 'RC1']);
  assert.equal(body.courts['5'].primaryJudges, "HON'BLE MR. JUSTICE A.B. SHARMA");
  assert.equal(body.courts['5'].primarySession, 'Whole Day');
  assert.equal(body.courts.RC1.primaryJudges, 'REGISTRAR X');
  assert.equal(body.courts.RC1.primarySession, 'Time : 10:30 AM');
});

test('a "REGISTRAR COURT - 1" page is not mistaken for Court 1', () => {
  assert.equal(parseCoramFromDetail('REGISTRAR COURT - 1 [Coram : REGISTRAR X]').courtNumber, undefined);
  assert.equal(parseCoramFromDetail('COURT - 4 [Coram : J]').courtNumber, '4');
});
