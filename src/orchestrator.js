'use strict';
// Runs a tryout: one sandbox + one agent per candidate, all in parallel, each scored in a
// fresh sandbox the moment it finishes. Streams every step as events for the stage UI.
const crypto = require('node:crypto');
const config = require('./config');
const { createSandbox, getDriver } = require('./sandbox');
const { getProblem, protectedPathsFor, publicProblem } = require('./problems');
const { getCandidate, publicCandidate, EMAIL_RE } = require('./profiles');
const { scoreAttempt, rank, computeExpected } = require('./scoring');
const { runClaudeAgent } = require('./agents/claude');
const { runRehearsalAgent, STRATEGIES } = require('./agents/rehearsal');
const { Collection } = require('./store');

const MAX_EVENTS = 3000;

const live = new Map(); // runId -> { run, subscribers:Set, controller }
let runsStore = null;
const expectedCache = new Map();

function store() {
  if (!runsStore) {
    runsStore = new Collection('runs');
    // Runs that were in flight when the server stopped can never finish.
    let dirty = false;
    for (const r of runsStore.all()) {
      if (['running', 'scoring'].includes(r.status)) {
        r.status = 'error';
        r.error = 'Server restarted during this run';
        dirty = true;
      }
    }
    if (dirty) runsStore.save();
  }
  return runsStore;
}

function errText(err) {
  return String((err && err.message) || err || 'Unknown error').slice(0, 500);
}

/** After a run ends: drop it from the live map (after a grace period) and prune old runs. */
function finalize(runId) {
  // keep finished runs in the live map briefly for late SSE clients, then rely on the store
  setTimeout(() => live.delete(runId), config.liveGraceMs).unref();
  const all = store().all().sort((a, b) => b.createdAt - a.createdAt);
  let pruned = false;
  for (const r of all.slice(config.maxStoredRuns)) { // prune old finished runs
    if (['running', 'scoring'].includes(r.status)) continue;
    store().items.delete(r.id);
    pruned = true;
  }
  if (pruned) store().save().catch(() => {});
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function activeCount() {
  let n = 0;
  for (const l of live.values()) if (['running', 'scoring'].includes(l.run.status)) n++;
  return n;
}

/** Public, persisted shape of a run. Never contains emails or hidden tests. */
function viewRun(run) {
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    problem: run.problem,
    poster: { name: run.poster.name },
    createdAt: run.createdAt,
    endedAt: run.endedAt || null,
    sandbox: run.sandbox,
    entries: run.entries.map((e) => ({
      candidateId: e.candidateId,
      candidate: e.candidate,
      status: e.status,
      startedAt: e.startedAt,
      endedAt: e.endedAt || null,
      durationMs: e.durationMs ?? null,
      turns: e.turns || 0,
      testRuns: e.testRuns || 0,
      lastTests: e.lastTests || null,
      usage: e.usage || null,
      summary: e.summary || '',
      stopReason: e.stopReason || null,
      error: e.error || null,
      result: e.result || null,
      rank: e.rank ?? null,
    })),
    winnerId: run.winnerId || null,
    introId: run.introId || null,
    error: run.error || null,
    eventCount: run.events.length,
  };
}

function emitter(entry, run) {
  return (type, data = {}) => {
    run.seq = (run.seq || run.events.length) + 1; // monotonic even after the event log is full
    const ev = { seq: run.seq, t: Date.now(), type, candidateId: entry ? entry.candidateId : null, data };
    if (run.events.length < MAX_EVENTS) run.events.push(ev);
    if (entry) {
      if (type === 'tests') entry.lastTests = { passed: data.passed, total: data.total };
      if (type === 'status') entry.statusLabel = data.label;
    }
    const l = live.get(run.id);
    if (l) for (const fn of l.subscribers) {
      try {
        fn(ev);
      } catch {}
    }
  };
}

async function ensureExpected(problem) {
  if (problem.expected && problem.expected.visibleNames) return problem;
  if (!expectedCache.has(problem.id)) expectedCache.set(problem.id, await computeExpected(problem));
  problem.expected = expectedCache.get(problem.id);
  return problem;
}

/**
 * Start a run. Returns the run view immediately; work continues in the background.
 * @param {{problemId:string, candidateIds:string[], mode?:string, poster?:{name?:string,email?:string}}} opts
 */
async function startRun(opts) {
  const problem = getProblem(opts.problemId);
  if (!problem) throw httpError(404, 'Problem not found');
  const ids = [...new Set(Array.isArray(opts.candidateIds) ? opts.candidateIds.map(String) : [])];
  if (ids.length === 0) throw httpError(400, 'Pick at least one candidate');
  if (ids.length > config.maxCandidatesPerRun) throw httpError(400, `At most ${config.maxCandidatesPerRun} candidates per run`);
  const candidates = ids.map((id) => getCandidate(id));
  if (candidates.some((c) => !c)) throw httpError(404, 'Unknown candidate');
  if (activeCount() >= config.maxConcurrentRuns) throw httpError(429, 'Too many runs in progress — wait for one to finish');
  if (opts.mode && !['live', 'rehearsal', 'auto'].includes(opts.mode)) throw httpError(400, 'mode must be live, rehearsal or auto');
  const mode = config.resolveMode(opts.mode);
  if (mode === 'live' && !config.anthropicKey) throw httpError(400, 'Live mode needs ANTHROPIC_API_KEY. Use rehearsal mode or set the key.');

  const posterName = String(opts.poster?.name || process.env.TRYOUT_POSTER_NAME || 'Problem poster').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const posterEmail = String(opts.poster?.email || process.env.TRYOUT_POSTER_EMAIL || '').trim().slice(0, 200);
  if (posterEmail && !EMAIL_RE.test(posterEmail)) throw httpError(400, 'Invalid poster email');

  const driver = getDriver();
  const run = {
    id: crypto.randomBytes(6).toString('hex'),
    status: 'running',
    mode,
    problem: publicProblem(problem),
    poster: { name: posterName, email: posterEmail },
    createdAt: Date.now(),
    sandbox: driver.describe(),
    entries: candidates.map((c, i) => ({
      candidateId: c.id,
      candidate: publicCandidate(c),
      strategy: c.rehearsalStrategy || STRATEGIES[i % STRATEGIES.length],
      status: 'queued',
    })),
    events: [],
  };
  const controller = new AbortController();
  live.set(run.id, { run, subscribers: new Set(), controller });
  await store().set(run.id, run);
  emitter(null, run)('run_started', { problem: run.problem.title, mode, candidates: run.entries.map((e) => e.candidate.name), sandbox: run.sandbox.driver });

  execute(run, problem, candidates, controller.signal)
    .catch(async (err) => {
      run.status = 'error';
      run.error = errText(err);
      run.endedAt = Date.now();
      emitter(null, run)('run_error', { message: run.error });
      await store().set(run.id, run);
    })
    .catch((e) => console.error('[tryout] failed to record run error:', e))
    .finally(() => finalize(run.id));
  return viewRun(run);
}

async function execute(run, problem, candidates, signal) {
  await ensureExpected(problem);
  run.problem = publicProblem(problem);
  const protectedPaths = protectedPathsFor(problem);

  await Promise.all(
    run.entries.map(async (entry, i) => {
      const candidate = candidates[i];
      const emit = emitter(entry, run);
      let sandbox;
      entry.status = 'running';
      entry.startedAt = Date.now();
      emit('agent_started', { label: `${candidate.name}'s agent started`, mode: run.mode });
      try {
        sandbox = await createSandbox(problem.repo, { protectedPaths });
        const agentFn = run.mode === 'live' ? runClaudeAgent : runRehearsalAgent;
        const out = await agentFn({ candidate, problem, sandbox, emit, signal, strategy: entry.strategy });
        Object.assign(entry, { turns: out.turns, usage: out.usage, summary: out.summary, stopReason: out.stopReason, testRuns: out.testRuns });
        if (signal.aborted) throw new Error('cancelled');
        entry.status = 'scoring';
        entry.endedAt = Date.now();
        entry.durationMs = entry.endedAt - entry.startedAt;
        emit('scoring', { label: 'running hidden tests…' });
        const snapshot = await sandbox.snapshot();
        entry.result = await scoreAttempt(problem, snapshot, { blockedWrites: sandbox.blockedWrites.length });
        entry.status = 'done';
        emit('scored', {
          score: entry.result.score,
          visible: entry.result.visible,
          hidden: { passed: entry.result.hidden.passed, total: entry.result.hidden.total },
          flags: entry.result.flags,
          linesChanged: entry.result.linesChanged,
          label: `score ${entry.result.score}`,
        });
      } catch (err) {
        entry.endedAt = entry.endedAt || Date.now();
        entry.durationMs = entry.endedAt - entry.startedAt;
        if (signal.aborted || (err && err.message === 'cancelled')) {
          entry.status = 'cancelled';
          emit('agent_cancelled', { label: 'cancelled' });
        } else {
          entry.status = 'error';
          entry.error = errText(err);
          emit('agent_error', { label: `error: ${entry.error}` });
          // Still score whatever the agent left behind — partial work counts.
          if (sandbox && !sandbox.destroyed) {
            try {
              entry.result = await scoreAttempt(problem, await sandbox.snapshot(), { blockedWrites: sandbox.blockedWrites.length });
              emit('scored', { score: entry.result.score, visible: entry.result.visible, hidden: entry.result.hidden, flags: entry.result.flags, label: `score ${entry.result.score} (after error)` });
            } catch {}
          }
        }
      } finally {
        if (sandbox) await sandbox.destroy().catch(() => {});
      }
    }),
  );

  run.endedAt = Date.now();
  if (signal.aborted) {
    run.status = 'cancelled';
    emitter(null, run)('run_cancelled', {});
  } else {
    const ranked = rank(run.entries.filter((e) => e.result));
    ranked.forEach((e, idx) => (e.rank = idx + 1));
    const top = ranked[0];
    run.winnerId = top && top.result.score > 0 && !top.result.disqualified ? top.candidateId : null;
    run.status = 'complete';
    emitter(null, run)('run_complete', {
      winnerId: run.winnerId,
      leaderboard: ranked.map((e) => ({ candidateId: e.candidateId, name: e.candidate.name, score: e.result.score, rank: e.rank })),
    });
  }
  await store().set(run.id, run);
}

function getRun(id) {
  const l = live.get(id);
  if (l) return l.run;
  return store().get(id);
}

function listRuns() {
  return store()
    .all()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((r) => ({ id: r.id, status: r.status, mode: r.mode, problem: r.problem?.title, createdAt: r.createdAt, winnerId: r.winnerId || null }));
}

function subscribe(id, fn) {
  const l = live.get(id);
  if (!l) return () => {};
  l.subscribers.add(fn);
  return () => l.subscribers.delete(fn);
}

function cancelRun(id) {
  const l = live.get(id);
  if (!l || !['running', 'scoring'].includes(l.run.status)) return false;
  l.controller.abort();
  return true;
}

async function setIntro(runId, introId) {
  const run = getRun(runId);
  if (!run) return;
  run.introId = introId;
  await store().set(run.id, run);
}

/** For tests: wait until a run leaves running/scoring. */
function waitForRun(id, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const r = getRun(id);
      if (r && !['running', 'scoring'].includes(r.status)) return resolve(r);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for run'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

module.exports = { startRun, getRun, viewRun, listRuns, subscribe, cancelRun, setIntro, waitForRun, activeCount };
