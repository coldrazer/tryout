'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLimiter } = require('../src/rateLimiter.js');

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('keys are independent', () => {
  const c = clock();
  const rl = createLimiter({ limit: 1, windowMs: 1000, now: c.now });
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('b'), true);
  assert.equal(rl.allow('a'), false);
});

test('a request exactly windowMs old no longer counts', () => {
  const c = clock();
  const rl = createLimiter({ limit: 1, windowMs: 1000, now: c.now });
  assert.equal(rl.allow('u'), true);
  c.advance(1000);
  assert.equal(rl.allow('u'), true);
});

test('window slides (not fixed buckets)', () => {
  const c = clock();
  const rl = createLimiter({ limit: 2, windowMs: 1000, now: c.now });
  rl.allow('u'); // t=0
  c.advance(600);
  rl.allow('u'); // t=600
  c.advance(500); // t=1100: first expired, second still counts
  assert.equal(rl.allow('u'), true);
  assert.equal(rl.allow('u'), false);
});

test('remaining() reflects the sliding window and never goes negative', () => {
  const c = clock();
  const rl = createLimiter({ limit: 2, windowMs: 1000, now: c.now });
  assert.equal(rl.remaining('u'), 2);
  rl.allow('u'); rl.allow('u'); rl.allow('u');
  assert.equal(rl.remaining('u'), 0);
  c.advance(1000);
  assert.equal(rl.remaining('u'), 2);
});

test('denied requests do not consume quota', () => {
  const c = clock();
  const rl = createLimiter({ limit: 1, windowMs: 1000, now: c.now });
  rl.allow('u');
  for (let i = 0; i < 50; i++) rl.allow('u');
  assert.ok(rl._size('u') <= 1);
});

test('old timestamps are pruned from memory', () => {
  const c = clock();
  const rl = createLimiter({ limit: 5, windowMs: 100, now: c.now });
  for (let i = 0; i < 1000; i++) {
    rl.allow('u');
    c.advance(10);
  }
  assert.ok(rl._size('u') <= 10, `size was ${rl._size('u')}`);
});
