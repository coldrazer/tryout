'use strict';
// GitHub profile builder against a mock GitHub API.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startServer, freePort } = require('./helpers');

test('add candidate from GitHub builds an evidence-based profile', async () => {
  const seen = [];
  const gh = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/users/octo') return res.end(JSON.stringify({ login: 'octo', name: 'Octo Cat', bio: 'Edge networking nerd', email: null, avatar_url: 'https://avatars.githubusercontent.com/u/1' }));
    if (req.url.startsWith('/users/octo/repos')) {
      return res.end(JSON.stringify([
        { name: 'edge-proxy', language: 'Go', stargazers_count: 120, description: 'Fast edge proxy', topics: ['networking'], html_url: 'https://github.com/octo/edge-proxy', pushed_at: '2026-10-01', fork: false },
        { name: 'dash', language: 'TypeScript', stargazers_count: 4, description: 'Dashboard', topics: [], html_url: 'https://github.com/octo/dash', pushed_at: '2026-09-01', fork: false },
        { name: 'forked-thing', language: 'Rust', stargazers_count: 9999, description: 'not theirs', fork: true },
      ]));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const port = await freePort();
  await new Promise((r) => gh.listen(port, '127.0.0.1', r));
  const S = await startServer({ GITHUB_API_URL: `http://127.0.0.1:${port}` });
  try {
    const r = await S.api('/api/candidates', { method: 'POST', body: { github: '@octo', email: 'octo@example.com' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.name, 'Octo Cat');
    assert.equal(r.json.github, 'octo');
    assert.equal(r.json.email, undefined, 'email must not be returned');
    assert.equal(r.json.hasEmail, true);
    assert.equal(r.json.evidence[0].title, 'edge-proxy');
    assert.ok(r.json.skills.includes('Go'));
    assert.ok(!r.json.skills.includes('Rust'), 'forks must not count as evidence');
    assert.ok(!JSON.stringify(r.json.evidence).includes('forked-thing'));
    const missing = await S.api('/api/candidates', { method: 'POST', body: { github: 'ghost' } });
    assert.equal(missing.status, 404);
    // The new candidate can try out.
    const run = await S.api('/api/runs', { method: 'POST', body: { problemId: 'csv-quotes', candidateIds: [r.json.id] } });
    assert.equal((await S.waitRun(run.json.id)).status, 'complete');
  } finally {
    await S.stop();
    gh.close();
  }
});
