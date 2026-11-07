'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Start a real Tryout server process with an isolated data dir. */
async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tryout-test-data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TRYOUT_SKIP_DOTENV: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      TRYOUT_DATA_DIR: dataDir,
      TRYOUT_REHEARSAL_SPEED: '40',
      ...(process.env.TRYOUT_SANDBOX ? { TRYOUT_SANDBOX: process.env.TRYOUT_SANDBOX } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const api = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const waitRun = async (id, ms = 90000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await api(`/api/runs/${id}`);
      if (r.json && !['running', 'scoring'].includes(r.json.status)) return r.json;
      if (Date.now() - t0 > ms) throw new Error(`run ${id} did not finish; log:\n${log}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, api, waitRun, stop, dataDir, log: () => log };
}

module.exports = { startServer, freePort, ROOT };
