'use strict';
// LIVE AGENT PATH — the real Claude tool-use loop, driven by a mock Messages API that
// validates request shape and scripts tool calls. Verifies tool_result round-trips,
// retries on 529, error handling, protected-file blocking, and scoring.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, freePort, ROOT } = require('./helpers');

const SOLUTION = fs.readFileSync(path.join(ROOT, 'problems/worker-500/rehearsal/solution/src/handler.js'), 'utf8');

function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input };
}

function startMock() {
  const requests = [];
  const overloadedOnce = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push({ url: req.url, headers: req.headers, body: json });
      const who = /tryout agent for ([^.]+)\./.exec(json.system || '')?.[1] || '?';
      const assistantTurns = (json.messages || []).filter((m) => m.role === 'assistant').length;
      const reply = (content, stop = 'tool_use') => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: json.model, content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 } }));
      };
      // Leo: first call is overloaded (529) — the agent must retry.
      if (who === 'Leo Park' && !overloadedOnce.has(who)) {
        overloadedOnce.add(who);
        res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '0' });
        return res.end('{"type":"error","error":{"type":"overloaded_error"}}');
      }
      // Sam: a hard API error on the 3rd turn — run must survive, partial work still scored.
      if (who === 'Sam Rivera' && assistantTurns === 2) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}');
      }
      const script = [
        () => reply([{ type: 'text', text: 'Let me look around.' }, toolUse('t1', 'list_files', {})]),
        () => reply([toolUse('t2', 'read_file', { path: 'src/handler.js' })]),
        () => reply([toolUse('t3', 'run_tests', {})]),
        () => reply([toolUse('t4a', 'write_file', { path: 'test/handler.test.js', content: '// gone' }), toolUse('t4b', 'write_file', { path: 'src/handler.js', content: SOLUTION })]),
        () => reply([toolUse('t5', 'run_tests', {})]),
        () => reply([{ type: 'text', text: 'All green.' }, toolUse('t6', 'submit', { summary: 'Guarded JSON.parse, case-insensitive headers, 405 for non-POST.' })]),
      ];
      (script[assistantTurns] || (() => reply([{ type: 'text', text: 'done' }], 'end_turn')))();
    });
  });
  return { server, requests };
}

test('live mode: Claude tool-use loop end to end', async () => {
  const mock = startMock();
  const port = await freePort();
  await new Promise((r) => mock.server.listen(port, '127.0.0.1', r));
  const S = await startServer({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, TRYOUT_MODEL: 'claude-test-model' });
  try {
    const health = await S.api('/api/health');
    assert.equal(health.json.defaultMode, 'live');
    const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'worker-500', candidateIds: ['maya', 'leo', 'sam'], mode: 'live' } });
    assert.equal(r.status, 201, r.text);
    const run = await S.waitRun(r.json.id);
    assert.equal(run.status, 'complete');
    const by = Object.fromEntries(run.entries.map((e) => [e.candidateId, e]));

    // Maya + Leo complete the full script and score 100, with a tamper penalty for the test edit.
    for (const id of ['maya', 'leo']) {
      assert.equal(by[id].status, 'done', `${id}: ${by[id].error}`);
      assert.equal(by[id].stopReason, 'submitted');
      assert.equal(by[id].result.hidden.passed, by[id].result.hidden.total);
      assert.ok(by[id].result.flags.some((f) => f.kind === 'tamper_attempt'));
      assert.equal(by[id].result.score, 90);
      assert.equal(by[id].turns, 6);
      assert.ok(by[id].usage.output_tokens > 0);
    }
    // Sam hit a 400 — recorded as an error, partial work still scored (original code).
    assert.equal(by.sam.status, 'error');
    assert.match(by.sam.error, /Anthropic API 400/);
    assert.ok(by.sam.result && by.sam.result.score < 50);

    // Request shape
    const first = mock.requests.find((q) => q.body.system && q.body.system.includes('Maya Okafor'));
    assert.equal(first.url, '/v1/messages');
    assert.equal(first.headers['x-api-key'], 'test-key');
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    assert.equal(first.body.model, 'claude-test-model');
    assert.deepEqual(first.body.tools.map((t) => t.name), ['list_files', 'read_file', 'write_file', 'run_tests', 'submit']);
    assert.match(first.body.system, /HIDDEN tests/);
    assert.ok(!first.body.system.includes('malformed JSON returns 400'), 'hidden test names leaked into the prompt');

    // tool_result round-trips
    const mayaReqs = mock.requests.filter((q) => q.body.system && q.body.system.includes('Maya Okafor'));
    const resultsAt = (i) => mayaReqs[i].body.messages.at(-1).content;
    assert.match(resultsAt(1)[0].content, /src\/handler\.js/); // list_files output
    assert.match(resultsAt(1)[0].content, /protected/);
    assert.match(resultsAt(2)[0].content, /EMAIL_RE/); // read_file output
    assert.match(resultsAt(3)[0].content, /Visible tests: 1\/3 passed/); // run_tests before fix
    const writeResults = resultsAt(4);
    assert.equal(writeResults[0].is_error, true);
    assert.match(writeResults[0].content, /protected test file/);
    assert.match(writeResults[1].content, /Wrote src\/handler\.js/);
    assert.match(resultsAt(5)[0].content, /Visible tests: 3\/3 passed/); // after fix

    // Leo was retried after the 529
    assert.ok(mock.requests.filter((q) => q.body.system && q.body.system.includes('Leo Park')).length >= 7);

    // Event stream contains thoughts and the blocked write
    const sse = await (await fetch(`${S.base}/api/runs/${run.id}/events`)).text();
    assert.ok(sse.includes('event: thought') && sse.includes('Let me look around.'));
    assert.ok(sse.includes('event: blocked'));
    assert.ok(sse.includes('event: agent_error'));
  } finally {
    await S.stop();
    mock.server.close();
  }
});

test('live mode: agent that never submits stops at max turns and is still scored', async () => {
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [toolUse(`x${Math.random()}`, 'list_files', {})], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const S = await startServer({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, TRYOUT_AGENT_MAX_TURNS: '4' });
  try {
    const r = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: ['maya'], mode: 'live' } });
    const run = await S.waitRun(r.json.id);
    const e = run.entries[0];
    assert.equal(e.stopReason, 'max_turns');
    assert.equal(e.turns, 4);
    assert.equal(e.status, 'done');
    assert.ok(e.result.score < 50);
  } finally {
    await S.stop();
    server.close();
  }
});
