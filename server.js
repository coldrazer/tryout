'use strict';
// Tryout server — zero dependencies. `node server.js` then open http://localhost:4400
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./src/config');
const problems = require('./src/problems');
const profiles = require('./src/profiles');
const orch = require('./src/orchestrator');
const intros = require('./src/intros');
const { computeExpected } = require('./src/scoring');
const { getDriver, selfTest } = require('./src/sandbox');

const MAX_BODY = 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', // consent tokens live in URLs
  'content-security-policy': "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': isBuf || typeof body === 'string' ? headers['content-type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('Request body too large'), { status: 413, closeAfter: true });
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      req.resume(); // discard
      return reject(tooLarge());
    }
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(Object.assign(new Error('Body must be a JSON object'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req) {
  if (!config.adminToken) return;
  const tok = req.headers['x-admin-token'] || '';
  const a = Buffer.from(String(tok));
  const b = Buffer.from(config.adminToken);
  if (a.length !== b.length || !require('node:crypto').timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Admin token required'), { status: 401 });
  }
}

// ---- Cross-site request protection --------------------------------------------------
// The server usually runs on a laptop at 127.0.0.1 with no admin token, so any web page
// open in the same browser could otherwise POST to it (CSRF) or reach it through a
// rebound hostname (DNS rebinding). Every state-changing request must therefore:
//   1. come from a trusted Host: localhost, an IP literal (can't be rebound), the host of
//      TRYOUT_PUBLIC_URL, or one listed in TRYOUT_ALLOWED_HOSTS;
//   2. carry no foreign Origin;
//   3. (POST) use Content-Type: application/json, which browsers can't send cross-site
//      without a CORS preflight — and this server never approves preflights.
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}
const allowedHosts = new Set(
  [config.publicUrl ? new URL(config.publicUrl).hostname.toLowerCase() : '', ...String(process.env.TRYOUT_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase())].filter(Boolean),
);
function trustedHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || net.isIP(hostname) !== 0 || allowedHosts.has(hostname);
}
function guardWrite(req) {
  const hostname = hostnameOf(req.headers.host);
  if (!trustedHost(hostname)) {
    throw Object.assign(new Error(`Host "${hostname}" is not allowed. Set TRYOUT_PUBLIC_URL or TRYOUT_ALLOWED_HOSTS.`), { status: 403 });
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try {
      ok = origin !== 'null' && new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch {}
    if (!ok) throw Object.assign(new Error('Cross-origin request blocked'), { status: 403 });
  }
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  if (rel === '/') rel = '/index.html';
  const abs = path.resolve(config.publicDir, `.${rel}`);
  if (!abs.startsWith(config.publicDir + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(abs)] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache' });
    fs.createReadStream(abs).pipe(res);
  });
}

function sse(req, res, runId) {
  const run = orch.getRun(runId);
  if (!run) return send(res, 404, { error: 'Run not found' });
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const rawAfter = Number(req.headers['last-event-id'] || new URL(req.url, 'http://x').searchParams.get('after') || 0);
  const after = Number.isFinite(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  const write = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  for (const ev of run.events) if (ev.seq > after) write(ev);
  const finished = !['running', 'scoring'].includes(run.status);
  if (finished) {
    res.write(`event: end\ndata: {}\n\n`);
    return res.end();
  }
  const unsub = orch.subscribe(runId, (ev) => {
    write(ev);
    if (['run_complete', 'run_cancelled', 'run_error'].includes(ev.type)) {
      res.write(`event: end\ndata: {}\n\n`);
      cleanup();
      res.end();
    }
  });
  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
  const cleanup = () => {
    clearInterval(ping);
    unsub();
  };
  req.on('close', cleanup);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;
  const seg = p.split('/').filter(Boolean);

  if (!p.startsWith('/api/')) {
    if (m !== 'GET' && m !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, p);
  }
  if (m !== 'GET' && m !== 'HEAD') guardWrite(req);

  // ---- health
  if (m === 'GET' && p === '/api/health') {
    let d;
    try {
      d = getDriver();
    } catch (e) {
      return send(res, 503, { ok: false, error: e.message });
    }
    const st = selfTest.status();
    return send(res, 200, {
      ok: st.state !== 'failed',
      selfTest: st,
      defaultMode: config.resolveMode(),
      liveAvailable: Boolean(config.anthropicKey),
      model: config.model,
      sandbox: d.describe(),
      adminRequired: Boolean(config.adminToken),
      emailDelivery: config.resendKey ? 'resend' : 'manual',
      activeRuns: orch.activeCount(),
      limits: { maxCandidates: config.maxCandidatesPerRun },
    });
  }

  // ---- problems
  if (p === '/api/problems' && m === 'GET') return send(res, 200, problems.listProblems().map(problems.publicProblem));
  if (p === '/api/problems' && m === 'POST') {
    requireAdmin(req);
    const body = await readBody(req);
    const created = await problems.createCustomProblem(body, { computeExpected: (pr) => computeExpected(pr) });
    return send(res, 201, problems.publicProblem(created));
  }
  if (seg[1] === 'problems' && seg.length === 3) {
    if (m === 'GET') {
      const pr = problems.getProblem(seg[2]);
      if (!pr) return send(res, 404, { error: 'Problem not found' });
      // Visible files only — never hidden tests or reference solutions.
      return send(res, 200, { ...problems.publicProblem(pr), repo: pr.repo });
    }
    if (m === 'DELETE') {
      requireAdmin(req);
      const ok = await problems.deleteCustomProblem(seg[2]);
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Only custom problems can be deleted' });
    }
  }

  // ---- candidates
  if (p === '/api/candidates' && m === 'GET') return send(res, 200, profiles.listCandidates().map(profiles.publicCandidate));
  if (p === '/api/candidates' && m === 'POST') {
    requireAdmin(req);
    const body = await readBody(req);
    const c = body.github ? await profiles.addFromGitHub(body) : await profiles.addManual(body);
    return send(res, 201, profiles.publicCandidate(c));
  }
  if (seg[1] === 'candidates' && seg.length === 3 && m === 'DELETE') {
    requireAdmin(req);
    const ok = await profiles.deleteCandidate(seg[2]);
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Candidate not found' });
  }

  // ---- runs
  if (p === '/api/runs' && m === 'GET') return send(res, 200, orch.listRuns());
  if (p === '/api/runs' && m === 'POST') {
    requireAdmin(req);
    const body = await readBody(req);
    const run = await orch.startRun(body);
    return send(res, 201, run);
  }
  if (seg[1] === 'runs' && seg[2]) {
    const run = orch.getRun(seg[2]);
    if (!run) return send(res, 404, { error: 'Run not found' });
    if (seg.length === 3 && m === 'GET') return send(res, 200, { ...orch.viewRun(run), intro: intros.introForRun(run.id) });
    if (seg[3] === 'events' && m === 'GET') return sse(req, res, run.id);
    if (seg[3] === 'cancel' && m === 'POST') {
      requireAdmin(req);
      return send(res, orch.cancelRun(run.id) ? 200 : 409, { ok: true });
    }
    if (seg[3] === 'intro' && m === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      const out = await intros.createIntro(run.id, { posterEmail: body.posterEmail, reqHost: req.headers.host });
      return send(res, 201, out);
    }
  }

  // ---- intros (token-authenticated; each token answers only for its own side)
  if (seg[1] === 'intros' && seg[2]) {
    const tok = url.searchParams.get('token') || req.headers['x-intro-token'];
    if (seg.length === 3 && m === 'GET') {
      const { intro, role } = intros.getForToken(seg[2], tok);
      return send(res, 200, intros.viewIntro(intro, role));
    }
    if (seg[3] === 'respond' && m === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await intros.respond(seg[2], body.token || tok, body.decision));
    }
    if (seg[3] === 'eml' && m === 'GET') {
      return send(res, 200, intros.emlFor(seg[2], tok), { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="tryout-intro-${seg[2]}.eml"` });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      // Sandbox validation errors (bad paths, sizes) are client errors.
      const clientCodes = ['BAD_PATH', 'BAD_CONTENT', 'TOO_LARGE', 'TOO_MANY_FILES', 'PROTECTED', 'NOT_FOUND'];
      const status = err.status || (clientCodes.includes(err.code) ? 400 : 500);
      if (status >= 500) console.error('[tryout]', err);
      if (!res.headersSent) {
        if (err.closeAfter) res.once('finish', () => req.destroy());
        send(res, status, { error: status >= 500 ? 'Internal error' : err.message }, err.closeAfter ? { connection: 'close' } : {});
      } else res.end();
    }
  });
}

if (require.main === module) {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 8)) {
    console.error(`Tryout needs Node.js 22.8 or newer (you have ${process.versions.node}).`);
    process.exit(1);
  }
  // A stray rejection must never take the stage server down mid-demo.
  process.on('unhandledRejection', (e) => console.error('[tryout] unhandled rejection:', e));
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.adminToken) {
    console.warn('  ⚠ HOST is not loopback and TRYOUT_ADMIN_TOKEN is not set — anyone who can reach this server can start runs.');
  }
  const server = createServer();
  server.listen(config.port, config.host, () => {
    const d = getDriver().describe();
    console.log(`\n  Tryout running → http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  Agent mode: ${config.resolveMode()}${config.anthropicKey ? ` (model ${config.model})` : ' (no ANTHROPIC_API_KEY → rehearsal agents)'}`);
    console.log(`  Sandbox:    ${d.driver} — network ${d.network}${d.strong ? '' : '  ⚠ weak isolation'}`);
    if (config.adminToken) console.log('  Admin token required for write actions.');
    selfTest.run().then((st) => {
      if (st.state === 'passed') console.log(`  Self-test:  sandbox OK (${st.ms}ms)\n`);
      else console.error(`\n  ✖ SANDBOX SELF-TEST FAILED: ${st.error}\n    Tryout cannot score attempts until this is fixed (see README → Troubleshooting).\n`);
    });
  });
}

module.exports = { createServer };
