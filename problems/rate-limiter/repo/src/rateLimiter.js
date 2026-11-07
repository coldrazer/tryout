'use strict';
// Sliding-window rate limiter.

function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> array of timestamps

  function allow(key) {
    const t = now();
    const list = hits.get(key) || [];
    if (list.length <= limit) {
      list.push(t);
      hits.set(key, list);
      return true;
    }
    return false;
  }

  function remaining(key) {
    const list = hits.get(key) || [];
    return limit - list.length;
  }

  function _size(key) {
    return (hits.get(key) || []).length;
  }

  return { allow, remaining, _size };
}

module.exports = { createLimiter };
