'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { Sandbox, SandboxError, makeWorkDir, writeTree } = require('./common');
const { LocalDriver } = require('./local');
const { DockerDriver, dockerAvailable, imagePresent } = require('./docker');

const limits = {
  maxFileBytes: config.maxFileBytes,
  maxFiles: config.maxFiles,
  maxOutputBytes: config.maxOutputBytes,
  testTimeoutMs: config.testTimeoutMs,
  memoryMb: config.memoryMb,
};

let cachedDriver = null;

/** Pick a driver. 'auto' prefers Docker (strongest isolation) when the daemon and image are ready. */
function getDriver(name = config.sandboxDriver) {
  if (cachedDriver && (name === 'auto' || cachedDriver.name === name)) return cachedDriver;
  let driver;
  if (name === 'docker') {
    if (!dockerAvailable()) throw new SandboxError('Docker driver requested but the Docker daemon is not reachable', 'NO_DOCKER');
    driver = new DockerDriver(limits, config.dockerImage);
  } else if (name === 'local') {
    driver = new LocalDriver(limits);
  } else {
    driver = dockerAvailable() && imagePresent(config.dockerImage) ? new DockerDriver(limits, config.dockerImage) : new LocalDriver(limits);
  }
  cachedDriver = driver;
  return driver;
}

/**
 * Create a sandbox populated with files.
 * @param {Record<string,string>} files
 * @param {{protectedPaths?: string[], driver?: object}} opts
 */
async function createSandbox(files, opts = {}) {
  const id = crypto.randomBytes(5).toString('hex');
  const dir = await makeWorkDir(`tryout-${id}-`);
  try {
    await writeTree(dir, files);
  } catch (e) {
    const fsp = require('node:fs/promises');
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  }
  return new Sandbox({ id, dir, protectedPaths: opts.protectedPaths || [], driver: opts.driver || getDriver(), limits });
}

/**
 * Startup self-test: run one passing and one failing test through the real driver and the
 * signed harness. Catches a stopped Docker daemon, an outdated node image (the harness
 * needs Node 22.8+), or a broken local sandbox BEFORE anyone is on stage.
 */
const selfTest = (() => {
  let state = { state: 'pending' };
  let inflight = null;
  async function run() {
    if (inflight) return inflight;
    inflight = (async () => {
      const t0 = Date.now();
      let sb;
      try {
        sb = await createSandbox({
          'm.js': 'module.exports = (x) => x + 1;\n',
          'test/self.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst f = require('../m.js');\ntest('pass', () => assert.equal(f(1), 2));\ntest('fail', () => assert.equal(f(1), 3));\n",
        });
        const r = await sb.runTests(['test/self.test.js'], { timeoutMs: 20000 });
        if (!r.verified || r.passed !== 1 || r.failed !== 1) {
          throw new Error(`expected 1 pass + 1 fail from the signed harness, got ${r.passed}/${r.total} (verified=${r.verified}). Output: ${r.output.slice(0, 400)}`);
        }
        state = { state: 'passed', ms: Date.now() - t0, driver: sb.driver.name };
      } catch (e) {
        state = { state: 'failed', error: String((e && e.message) || e).slice(0, 600) };
      } finally {
        if (sb) await sb.destroy().catch(() => {});
        inflight = null;
      }
      return state;
    })();
    return inflight;
  }
  return { run, status: () => state };
})();

module.exports = { createSandbox, getDriver, limits, SandboxError, selfTest, _resetDriverCache: () => (cachedDriver = null) };
