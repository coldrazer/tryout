'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle } = require('../src/handler.js');

const req = (o) => ({ method: 'POST', url: '/api/signup', headers: { 'Content-Type': 'application/json' }, body: '', ...o });

test('valid signup returns 201', async () => {
  const res = await handle(req({ body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }) }));
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.body).email, 'ada@example.com');
});

test('empty body returns 400, not 500', async () => {
  const res = await handle(req({ body: '' }));
  assert.equal(res.status, 400);
});

test('lowercase content-type header is accepted', async () => {
  const res = await handle(req({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'grace@example.com' }) }));
  assert.equal(res.status, 201);
});
