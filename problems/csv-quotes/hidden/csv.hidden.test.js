'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCSV } = require('../src/csv.js');

test('escaped double quotes', () => {
  assert.deepEqual(parseCSV('a,b\n"She said ""hi""",x'), [['a', 'b'], ['She said "hi"', 'x']]);
});

test('newline inside a quoted field', () => {
  assert.deepEqual(parseCSV('id,addr\n1,"123 Main St\nSuite 4"\n2,x'), [['id', 'addr'], ['1', '123 Main St\nSuite 4'], ['2', 'x']]);
});

test('CRLF line endings', () => {
  assert.deepEqual(parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('empty fields are preserved', () => {
  assert.deepEqual(parseCSV('a,,c\n,,'), [['a', '', 'c'], ['', '', '']]);
});

test('single trailing newline does not add an empty row', () => {
  assert.deepEqual(parseCSV('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('quoted empty string and quoted field at end of line', () => {
  assert.deepEqual(parseCSV('"",x,"end"'), [['', 'x', 'end']]);
});

test('large input parses quickly', () => {
  const row = 'alpha,"beta, gamma","de""lta"\n';
  const text = row.repeat(20000);
  const t0 = Date.now();
  const rows = parseCSV(text);
  assert.equal(rows.length, 20000);
  assert.deepEqual(rows[19999], ['alpha', 'beta, gamma', 'de"lta']);
  assert.ok(Date.now() - t0 < 2000);
});
