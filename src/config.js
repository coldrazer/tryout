'use strict';
// Central configuration. Everything can be overridden with environment variables
// (see .env.example). A tiny .env loader is included so there are zero dependencies.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
if (!process.env.TRYOUT_SKIP_DOTENV) loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const config = {
  root: ROOT,
  port: int(env.PORT, 4400),
  host: env.HOST || '127.0.0.1',
  dataDir: env.TRYOUT_DATA_DIR || path.join(ROOT, 'data'),
  problemsDir: env.TRYOUT_PROBLEMS_DIR || path.join(ROOT, 'problems'),
  publicDir: path.join(ROOT, 'public'),
  publicUrl: env.TRYOUT_PUBLIC_URL || '', // e.g. https://tryout.example.com — used in consent links
  adminToken: env.TRYOUT_ADMIN_TOKEN || '', // if set, required (x-admin-token) for write endpoints

  // Agents
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: env.TRYOUT_MODEL || 'claude-sonnet-5-5',
  agentMaxTurns: int(env.TRYOUT_AGENT_MAX_TURNS, 24),
  agentMaxMs: int(env.TRYOUT_AGENT_MAX_MS, 240000),
  agentMaxTokens: int(env.TRYOUT_AGENT_MAX_TOKENS, 4096),
  // 'auto' => live if an API key exists, otherwise rehearsal. 'live' | 'rehearsal' force a mode.
  defaultMode: env.TRYOUT_MODE || 'auto',
  rehearsalSpeed: Number(env.TRYOUT_REHEARSAL_SPEED || 1), // 2 = twice as fast; tests use a large number

  // Sandbox
  sandboxDriver: env.TRYOUT_SANDBOX || 'auto', // 'auto' | 'docker' | 'local'
  dockerImage: env.TRYOUT_DOCKER_IMAGE || 'node:22-alpine',
  testTimeoutMs: int(env.TRYOUT_TEST_TIMEOUT_MS, 20000),
  maxFileBytes: int(env.TRYOUT_MAX_FILE_BYTES, 200 * 1024),
  maxFiles: int(env.TRYOUT_MAX_FILES, 200),
  maxOutputBytes: int(env.TRYOUT_MAX_OUTPUT_BYTES, 12 * 1024),
  memoryMb: int(env.TRYOUT_MEMORY_MB, 256),

  // Runs
  maxCandidatesPerRun: int(env.TRYOUT_MAX_CANDIDATES, 4),
  maxConcurrentRuns: int(env.TRYOUT_MAX_CONCURRENT_RUNS, 2),
  maxStoredRuns: int(env.TRYOUT_MAX_STORED_RUNS, 100),
  liveGraceMs: int(env.TRYOUT_LIVE_GRACE_MS, 60000),

  // Intro email (optional real send via Resend)
  resendKey: env.RESEND_API_KEY || '',
  introFrom: env.TRYOUT_INTRO_FROM || 'Tryout <intro@tryout.local>',

  // GitHub (optional token raises rate limits)
  githubToken: env.GITHUB_TOKEN || '',
  githubApi: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
};

config.resolveMode = (requested) => {
  const m = requested || config.defaultMode;
  if (m === 'live' || m === 'rehearsal') return m;
  return config.anthropicKey ? 'live' : 'rehearsal';
};

module.exports = config;
