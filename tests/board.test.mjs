// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSequence, normalize } from '../functions/api/board.js';

test('parses "to" ranges and single numbers', () => {
  assert.deepEqual(parseSequence('Sequence would be item nos. 1 to 5, 10, 12'), [1, 2, 3, 4, 5, 10, 12]);
});

test('parses descending "to" ranges', () => {
  assert.deepEqual(parseSequence('ITEMS 10 TO 7'), [10, 9, 8, 7]);
});

test('parses hyphen and en-dash ranges', () => {
  assert.deepEqual(parseSequence('1-5, 8'), [1, 2, 3, 4, 5, 8]);
  assert.deepEqual(parseSequence('3 – 5'), [3, 4, 5]);
});

test('reads numbers wrapped in HTML tags', () => {
  assert.deepEqual(parseSequence('<b>12</b>, 13'), [12, 13]);
});

test('"court will sit at" removes only its own line when lines are split by <br>', () => {
  assert.deepEqual(parseSequence('3, 4<br>Court will sit at 2 PM<br />5, 6'), [3, 4, 5, 6]);
});

test('huge "to" ranges are bounded', () => {
  const seq = parseSequence('1 to 100000');
  assert.equal(seq[0], 1);
  assert.equal(seq[1], 2);
  assert.ok(seq.length <= 501, `length was ${seq.length}`);
});

test('normalize keeps line breaks in sequence text and decodes entities', () => {
  const out = normalize({
    listedItemDetails: [
      { court_no: 1, item_no: '3', court_message: '3, 4<br>5, 6', petitioner_name: 'A &amp; B', respondent_name: 'Union&nbsp;of India' },
    ],
  });
  assert.equal(out.courts['1'].sequenceText, '3, 4\n5, 6');
  assert.deepEqual(out.courts['1'].sequence, [3, 4, 5, 6]);
  assert.equal(out.courts['1'].petitioner, 'A & B');
  assert.equal(out.courts['1'].respondent, 'Union of India');
});

test('normalize renames registrar courts 21 and 22', () => {
  const out = normalize({ listedItemDetails: [{ court_no: 21, item_no: '4' }, { court_no: '22', item_no: null }] });
  assert.deepEqual(Object.keys(out.courts), ['RC1', 'RC2']);
  assert.equal(out.courts.RC1.current, 4);
  assert.equal(out.courts.RC2.current, null);
});

test('a date like 23-03-2026 is not read as a range', () => {
  assert.deepEqual(parseSequence('Listed on 23-03-2026: 1 to 3'), [1, 2, 3]);
});
