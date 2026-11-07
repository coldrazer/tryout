'use strict';
// Local driver: runs tests on the host with layered isolation.
//   1. Node permission model: reads only inside the workspace, no writes, no child
//      processes, no workers, no native addons, no eval-from-strings.
//   2. `unshare -rnpfiu` (Linux): new user, network (no interfaces => no network), PID
//      (cannot see or signal host processes), IPC and UTS namespaces.
//   3. `prlimit` (Linux): address-space, CPU-seconds, open-file and file-size caps.
//   4. Scrubbed environment (no API keys leak) and a hard wall-clock timeout that kills
//      the process group.
// On macOS (no unshare/prlimit) layers 2–3 are unavailable; use the Docker driver there.
const { spawnSync } = require('node:child_process');
const { run, nodeTestArgs, HARNESS_PATH } = require('./common');

function probe(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

class LocalDriver {
  constructor(limits) {
    this.name = 'local';
    this.limits = limits;
    this.hasUnshare = process.platform === 'linux' && probe('unshare', ['-rnpfiu', '--kill-child', 'true']);
    this.hasPrlimit = process.platform === 'linux' && probe('prlimit', ['--version']);
  }

  describe() {
    return {
      driver: this.name,
      network: this.hasUnshare ? 'blocked (network namespace)' : 'NOT isolated — install util-linux or use Docker',
      pids: this.hasUnshare ? 'isolated (PID namespace)' : 'NOT isolated — code can signal host processes; use Docker',
      limits: this.hasPrlimit ? 'prlimit (address space, cpu, files)' : 'timeout + V8 heap cap only',
      filesystem: 'Node permission model (read-only, workspace only)',
      processes: 'child processes / workers blocked by permission model',
      strong: this.hasUnshare && this.hasPrlimit,
    };
  }

  async exec(sandbox, files, { timeoutMs, key }) {
    const nodeArgs = nodeTestArgs(sandbox.dir, HARNESS_PATH, files, this.limits.memoryMb);
    let cmd = process.execPath;
    let args = nodeArgs;
    if (this.hasUnshare) {
      args = ['-rnpfiu', '--kill-child', cmd, ...args];
      cmd = 'unshare';
    }
    if (this.hasPrlimit) {
      const cpuSecs = Math.max(2, Math.ceil(timeoutMs / 1000));
      args = [
        `--as=${1536 * 1024 * 1024}`,
        `--cpu=${cpuSecs}`,
        '--nofile=256',
        `--fsize=${1024 * 1024}`,
        '--core=0',
        '--',
        cmd,
        ...args,
      ];
      cmd = 'prlimit';
    }
    return run(cmd, args, {
      cwd: sandbox.dir,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: sandbox.dir, NODE_OPTIONS: '', LANG: 'C.UTF-8', NO_COLOR: '1', TRYOUT_HARNESS_KEY: key },
      timeoutMs,
    });
  }
}

module.exports = { LocalDriver };
