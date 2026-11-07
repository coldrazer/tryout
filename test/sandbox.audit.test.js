'use strict';
// SANDBOX SECURITY AUDIT — runs every attack against every available driver.
// Each malicious test is written so that it PASSES only if the attack was BLOCKED.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSandbox, limits } = require('../src/sandbox');
const { LocalDriver } = require('../src/sandbox/local');
const { DockerDriver, dockerAvailable, imagePresent } = require('../src/sandbox/docker');
const config = require('../src/config');

const drivers = [new LocalDriver(limits)];
if (dockerAvailable() && imagePresent(config.dockerImage)) drivers.push(new DockerDriver(limits, config.dockerImage));
else console.log('# docker driver not available — auditing local driver only');

const HOST_SECRET = 'sk-ant-host-secret-should-never-leak';
process.env.ANTHROPIC_API_KEY_AUDIT = HOST_SECRET;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || HOST_SECRET;

const PRELUDE = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const blocked = (fn) => { try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => false, () => true); return false; } catch { return true; } };
`;

async function runProbe(driver, body, extraFiles = {}, opts = {}) {
  const sb = await createSandbox({ 'test/probe.test.js': PRELUDE + body, ...extraFiles }, { driver, protectedPaths: ['test/'] });
  try {
    return await sb.runTests(['test/probe.test.js'], opts);
  } finally {
    await sb.destroy();
  }
}

for (const driver of drivers) {
  test.describe(`sandbox audit [${driver.name}]`, () => {
    test.it('reports strong isolation', () => {
      const d = driver.describe();
      assert.equal(d.strong, true, JSON.stringify(d));
      assert.match(d.network, /^blocked/);
    });

    test.it('baseline: honest tests run and are counted', async () => {
      const r = await runProbe(driver, `test('a', () => assert.equal(1, 1)); test('b', () => assert.equal(1, 2)); test.describe('suite', () => { test.it('c', () => {}); });`);
      assert.deepEqual([r.passed, r.failed, r.total], [2, 1, 3]);
    });

    test.it('network is unreachable (IP, DNS, a live server on the host)', async () => {
      const http = require('node:http');
      let hits = 0;
      const srv = http.createServer((q, s) => { hits++; s.end('reached'); });
      await new Promise((res) => srv.listen(0, '0.0.0.0', res));
      const hostPort = srv.address().port;
      // sanity: the host server really is reachable from outside the sandbox
      assert.equal(await (await fetch(`http://127.0.0.1:${hostPort}`)).text(), 'reached');
      hits = 0;
      const r = await runProbe(
        driver,
        `test('ip', async () => assert.ok(await blocked(() => fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) }))));
         test('dns', async () => assert.ok(await blocked(() => require('node:dns').promises.lookup('example.com'))));
         test('host loopback', async () => assert.ok(await blocked(() => fetch('http://127.0.0.1:${hostPort}', { signal: AbortSignal.timeout(3000) }))));
         test('docker host gateway', async () => assert.ok(await blocked(() => fetch('http://172.17.0.1:${hostPort}', { signal: AbortSignal.timeout(3000) }))));
         test('raw socket', async () => assert.ok(await blocked(() => new Promise((res, rej) => { const s = require('node:net').connect(80, '1.1.1.1'); s.on('connect', res); s.on('error', rej); setTimeout(() => rej(new Error('t')), 3000); }))));`,
      );
      srv.close();
      assert.equal(hits, 0, 'sandboxed code reached the host server');
      assert.equal(r.passed, 5, JSON.stringify(r.failures));
    });

    test.it('host secrets never reach sandboxed code', async () => {
      const r = await runProbe(
        driver,
        `test('env', () => { const all = JSON.stringify(process.env); assert.ok(!all.includes('${HOST_SECRET.slice(0, 12)}')); assert.equal(process.env.ANTHROPIC_API_KEY, undefined); });
         test('proc environ', () => assert.ok(blocked(() => fs.readFileSync('/proc/1/environ'))));`,
      );
      assert.equal(r.passed, 2, JSON.stringify(r.failures));
    });

    test.it('filesystem: cannot read host files or write anywhere', async () => {
      const canary = path.join(os.tmpdir(), `tryout-host-canary-${process.pid}.txt`);
      fs.writeFileSync(canary, 'host-only');
      try {
        const r = await runProbe(
          driver,
          `test('read host canary', () => assert.ok(blocked(() => fs.readFileSync(${JSON.stringify(canary)}))));
           test('read /etc', () => assert.ok(blocked(() => fs.readFileSync('/etc/hostname'))));
           test('read server source', () => assert.ok(blocked(() => fs.readFileSync(${JSON.stringify(path.join(config.root, 'server.js'))}))));
           test('write in workspace', () => assert.ok(blocked(() => fs.writeFileSync(__dirname + '/../pwn.js', 'x'))));
           test('write /tmp', () => assert.ok(blocked(() => fs.writeFileSync('/tmp/pwn', 'x'))));
           test('symlink out', () => assert.ok(blocked(() => fs.symlinkSync('/etc', __dirname + '/../etc'))));
           test('modify own tests', () => assert.ok(blocked(() => fs.appendFileSync(__filename, '//x'))));`,
        );
        assert.equal(r.passed, 7, JSON.stringify(r.failures));
        assert.equal(fs.readFileSync(canary, 'utf8'), 'host-only');
      } finally {
        fs.rmSync(canary, { force: true });
      }
    });

    test.it('process: no child processes, workers, addons, eval, inspector, WASI', async () => {
      const r = await runProbe(
        driver,
        `test('exec', () => assert.ok(blocked(() => require('node:child_process').execSync('id'))));
         test('spawn', () => assert.ok(blocked(() => require('node:child_process').spawn('sh'))));
         test('binding', () => assert.ok(blocked(() => process.binding('spawn_sync'))));
         test('worker', () => assert.ok(blocked(() => new (require('node:worker_threads').Worker)('1', { eval: true }))));
         test('dlopen', () => assert.ok(blocked(() => process.dlopen({ exports: {} }, '/usr/lib/libc.so'))));
         test('eval', () => assert.ok(blocked(() => eval('1+1'))));
         test('Function', () => assert.ok(blocked(() => new Function('return 1')())));
         test('inspector', () => assert.ok(blocked(() => require('node:inspector').open(0))));
         test('wasi', () => assert.ok(blocked(() => new (require('node:wasi').WASI)({ version: 'preview1' }))));`,
      );
      assert.equal(r.passed, 9, JSON.stringify(r.failures));
    });

    test.it('cannot signal or kill host processes (e.g. the Tryout server)', async () => {
      const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
      try {
        const r = await runProbe(driver, `test('kill victim', () => assert.ok(blocked(() => process.kill(${victim.pid}, 'SIGKILL'))));`);
        await new Promise((res) => setTimeout(res, 200));
        assert.equal(victim.exitCode, null, 'victim process was killed from inside the sandbox');
        assert.equal(victim.signalCode, null);
        assert.equal(r.passed, 1, JSON.stringify(r.failures));
      } finally {
        victim.kill('SIGKILL');
      }
    });

    test.it('infinite loop is killed at the time limit and leaves no process behind', async () => {
      const marker = `tryout-loop-marker-${Date.now()}`;
      const t0 = Date.now();
      const r = await runProbe(driver, `const MARK = '${marker}'; test('spin', () => { while (true) {} });`, {}, { timeoutMs: 2500 });
      const took = Date.now() - t0;
      assert.equal(r.timedOut, true);
      assert.ok(took < (driver.name === 'docker' ? 15000 : 6000), `took ${took}ms`);
      await new Promise((res) => setTimeout(res, 500));
      const ps = require('node:child_process').execSync('ps -eo args').toString();
      assert.ok(!ps.split('\n').some((l) => l.includes('probe.test.js') && l.includes('--permission')), 'sandbox process still running');
    });

    test.it('memory bomb fails inside the sandbox without hurting the host', async () => {
      const before = process.memoryUsage().rss;
      const r = await runProbe(driver, `test('bomb', () => { const a = []; for (;;) a.push(new Array(1e6).fill(Math.random())); });`, {}, { timeoutMs: 15000 });
      assert.ok(r.passed === 0, 'bomb should not pass');
      assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024);
    });

    test.it('output flood is truncated', async () => {
      const r = await runProbe(driver, `test('flood', () => { for (let i = 0; i < 20000; i++) console.log('x'.repeat(200)); });`);
      assert.ok(Buffer.byteLength(r.output) <= limits.maxOutputBytes + 100, `output ${Buffer.byteLength(r.output)}`);
    });
  });
}

test.describe('sandbox API path safety', () => {
  test.it('rejects traversal, absolute, odd chars, symlinks, protected and oversize writes', async () => {
    const sb = await createSandbox({ 'src/a.js': 'x', 'test/a.test.js': 't' }, { protectedPaths: ['test/'] });
    try {
      for (const bad of ['../x', '/etc/passwd', 'src/../../x', 'a/./../../b', 'src\\..\\..\\x', 'C:/x', 'src/a\0.js', 'node_modules/x.js', '.git/config', 'src/$(id).js', 'src/a b.js', '', 'a'.repeat(300)]) {
        await assert.rejects(sb.writeFile(bad, 'x'), (e) => e.code === 'BAD_PATH', `write ${JSON.stringify(bad)}`);
        await assert.rejects(sb.readFile(bad), (e) => e.code === 'BAD_PATH' || e.code === 'NOT_FOUND', `read ${JSON.stringify(bad)}`);
      }
      // symlink planted inside the workspace (e.g. by a malicious repo) is never followed
      fs.symlinkSync('/etc', path.join(sb.dir, 'src', 'etc'));
      fs.symlinkSync('/etc/hostname', path.join(sb.dir, 'src', 'host'));
      await assert.rejects(sb.readFile('src/host'), (e) => e.code === 'BAD_PATH');
      await assert.rejects(sb.readFile('src/etc/hostname'), (e) => e.code === 'BAD_PATH');
      await assert.rejects(sb.writeFile('src/etc/evil', 'x'), (e) => e.code === 'BAD_PATH');
      assert.ok(!(await sb.listFiles()).some((f) => f.path.startsWith('src/etc')));
      // protected
      await assert.rejects(sb.writeFile('test/a.test.js', 'x'), (e) => e.code === 'PROTECTED');
      await assert.rejects(sb.writeFile('test/new.test.js', 'x'), (e) => e.code === 'PROTECTED');
      assert.equal(sb.blockedWrites.length, 2);
      assert.equal(await sb.readFile('test/a.test.js'), 't');
      // size
      await assert.rejects(sb.writeFile('src/big.js', 'x'.repeat(limits.maxFileBytes + 1)), (e) => e.code === 'TOO_LARGE');
      // normal write works
      await sb.writeFile('./src/b.js', 'ok');
      assert.equal(await sb.readFile('src/b.js'), 'ok');
    } finally {
      await sb.destroy();
    }
    await assert.rejects(sb.readFile('src/a.js'), (e) => e.code === 'DESTROYED');
    assert.equal(fs.existsSync(sb.dir), false);
  });

  test.it('enforces the file count limit', async () => {
    const sb = await createSandbox({});
    try {
      for (let i = 0; i < limits.maxFiles; i++) await sb.writeFile(`f/${i}.js`, '1');
      await assert.rejects(sb.writeFile('f/one-more.js', '1'), (e) => e.code === 'TOO_MANY_FILES');
      await sb.writeFile('f/0.js', 'overwrite ok');
    } finally {
      await sb.destroy();
    }
  });
});
