'use strict';
/* Shared helpers for index.html and consent.html. All user data goes through textContent. */
(function () {
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const admin = store.get('tryout.admin');
    if (admin) headers['x-admin-token'] = admin;
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401 && !opts._retried) {
      const tok = window.prompt('This Tryout server requires an admin token:');
      if (tok) {
        store.set('tryout.admin', tok);
        return api(path, { ...opts, _retried: true });
      }
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join('');
  }

  function avatar(c, idx = 0) {
    const el = h('div', { class: `avatar c${(idx % 4) + 1}`, 'aria-hidden': 'true' });
    if (c && c.avatarUrl && /^https:\/\/avatars\.githubusercontent\.com\//.test(c.avatarUrl)) {
      el.append(h('img', { src: c.avatarUrl, alt: '' }));
    } else el.textContent = initials(c && c.name);
    return el;
  }

  function renderDiff(text) {
    const box = h('div', { class: 'diff' });
    if (!text) {
      box.append(h('div', { class: 'file', text: '(no source changes)' }));
      return box;
    }
    for (const line of text.split('\n')) {
      let cls = '';
      if (line.startsWith('+++') || line.startsWith('---')) cls = 'file';
      else if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      box.append(h('div', { class: cls, text: line || ' ' }));
    }
    return box;
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  window.UI = { h, api, store, initials, avatar, renderDiff, fmtClock };
})();
