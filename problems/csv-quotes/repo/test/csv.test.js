'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCSV } = require('../src/csv.js');

test('parses simple rows', () => {
  assert.deepEqual(parseCSV('name,city\nAda,London'), [['name', 'city'], ['Ada', 'London']]);
});

test('quoted field with a comma stays in one column', () => {
  assert.deepEqual(parseCSV('name,city\nChris,"Bakersfield, CA"'), [['name', 'city'], ['Chris', 'Bakersfield, CA']]);
});
