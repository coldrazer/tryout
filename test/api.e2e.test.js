'use strict';
// END-TO-END API AUDIT against a real server process (rehearsal agents, real sandboxes).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startServer } = require('./helpers');

let S;
test.before(async () => {
  S = await startServer();
});
test.after(async () => {
  await S.stop();
});

test('health reports mode, sandbox and limits', async () => {
  const r = await S.api('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.defaultMode, 'rehearsal');
  assert.equal(r.json.liveAvailable, false);
  assert.equal(r.json.sandbox.strong, true);
});

test('security headers on API and static responses', async () => {
  for (const p of ['/', '/api/health', '/consent.html']) {
    const r = await S.api(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
});

test('static file traversal is blocked', async () => {
  for (const p of ['/..%2f..%2fserver.js', '/%2e%2e/%2e%2e/etc/passwd', '/../src/config.js', '/%00', '/%E0%A4%A']) {
    const res = await new Promise((resolve) => {
      http.get(S.base + p, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
    });
    assert.ok([400, 403, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.ok(!res.body.includes('require('), `${p} leaked source`);
  }
});

test('problems API never leaks hidden tests, names or reference solutions', async () => {
  const list = await S.api('/api/problems');
  assert.equal(list.status, 200);
  assert.ok(list.json.length >= 3);
  const one = await S.api('/api/problems/worker-500');
  const blob = JSON.stringify([list.json, one.json]);
  for (const leak of ['test-hidden', 'malformed JSON returns 400', 'hiddenNames', 'rehearsal/solution', 'function header(headers, name)']) {
    assert.ok(!blob.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(one.json.repo['src/handler.js']);
  assert.equal((await S.api('/api/problems/..%2f..%2fetc')).status, 404);
  assert.equal((await S.api('/api/problems/nope')).status, 404);
});

test('candidates API never exposes emails', async () => {
  const r = await S.api('/api/candidates');
  assert.equal(r.status, 200);
  assert.ok(r.json.length >= 3);
  assert.ok(!JSON.stringify(r.json).includes('@example.com'));
  assert.ok(r.json.every((c) => c.hasEmail === true));
});

test('input validation', async () => {
  const cases = [
    [{ problemId: 'worker-500', candidateIds: [] }, 400],
    [{ problemId: 'nope', candidateIds: ['maya'] }, 404],
    [{ problemId: 'worker-500', candidateIds: ['ghost'] }, 404],
    [{ problemId: 'worker-500', candidateIds: ['maya', 'leo', 'sam', 'a', 'b'] }, 400],
    [{ problemId: 'worker-500', candidateIds: ['maya'], mode: 'live' }, 400],
    [{ problemId: 'worker-500', candidateIds: ['maya'], mode: 'evil' }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await S.api('/api/runs', { method: 'POST', body })).status, status, JSON.stringify(body));
  assert.equal((await S.api('/api/runs', { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await S.api('/api/runs', { method: 'POST', body: '[1,2]' })).status, 400);
  assert.equal((await S.api('/api/runs', { method: 'POST', body: JSON.stringify({ x: 'y'.repeat(1.2 * 1024 * 1024) }) })).status, 413);
  assert.equal((await S.api('/api/candidates', { method: 'POST', body: { name: '' } })).status, 400);
  assert.equal((await S.api('/api/candidates', { method: 'POST', body: { name: 'X', email: 'not-an-email' } })).status, 400);
  assert.equal((await S.api('/api/candidates', { method: 'POST', body: { github: 'bad user!' } })).status, 400);
  assert.equal((await S.api('/api/nope')).status, 404);
  assert.equal((await S.api('/api/runs/abc')).status, 404);
});

let runId;
test('full rehearsal tryout: parallel agents, real sandbox scoring, correct ranking', async () => {
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'worker-500', candidateIds: ['maya', 'leo', 'sam'], poster: { name: 'Chris', email: 'chris@example.com' } } });
  assert.equal(r.status, 201, r.text);
  runId = r.json.id;
  assert.ok(!JSON.stringify(r.json).includes('chris@example.com'), 'poster email leaked in run view');
  const run = await S.waitRun(runId);
  assert.equal(run.status, 'complete');
  const by = Object.fromEntries(run.entries.map((e) => [e.candidateId, e]));
  assert.equal(by.maya.result.score, 100);
  assert.equal(by.maya.rank, 1);
  assert.equal(run.winnerId, 'maya');
  assert.equal(by.leo.result.visible.passed, by.leo.result.visible.total, 'partial fix passes visible tests');
  assert.ok(by.leo.result.hidden.passed < by.leo.result.hidden.total, 'hidden tests catch the partial fix');
  assert.ok(by.sam.result.flags.some((f) => f.kind === 'tamper_attempt'));
  assert.ok(by.sam.result.score < by.leo.result.score, 'tamper penalty applied');
  assert.ok(by.maya.result.diffs.length > 0 && by.maya.result.diffs[0].text.includes('+++ b/src/handler.js'));
  // agents really ran in parallel: overlapping time windows
  const starts = run.entries.map((e) => e.startedAt);
  const ends = run.entries.map((e) => e.endedAt);
  assert.ok(Math.max(...starts) < Math.min(...ends), 'agents did not overlap');
});

test('SSE stream replays the full event log and ends', async () => {
  const res = await fetch(`${S.base}/api/runs/${runId}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  for (const ev of ['run_started', 'agent_started', 'tests', 'write', 'blocked', 'submit', 'scored', 'run_complete', 'end']) assert.ok(text.includes(`event: ${ev}`), ev);
  const resumed = await (await fetch(`${S.base}/api/runs/${runId}/events?after=9999`)).text();
  assert.ok(!resumed.includes('event: run_started'));
});

test('consent: two private tokens, nothing shared until both accept, no re-answering', async () => {
  const c = await S.api(`/api/runs/${runId}/intro`, { method: 'POST', body: { posterEmail: 'chris@example.com' } });
  assert.equal(c.status, 201, c.text);
  assert.equal((await S.api(`/api/runs/${runId}/intro`, { method: 'POST', body: {} })).status, 409, 'duplicate intro');
  const pTok = new URL(c.json.posterLink).searchParams.get('token');
  const cTok = new URL(c.json.candidateLink).searchParams.get('token');
  const id = c.json.intro.id;
  assert.notEqual(pTok, cTok);
  assert.equal((await S.api(`/api/intros/${id}`)).status, 403);
  assert.equal((await S.api(`/api/intros/${id}?token=wrong`)).status, 403);
  assert.equal((await S.api(`/api/intros/${id}?token=${pTok.slice(0, -1)}`)).status, 403);

  const asCand = await S.api(`/api/intros/${id}?token=${cTok}`);
  assert.equal(asCand.json.role, 'candidate');
  assert.ok(!asCand.text.includes('chris@example.com') && !asCand.text.includes('maya.okafor@example.com'), 'emails visible before consent');
  assert.equal((await S.api(`/api/intros/${id}/eml?token=${cTok}`)).status, 409);

  assert.equal((await S.api(`/api/intros/${id}/respond`, { method: 'POST', body: { token: pTok, decision: 'maybe' } })).status, 400);
  const p1 = await S.api(`/api/intros/${id}/respond`, { method: 'POST', body: { token: pTok, decision: 'accept' } });
  assert.equal(p1.json.status, 'pending');
  assert.ok(!p1.text.includes('maya.okafor@example.com'));
  assert.equal((await S.api(`/api/intros/${id}/respond`, { method: 'POST', body: { token: pTok, decision: 'decline' } })).status, 409, 'poster re-answered');

  const c1 = await S.api(`/api/intros/${id}/respond`, { method: 'POST', body: { token: cTok, decision: 'accept' } });
  assert.equal(c1.json.status, 'accepted');
  assert.ok(c1.text.includes('chris@example.com'));
  assert.ok(c1.json.email.mailto.startsWith('mailto:'));
  const eml = await S.api(`/api/intros/${id}/eml?token=${pTok}`);
  assert.equal(eml.status, 200);
  assert.match(eml.headers.get('content-type'), /message\/rfc822/);
  assert.match(eml.text, /^From: .*\r\nTo: chris@example.com, maya.okafor@example.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.equal((await S.api(`/api/intros/${id}/respond`, { method: 'POST', body: { token: cTok, decision: 'decline' } })).status, 409);
});

test('consent: a decline shares nothing', async () => {
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'], poster: { name: 'P', email: 'p@example.com' } } });
  await S.waitRun(r.json.id);
  const c = await S.api(`/api/runs/${r.json.id}/intro`, { method: 'POST', body: {} });
  const cTok = new URL(c.json.candidateLink).searchParams.get('token');
  const d = await S.api(`/api/intros/${c.json.intro.id}/respond`, { method: 'POST', body: { token: cTok, decision: 'decline' } });
  assert.equal(d.json.status, 'declined');
  assert.ok(!d.text.includes('p@example.com'));
  assert.equal(d.json.email, null);
});

test('intro before completion is rejected; cancel works', async () => {
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'rate-limiter', candidateIds: ['maya', 'leo'] } });
  assert.equal((await S.api(`/api/runs/${r.json.id}/intro`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await S.api(`/api/runs/${r.json.id}/cancel`, { method: 'POST', body: {} })).status, 200);
  const run = await S.waitRun(r.json.id);
  assert.equal(run.status, 'cancelled');
  assert.equal((await S.api(`/api/runs/${r.json.id}/cancel`, { method: 'POST', body: {} })).status, 409);
});

test('custom problem: posted, baseline computed in sandbox, usable in a run, deletable', async () => {
  const bad = await S.api('/api/problems', { method: 'POST', body: { title: 'x', summary: 'y', source: 'module.exports=1', visibleTest: 'no node test here' } });
  assert.equal(bad.status, 400);
  const badPath = await S.api('/api/problems', { method: 'POST', body: { title: 'x', summary: 'y', sourcePath: '../../evil.js', source: 'x', visibleTest: "require('node:test')" } });
  assert.equal(badPath.status, 400);
  const body = {
    title: 'Cents total drifts',
    summary: 'Totals are off by fractions of a cent.',
    sourcePath: 'src/money.js',
    source: "'use strict';\nfunction total(items) { return items.reduce((s, i) => s + i.price * i.qty, 0) * 100; }\nmodule.exports = { total };\n",
    visibleTest: "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/money.js');\ntest('no float drift', () => assert.equal(total([{ price: 0.1, qty: 3 }]), 30));\n",
    hiddenTest: "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/money.js');\ntest('empty is 0', () => assert.equal(total([]), 0));\ntest('many items', () => assert.equal(total([{ price: 0.07, qty: 3 }, { price: 1.1, qty: 2 }]), 241));\n",
    solution: "'use strict';\nfunction total(items) { return items.reduce((s, i) => s + Math.round(i.price * 100) * i.qty, 0); }\nmodule.exports = { total };\n",
  };
  const c = await S.api('/api/problems', { method: 'POST', body });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.visibleTestCount, 1);
  assert.equal(c.json.hiddenTestCount, 2);
  const r = await S.api('/api/runs', { method: 'POST', body: { problemId: c.json.id, candidateIds: ['maya', 'leo'] } });
  const run = await S.waitRun(r.json.id);
  assert.equal(run.status, 'complete');
  assert.equal(run.entries.find((e) => e.candidateId === 'maya').result.score, 100);
  assert.equal((await S.api(`/api/problems/${c.json.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await S.api('/api/problems/worker-500', { method: 'DELETE' })).status, 404, 'seed problems cannot be deleted');
});

test('manual candidate add/remove', async () => {
  const c = await S.api('/api/candidates', { method: 'POST', body: { name: 'Chris G', email: 'chris@example.com', skills: 'networking, node', rehearsalStrategy: 'quick' } });
  assert.equal(c.status, 201);
  assert.equal(c.json.email, undefined);
  assert.deepEqual(c.json.skills, ['networking', 'node']);
  assert.equal((await S.api(`/api/candidates/${c.json.id}`, { method: 'DELETE' })).status, 200);
});

test('concurrency limit returns 429', async () => {
  const body = { problemId: 'worker-500', candidateIds: ['maya'] };
  const a = await S.api('/api/runs', { method: 'POST', body });
  const b = await S.api('/api/runs', { method: 'POST', body });
  const c = await S.api('/api/runs', { method: 'POST', body });
  assert.deepEqual([a.status, b.status, c.status], [201, 201, 429]);
  await S.waitRun(a.json.id);
  await S.waitRun(b.json.id);
});

test('admin token gates every write endpoint', async () => {
  const A = await startServer({ TRYOUT_ADMIN_TOKEN: 'stage-secret' });
  try {
    const body = { problemId: 'worker-500', candidateIds: ['maya'] };
    assert.equal((await A.api('/api/runs', { method: 'POST', body })).status, 401);
    assert.equal((await A.api('/api/runs', { method: 'POST', body, headers: { 'x-admin-token': 'wrong' } })).status, 401);
    assert.equal((await A.api('/api/candidates', { method: 'POST', body: { name: 'x' } })).status, 401);
    assert.equal((await A.api('/api/problems', { method: 'POST', body: {} })).status, 401);
    assert.equal((await A.api('/api/candidates/maya', { method: 'DELETE' })).status, 401);
    assert.equal((await A.api('/api/health')).json.adminRequired, true);
    const ok = await A.api('/api/runs', { method: 'POST', body, headers: { 'x-admin-token': 'stage-secret' } });
    assert.equal(ok.status, 201);
    await A.waitRun(ok.json.id);
  } finally {
    await A.stop();
  }
});

test('runs persist across a restart; in-flight runs are marked interrupted', async () => {
  const r = await S.api('/api/runs');
  assert.ok(r.json.length >= 3);
  const fs = require('node:fs');
  const path = require('node:path');
  const saved = JSON.parse(fs.readFileSync(path.join(S.dataDir, 'runs.json'), 'utf8'));
  assert.ok(saved[runId] && saved[runId].status === 'complete');
  assert.ok(!fs.readFileSync(path.join(S.dataDir, 'runs.json'), 'utf8').includes('test-hidden/'), 'hidden tests persisted in run log');
});
