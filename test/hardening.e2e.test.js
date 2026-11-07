'use strict';
// HARDENING — regression tests for the issues found in the Nov 7 audit.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startServer } = require('./helpers');

let S;
test.before(async () => {
  S = await startServer({ TRYOUT_MAX_STORED_RUNS: '3', TRYOUT_LIVE_GRACE_MS: '200', TRYOUT_MAX_CONCURRENT_RUNS: '4' });
});
test.after(async () => {
  await S.stop();
});

/** Raw request so we control Host/Origin/Content-Type exactly like a browser would. */
function raw(method, path, { headers = {}, body } = {}) {
  const u = new URL(S.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('CSRF: cross-site "simple" POST (text/plain) is rejected and has no effect', async () => {
  const before = (await S.api('/api/candidates')).json.length;
  const r = await raw('POST', '/api/candidates', { headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body: '{"name":"Injected"}' });
  assert.equal(r.status, 403);
  const r2 = await raw('POST', '/api/candidates', { headers: { 'content-type': 'text/plain' }, body: '{"name":"Injected"}' });
  assert.equal(r2.status, 415);
  const r3 = await raw('POST', '/api/candidates', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Injected' });
  assert.equal(r3.status, 415);
  assert.equal((await S.api('/api/candidates')).json.length, before);
});

test('CSRF: foreign or null Origin is rejected on every write, even with JSON', async () => {
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1']) {
    const r = await raw('POST', '/api/runs', { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ problemId: 'csv-quotes', candidateIds: ['maya'] }) });
    assert.equal(r.status, 403, origin);
  }
  const del = await raw('DELETE', '/api/candidates/maya', { headers: { origin: 'https://evil.example' } });
  assert.equal(del.status, 403);
  assert.ok((await S.api('/api/candidates')).json.some((c) => c.id === 'maya'));
});

test('DNS rebinding: writes addressed to an untrusted hostname are rejected', async () => {
  const u = new URL(S.base);
  const host = `rebind.evil.example:${u.port}`;
  const r = await raw('POST', '/api/runs', { headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ problemId: 'csv-quotes', candidateIds: ['maya'] }) });
  assert.equal(r.status, 403);
  assert.match(r.body, /not allowed/);
  // reads still work (they expose nothing private)
  assert.equal((await raw('GET', '/api/health', { headers: { host } })).status, 200);
});

test('same-origin browser writes still work (localhost and IP hosts)', async () => {
  const u = new URL(S.base);
  for (const host of [`127.0.0.1:${u.port}`, `localhost:${u.port}`]) {
    const r = await raw('POST', '/api/candidates', { headers: { host, origin: `http://${host}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ name: `Same Origin ${host}` }) });
    assert.equal(r.status, 201, `${host}: ${r.body}`);
    const id = JSON.parse(r.body).id;
    assert.equal((await raw('DELETE', `/api/candidates/${id}`, { headers: { host, origin: `http://${host}` } })).status, 200);
  }
});

test('TRYOUT_PUBLIC_URL / TRYOUT_ALLOWED_HOSTS hostnames are trusted', async () => {
  const A = await startServer({ TRYOUT_PUBLIC_URL: 'https://tryout.example.com', TRYOUT_ALLOWED_HOSTS: 'stage.local' });
  try {
    const u = new URL(A.base);
    for (const name of ['tryout.example.com', 'stage.local']) {
      const r = await new Promise((resolve) => {
        const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/api/candidates', headers: { host: name, origin: `https://${name}`, 'content-type': 'application/json' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.end(JSON.stringify({ name: 'Proxied' }));
      });
      assert.equal(r, 201, name);
    }
  } finally {
    await A.stop();
  }
});

test('health reports a passing sandbox self-test', async () => {
  let h;
  for (let i = 0; i < 60; i++) {
    h = (await S.api('/api/health')).json;
    if (h.selfTest.state !== 'pending') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(h.selfTest.state, 'passed', JSON.stringify(h.selfTest));
  assert.equal(h.ok, true);
});

test('SSE: malformed Last-Event-ID replays the full log instead of nothing', async () => {
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'] } });
  await S.waitRun(r.json.id);
  const count = async (headers) => ((await (await fetch(`${S.base}/api/runs/${r.json.id}/events`, { headers })).text()).match(/^event: /gm) || []).length;
  const full = await count({});
  assert.ok(full > 5);
  assert.equal(await count({ 'last-event-id': 'abc' }), full);
  assert.equal(await count({ 'last-event-id': '-5' }), full);
  assert.equal(await count({ 'last-event-id': '3' }), full - 3);
});

test('invalid poster email is rejected at run start; names cannot inject line breaks', async () => {
  const bad = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'], poster: { email: 'x@y' } } });
  assert.equal(bad.status, 400);
  const ok = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'], poster: { name: 'Line\r\nBcc: victim@example.com', email: 'p@example.com' } } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.poster.name, 'Line Bcc: victim@example.com');
  await S.waitRun(ok.json.id);
});

test('concurrent intro requests create exactly one intro', async () => {
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'] } });
  await S.waitRun(r.json.id);
  const results = await Promise.all(Array.from({ length: 5 }, () => S.api(`/api/runs/${r.json.id}/intro`, { method: 'POST', body: {} })));
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409, 409, 409, 409]);
});

test('old finished runs are pruned (bounded memory and runs.json)', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'] } });
    ids.push(r.json.id);
    await S.waitRun(r.json.id);
  }
  await new Promise((r) => setTimeout(r, 600)); // grace period lapses
  const list = (await S.api('/api/runs')).json;
  assert.ok(list.length <= 3, `kept ${list.length}`);
  assert.equal((await S.api(`/api/runs/${ids[4]}`)).status, 200, 'newest run kept');
  assert.equal((await S.api(`/api/runs/${ids[0]}`)).status, 404, 'oldest run pruned');
  const fs = require('node:fs');
  const saved = JSON.parse(fs.readFileSync(require('node:path').join(S.dataDir, 'runs.json'), 'utf8'));
  assert.ok(Object.keys(saved).length <= 3);
});

test('event ids stay unique and increasing', async () => {
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'worker-500', candidateIds: ['maya', 'leo', 'sam'] } });
  await S.waitRun(r.json.id);
  const text = await (await fetch(`${S.base}/api/runs/${r.json.id}/events`)).text();
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(ids.length > 10);
  assert.ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'ids not strictly increasing');
});
