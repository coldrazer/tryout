'use strict';
// Docker driver: every test run is a fresh, throwaway container.
//   --network none, read-only root FS, workspace mounted read-only, non-root user,
//   all capabilities dropped, no-new-privileges, memory/CPU/PID caps, tiny /tmp tmpfs,
//   plus the same Node permission model inside the container. Killed on timeout.
// This is the driver to use on a VPS (e.g. the Coldrazer box already runs Docker).
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { run, nodeTestArgs, HARNESS_PATH } = require('./common');

function dockerAvailable() {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function imagePresent(image) {
  try {
    const r = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Only pass what the docker CLI needs — never API keys.
function dockerEnv() {
  const e = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' };
  for (const k of ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    if (process.env[k]) e[k] = process.env[k];
  }
  return e;
}

class DockerDriver {
  constructor(limits, image) {
    this.name = 'docker';
    this.limits = limits;
    this.image = image;
  }

  describe() {
    return {
      driver: this.name,
      image: this.image,
      network: 'blocked (--network none)',
      limits: `${this.limits.memoryMb}MB RAM, 1 CPU, 64 PIDs`,
      filesystem: 'read-only container + read-only workspace mount + Node permission model',
      processes: 'non-root, caps dropped, no-new-privileges',
      strong: true,
    };
  }

  async exec(sandbox, files, { timeoutMs, key }) {
    const name = `tryout-${sandbox.id}-${crypto.randomBytes(3).toString('hex')}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    const mem = `${this.limits.memoryMb}m`;
    const args = [
      'run', '--rm', '--name', name,
      '--network', 'none',
      '--memory', mem, '--memory-swap', mem,
      '--cpus', '1',
      '--pids-limit', '64',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', '1000:1000',
      '--ulimit', 'nofile=256:256',
      '--ulimit', 'fsize=1048576',
      '-e', 'NO_COLOR=1',
      '-e', 'TRYOUT_HARNESS_KEY', // value comes from the docker CLI env, never argv
      '-v', `${sandbox.dir}:/work:ro`,
      '-v', `${HARNESS_PATH}:/tryout/harness.js:ro`,
      '-w', '/work',
      '--entrypoint', 'node',
      this.image,
      ...nodeTestArgs('/work', '/tryout/harness.js', files, this.limits.memoryMb),
    ];
    // Container start adds overhead; give a little grace on top of the test budget.
    const res = await run('docker', args, {
      timeoutMs: timeoutMs + 5000,
      env: { ...dockerEnv(), TRYOUT_HARNESS_KEY: key },
      onTimeout: () => run('docker', ['rm', '-f', name], { timeoutMs: 10000, env: process.env }),
    });
    if (res.exitCode === 125) res.stderr = `[docker failed to start container] ${res.stderr}`;
    return res;
  }
}

module.exports = { DockerDriver, dockerAvailable, imagePresent };
