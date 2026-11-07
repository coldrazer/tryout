'use strict';
function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();

  function allow(key) {
    const t = now();
    const list = (hits.get(key) || []).filter((ts) => t - ts < windowMs + 1);
    hits.set(key, list);
    if (list.length < limit) {
      list.push(t);
      return true;
    }
    return false;
  }

  function remaining(key) {
    return limit - (hits.get(key) || []).length;
  }

  function _size(key) {
    return (hits.get(key) || []).length;
  }

  return { allow, remaining, _size };
}

module.exports = { createLimiter };
