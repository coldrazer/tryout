'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle } = require('../src/handler.js');

const req = (o) => ({ method: 'POST', url: '/api/signup', headers: { 'content-type': 'application/json' }, body: '', ...o });

test('malformed JSON returns 400 with error body', async () => {
  const res = await handle(req({ body: '{"email": ' }));
  assert.equal(res.status, 400);
  assert.ok(JSON.parse(res.body).error);
});

test('content-type with charset parameter is accepted', async () => {
  const res = await handle(req({ headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ email: 'linus@example.com' }) }));
  assert.equal(res.status, 201);
});

test('text/plain returns 415', async () => {
  const res = await handle(req({ headers: { 'content-type': 'text/plain' }, body: 'hi' }));
  assert.equal(res.status, 415);
});

test('GET returns 405 with Allow: POST', async () => {
  const res = await handle(req({ method: 'GET', body: undefined }));
  assert.equal(res.status, 405);
  const allow = res.headers.allow || res.headers.Allow;
  assert.match(String(allow), /POST/);
});

test('JSON that is not an object returns 400', async () => {
  for (const body of ['null', '42', '"str"', '[1,2]']) {
    const res = await handle(req({ body }));
    assert.equal(res.status, 400, `body ${body}`);
  }
});

test('missing headers object does not throw', async () => {
  const res = await handle({ method: 'POST', url: '/api/signup', body: '{}' });
  assert.ok([400, 415].includes(res.status));
});

test('invalid email still 422', async () => {
  const res = await handle(req({ body: JSON.stringify({ email: 'nope' }) }));
  assert.equal(res.status, 422);
});
