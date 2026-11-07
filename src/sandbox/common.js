'use strict';
// Shared sandbox logic: path safety, file operations, TAP parsing, process execution.
// Both drivers keep the workspace as a directory on the host; they differ only in HOW
// the test command is executed (Docker container vs. local namespace + permission model).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

class SandboxError extends Error {
  constructor(message, code = 'SANDBOX_ERROR') {
    super(message);
    this.code = code;
  }
}

const REL_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

/** Validate a sandbox-relative path. Returns normalized relative path (posix). */
function normalizeRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new SandboxError('Path must be a non-empty string', 'BAD_PATH');
  if (rel.length > 200) throw new SandboxError('Path too long', 'BAD_PATH');
  if (rel.includes('\0')) throw new SandboxError('Path contains NUL byte', 'BAD_PATH');
  let p = rel.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new SandboxError('Absolute paths are not allowed', 'BAD_PATH');
  if (!REL_PATH_RE.test(p)) throw new SandboxError('Path contains disallowed characters (allowed: letters, digits, . _ - /)', 'BAD_PATH');
  const norm = path.posix.normalize(p);
  if (norm === '.' || norm.startsWith('../') || norm === '..' || norm.split('/').includes('..')) {
    throw new SandboxError('Path escapes the sandbox', 'BAD_PATH');
  }
  if (norm.split('/').some((seg) => seg === '' || seg === '.git' || seg === 'node_modules')) {
    throw new SandboxError('Path segment not allowed', 'BAD_PATH');
  }
  return norm;
}

function isProtected(rel, protectedPaths) {
  return protectedPaths.some((pp) => (pp.endsWith('/') ? rel.startsWith(pp) : rel === pp));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class Sandbox {
  /**
   * @param {object} o
   * @param {string} o.dir host directory backing the workspace
   * @param {string[]} o.protectedPaths relative paths/prefixes the agent may not modify
   * @param {object} o.driver driver implementing exec(dir, nodeArgs, opts)
   * @param {object} o.limits config limits
   */
  constructor({ id, dir, protectedPaths = [], driver, limits }) {
    this.id = id;
    this.dir = dir;
    this.protectedPaths = protectedPaths;
    this.driver = driver;
    this.limits = limits;
    this.destroyed = false;
    this.writeLog = []; // {path, bytes, at}
    this.blockedWrites = []; // attempted writes to protected paths
    this.testRuns = 0;
  }

  _abs(rel) {
    const norm = normalizeRel(rel);
    const abs = path.resolve(this.dir, norm);
    if (!abs.startsWith(this.dir + path.sep)) throw new SandboxError('Path escapes the sandbox', 'BAD_PATH');
    return { norm, abs };
  }

  async _assertNoSymlink(abs) {
    // Walk every existing component between the sandbox root and abs; refuse symlinks.
    const rel = path.relative(this.dir, abs).split(path.sep);
    let cur = this.dir;
    for (const seg of rel) {
      cur = path.join(cur, seg);
      try {
        const st = await fsp.lstat(cur);
        if (st.isSymbolicLink()) throw new SandboxError('Symlinks are not allowed', 'BAD_PATH');
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
    }
  }

  _check() {
    if (this.destroyed) throw new SandboxError('Sandbox has been destroyed', 'DESTROYED');
  }

  async listFiles() {
    this._check();
    const out = [];
    const walk = async (d, prefix) => {
      const entries = await fsp.readdir(d, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(path.join(d, e.name), rel);
        else if (e.isFile()) {
          const st = await fsp.stat(path.join(d, e.name));
          out.push({ path: rel, bytes: st.size, protected: isProtected(rel, this.protectedPaths) });
        }
      }
    };
    await walk(this.dir, '');
    return out;
  }

  async readFile(rel) {
    this._check();
    const { abs, norm } = this._abs(rel);
    await this._assertNoSymlink(abs);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new SandboxError(`File not found: ${norm}`, 'NOT_FOUND');
    }
    if (!st.isFile()) throw new SandboxError(`Not a file: ${norm}`, 'NOT_FOUND');
    if (st.size > this.limits.maxFileBytes) throw new SandboxError('File too large to read', 'TOO_LARGE');
    return fsp.readFile(abs, 'utf8');
  }

  async writeFile(rel, content) {
    this._check();
    if (typeof content !== 'string') throw new SandboxError('Content must be a string', 'BAD_CONTENT');
    const { abs, norm } = this._abs(rel);
    if (isProtected(norm, this.protectedPaths)) {
      this.blockedWrites.push({ path: norm, at: Date.now() });
      throw new SandboxError(`"${norm}" is a protected test file and is read-only. Fix the source code, not the tests.`, 'PROTECTED');
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.limits.maxFileBytes) throw new SandboxError(`File exceeds ${this.limits.maxFileBytes} bytes`, 'TOO_LARGE');
    const existing = await this.listFiles();
    if (!existing.some((f) => f.path === norm) && existing.length >= this.limits.maxFiles) {
      throw new SandboxError('Too many files in sandbox', 'TOO_MANY_FILES');
    }
    await this._assertNoSymlink(abs);
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
    // Write atomically; 'wx' on the temp file refuses to follow pre-existing links.
    const tmp = `${abs}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await fsp.rename(tmp, abs);
    this.writeLog.push({ path: norm, bytes, at: Date.now() });
    return { path: norm, bytes };
  }

  /** Map of path -> content for every file (used for diffs and scoring). */
  async snapshot() {
    const files = await this.listFiles();
    const out = {};
    for (const f of files) out[f.path] = await fsp.readFile(path.join(this.dir, f.path), 'utf8');
    return out;
  }

  /**
   * Run node:test on the given test files inside the isolation boundary, via the trusted
   * harness. Only the HMAC-signed result line from the harness is trusted.
   * @param {string[]} testFiles relative paths
   * @param {{timeoutMs?: number, expectedNames?: string[]}} opts expectedNames: count ONLY
   *   these test names (from a trusted baseline); unknown names are ignored, missing = fail,
   *   and if a name appears more than once any failure wins.
   */
  async runTests(testFiles, { timeoutMs, expectedNames } = {}) {
    this._check();
    const files = testFiles.map((f) => normalizeRel(f));
    for (const f of files) {
      const { abs } = this._abs(f);
      if (!fs.existsSync(abs)) throw new SandboxError(`Test file not found: ${f}`, 'NOT_FOUND');
    }
    this.testRuns += 1;
    const key = crypto.randomBytes(32).toString('hex');
    const t0 = Date.now();
    const res = await this.driver.exec(this, files, { timeoutMs: timeoutMs || this.limits.testTimeoutMs, key });
    const signed = extractSigned(res.stdout, key);
    const summary = summarize(signed ? signed.results : [], expectedNames);
    const visibleOut = (res.stdout || '').replace(/^@@TRYOUT_RESULT@@ .*$/gm, '').trim();
    return {
      ...summary,
      verified: Boolean(signed),
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: Date.now() - t0,
      output: truncate(visibleOut + (res.stderr ? `\n[stderr]\n${res.stderr}` : ''), this.limits.maxOutputBytes),
    };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    await fsp.rm(this.dir, { recursive: true, force: true });
  }
}

const HARNESS_PATH = path.join(__dirname, 'harness.js');

/**
 * Node flags shared by both drivers. workDir / harnessPath are paths as seen by the process.
 */
function nodeTestArgs(workDir, harnessPath, files, memoryMb) {
  return [
    '--frozen-intrinsics',
    '--disable-warning=ExperimentalWarning',
    '--permission',
    `--allow-fs-read=${workDir}`,
    `--allow-fs-read=${harnessPath}`,
    `--max-old-space-size=${Math.max(32, Math.floor(memoryMb / 2))}`,
    '--disallow-code-generation-from-strings',
    harnessPath,
    ...files,
  ];
}

/** Find the harness result line whose HMAC verifies with this run's key. */
function extractSigned(stdout = '', key) {
  const re = /^@@TRYOUT_RESULT@@ ([A-Za-z0-9+/=]+) ([0-9a-f]{64})$/gm;
  let m;
  let found = null;
  while ((m = re.exec(stdout))) {
    let payload;
    try {
      payload = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      continue;
    }
    const expect = crypto.createHmac('sha256', key).update(payload).digest();
    const got = Buffer.from(m[2], 'hex');
    if (got.length === expect.length && crypto.timingSafeEqual(got, expect)) {
      try {
        const obj = JSON.parse(payload);
        if (obj && Array.isArray(obj.results)) found = obj;
      } catch {}
    }
  }
  return found;
}

/** Turn raw harness results into counts. See runTests() for expectedNames semantics. */
function summarize(results, expectedNames) {
  const clean = results.filter((r) => r && typeof r.name === 'string').map((r) => ({ name: r.name, ok: r.ok === true && !r.skip, skip: Boolean(r.skip), error: String(r.error || '') }));
  if (Array.isArray(expectedNames) && expectedNames.length) {
    const byName = new Map();
    for (const r of clean) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
    const passes = [];
    const failures = [];
    for (const name of [...new Set(expectedNames)]) {
      const rs = byName.get(name) || [];
      const bad = rs.find((r) => !r.ok);
      if (rs.length && !bad) passes.push(name);
      else failures.push({ name, error: bad ? bad.error || (bad.skip ? 'skipped' : 'failed') : 'did not run' });
    }
    return { passed: passes.length, failed: failures.length, total: passes.length + failures.length, skipped: 0, failures: failures.slice(0, 50), passes, results: clean.slice(0, 300) };
  }
  const counted = clean.filter((r) => !r.skip);
  const passes = counted.filter((r) => r.ok).map((r) => r.name);
  const failures = counted.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error }));
  return { passed: passes.length, failed: failures.length, total: counted.length, skipped: clean.length - counted.length, failures: failures.slice(0, 50), passes: passes.slice(0, 300), results: clean.slice(0, 300) };
}

/**
 * Parse Node's TAP output into leaf-test counts. Suites are excluded from counts.
 */
function parseTap(stdout = '') {
  const lines = stdout.split(/\r?\n/);
  const results = [];
  const re = /^(\s*)(ok|not ok) (\d+) - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const r = { indent: m[1].length, ok: m[2] === 'ok', name: m[4], directive: (m[5] || '').toUpperCase(), type: 'test', error: '' };
    // Scan the YAML block that follows (until a line that is just '...' at deeper indent).
    for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
      const l = lines[j];
      if (re.test(l) || /^\s*# Subtest:/.test(l)) break;
      const tm = /^\s*type: '(\w+)'/.exec(l);
      if (tm) r.type = tm[1];
      const em = /^\s*error: (.*)$/.exec(l);
      if (em && !r.error) r.error = em[1].replace(/^['"]|['"]$/g, '').slice(0, 300);
      if (/^\s*\.\.\.\s*$/.test(l)) break;
    }
    results.push(r);
  }
  const leaves = results.filter((r) => r.type !== 'suite');
  const skipped = leaves.filter((r) => r.directive === 'SKIP' || r.directive === 'TODO').length;
  const counted = leaves.filter((r) => r.directive !== 'SKIP' && r.directive !== 'TODO');
  const passed = counted.filter((r) => r.ok).length;
  const failures = counted.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error }));
  const passes = counted.filter((r) => r.ok).map((r) => r.name).slice(0, 200);
  return { passed, failed: failures.length, total: counted.length, skipped, failures: failures.slice(0, 50), passes };
}

function truncate(s, max) {
  if (!s) return '';
  if (Buffer.byteLength(s) <= max) return s;
  return Buffer.from(s).subarray(0, max).toString('utf8') + `\n…[truncated ${Buffer.byteLength(s) - max} bytes]`;
}

/**
 * Spawn a process with a hard wall-clock timeout that kills the whole process group.
 */
function run(cmd, args, { cwd, env, timeoutMs, maxBytes = 256 * 1024, onTimeout } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = (buf, add) => (buf.length < maxBytes ? buf + add.toString('utf8').slice(0, maxBytes - buf.length) : buf);
    child.stdout.on('data', (d) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      if (onTimeout) Promise.resolve(onTimeout()).catch(() => {});
    }, timeoutMs);
    const done = (exitCode, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) stderr += `\n${err.message}`;
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    child.on('error', (err) => done(-1, err));
    child.on('close', (code, signal) => done(code === null ? (signal ? 128 : -1) : code));
  });
}

async function makeWorkDir(prefix = 'tryout-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await fsp.chmod(dir, 0o755); // readable by the unprivileged container user
  return fs.realpathSync(dir);
}

async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const norm = normalizeRel(rel);
    const abs = path.join(dir, norm);
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
    await fsp.writeFile(abs, content, { mode: 0o644 });
  }
}

module.exports = {
  Sandbox,
  SandboxError,
  normalizeRel,
  isProtected,
  nodeTestArgs,
  HARNESS_PATH,
  extractSigned,
  summarize,
  parseTap,
  truncate,
  run,
  makeWorkDir,
  writeTree,
  sha256,
};
