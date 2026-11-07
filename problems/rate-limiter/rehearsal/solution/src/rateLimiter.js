'use strict';
// Sliding-window rate limiter.

function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> array of timestamps (ascending)

  function prune(key, t) {
    const list = hits.get(key);
    if (!list) return [];
    let i = 0;
    while (i < list.length && t - list[i] >= windowMs) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) hits.delete(key);
    return list;
  }

  function allow(key) {
    const t = now();
    const list = prune(key, t);
    if (list.length < limit) {
      list.push(t);
      hits.set(key, list);
      return true;
    }
    return false;
  }

  function remaining(key) {
    return Math.max(0, limit - prune(key, now()).length);
  }

  function _size(key) {
    return (hits.get(key) || []).length;
  }

  return { allow, remaining, _size };
}

module.exports = { createLimiter };
