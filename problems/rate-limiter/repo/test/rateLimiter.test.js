'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLimiter } = require('../src/rateLimiter.js');

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('allows exactly `limit` requests in a window', () => {
  const c = clock();
  const rl = createLimiter({ limit: 3, windowMs: 1000, now: c.now });
  assert.deepEqual([rl.allow('u'), rl.allow('u'), rl.allow('u'), rl.allow('u')], [true, true, true, false]);
});

test('allows again after the window passes', () => {
  const c = clock();
  const rl = createLimiter({ limit: 2, windowMs: 1000, now: c.now });
  rl.allow('u'); rl.allow('u');
  assert.equal(rl.allow('u'), false);
  c.advance(1500);
  assert.equal(rl.allow('u'), true);
});
