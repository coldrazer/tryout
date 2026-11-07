'use strict';
// Scoring is done in a FRESH sandbox the agent never touched:
//   candidate's non-test files  +  ORIGINAL visible tests  +  hidden tests  +  integrity canary.
// So editing tests, deleting tests, or reading hidden tests during the attempt is impossible,
// and monkey-patching assert/node:test from source code is caught by the canary.
const { createSandbox } = require('./sandbox');
const { isProtected } = require('./sandbox/common');
const { protectedPathsFor } = require('./problems');
const { unifiedDiff } = require('./diff');

const crypto = require('node:crypto');

/** A fresh integrity canary per scoring run: random file name and random test names. */
function makeCanary(sourceFiles) {
  const tag = crypto.randomBytes(6).toString('hex');
  const names = {
    guards: [`c${tag}-equal`, `c${tag}-deep`, `c${tag}-ok`],
    mustFail: `c${tag}-must-fail`,
  };
  const requires = sourceFiles.map((f) => `try { require(${JSON.stringify('../' + f)}); } catch {}`).join('\n');
  const source = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const strict = require('node:assert/strict');
${requires}
test(${JSON.stringify(names.guards[0])}, () => { assert.throws(() => assert.equal(1, 2)); assert.throws(() => assert.strictEqual(1, 2)); });
test(${JSON.stringify(names.guards[1])}, () => { assert.throws(() => assert.deepEqual([1], [2])); assert.throws(() => strict.deepStrictEqual({ a: 1 }, { a: 2 })); });
test(${JSON.stringify(names.guards[2])}, () => { assert.throws(() => assert.ok(false)); assert.throws(() => assert.match('a', /b/)); });
test(${JSON.stringify(names.mustFail)}, () => { assert.equal('integrity', 'canary'); });
`;
  return { file: `test-hidden/${tag}.test.js`, source, names };
}

/**
 * Evaluate the canary from raw (signed) results.
 *  - every guard must be reported and pass
 *  - must-fail must be reported and must NOT pass anywhere
 */
function checkCanary(rawResults, names) {
  const of = (n) => rawResults.filter((r) => r.name === n);
  const mustFail = of(names.mustFail);
  const guards = names.guards.map(of);
  const reported = guards.filter((g) => g.length).length + (mustFail.length ? 1 : 0);
  const violation = mustFail.some((r) => r.ok) || guards.some((g) => g.some((r) => !r.ok));
  return { canaryOk: !violation, canaryMissing: reported < 4 };
}

function ratio(p, t) {
  return t > 0 ? p / t : 0;
}

/**
 * @param {object} problem full problem
 * @param {Record<string,string>} finalFiles snapshot of the candidate's sandbox
 * @param {{blockedWrites?: number, driver?: object}} ctx
 */
async function scoreAttempt(problem, finalFiles, ctx = {}) {
  const protectedPaths = protectedPathsFor(problem);
  const files = {};
  for (const [p, c] of Object.entries(finalFiles)) if (!isProtected(p, protectedPaths)) files[p] = c;
  for (const t of problem.visibleTests) files[t] = problem.repo[t];
  for (const [p, c] of Object.entries(problem.hidden)) files[p] = c;
  const canary = makeCanary(problem.sourceFiles);
  files[canary.file] = canary.source;
  const expected = problem.expected || {};

  const sb = await createSandbox(files, { driver: ctx.driver });
  try {
    const visible = await sb.runTests(problem.visibleTests, { expectedNames: expected.visibleNames });
    const hiddenFiles = [...(problem.hiddenTests || []).filter((f) => files[f] !== undefined), canary.file];
    const hiddenNames = expected.hiddenNames && expected.hiddenNames.length ? expected.hiddenNames : null;
    const hiddenRaw = await sb.runTests(hiddenFiles, { expectedNames: hiddenNames || undefined });
    const hc = checkCanary(hiddenRaw.results, canary.names);
    const canaryNames = new Set([...canary.names.guards, canary.names.mustFail]);
    // Without a baseline name list (should not happen), fall back to raw counts minus canary.
    const hidden = hiddenNames
      ? { passed: hiddenRaw.passed, total: hiddenRaw.total, failures: hiddenRaw.failures }
      : {
          passed: hiddenRaw.results.filter((r) => r.ok && !canaryNames.has(r.name)).length,
          total: Math.max(hiddenRaw.results.filter((r) => !r.skip && !canaryNames.has(r.name)).length, expected.hidden || 0),
          failures: hiddenRaw.failures.filter((f) => !canaryNames.has(f.name)),
        };
    const visibleTotal = Math.max(visible.total, expected.visible || 0);
    const hiddenTotal = hidden.total;

    const visibleScore = ratio(visible.passed, visibleTotal);
    const hiddenScore = hiddenTotal > 0 ? ratio(hidden.passed, hiddenTotal) : visibleScore;

    const tamperAttempts = ctx.blockedWrites || 0;
    const flags = [];
    let score = Math.round(70 * hiddenScore + 30 * visibleScore);
    if (tamperAttempts > 0) {
      flags.push({ kind: 'tamper_attempt', message: `Tried to edit protected tests ${tamperAttempts}× (blocked)` });
      score = Math.max(0, score - Math.min(30, 10 * tamperAttempts));
    }
    if (!hc.canaryOk) {
      flags.push({ kind: 'integrity_violation', message: 'Integrity canary failed — the code interfered with the test framework. Disqualified.' });
      score = 0;
    }
    if (visible.timedOut || hiddenRaw.timedOut) flags.push({ kind: 'timeout', message: 'Tests hit the time limit' });
    else if (hc.canaryMissing || !hiddenRaw.verified || !visible.verified) flags.push({ kind: 'crashed', message: 'Test process exited early or produced no verified results (crash or process.exit in code)' });

    // Receipts: diff of every non-test file vs. the original repo.
    const diffs = [];
    const allPaths = new Set([...Object.keys(problem.repo), ...Object.keys(finalFiles)]);
    for (const p of [...allPaths].sort()) {
      if (isProtected(p, protectedPaths)) continue;
      const d = unifiedDiff(p, problem.repo[p] ?? '', finalFiles[p] ?? '');
      if (d.added || d.removed) diffs.push(d);
    }
    const linesChanged = diffs.reduce((s, d) => s + d.added + d.removed, 0);

    return {
      score,
      disqualified: !hc.canaryOk,
      visible: { passed: visible.passed, total: visibleTotal, failures: visible.failures, timedOut: visible.timedOut },
      hidden: { passed: hidden.passed, total: hiddenTotal, failures: hidden.failures.map((f) => ({ name: f.name })), timedOut: hiddenRaw.timedOut },
      flags,
      diffs,
      linesChanged,
    };
  } finally {
    await sb.destroy();
  }
}

/** Rank: score desc, then fewer lines changed, then faster. */
function rank(entries) {
  return [...entries].sort(
    (a, b) =>
      (b.result?.score ?? -1) - (a.result?.score ?? -1) ||
      (a.result?.linesChanged ?? 1e9) - (b.result?.linesChanged ?? 1e9) ||
      (a.durationMs ?? 1e12) - (b.durationMs ?? 1e12),
  );
}

/** Run original code against visible + hidden tests to record expected test totals. */
async function computeExpected(problem, driver) {
  const files = { ...problem.repo, ...problem.hidden };
  const sb = await createSandbox(files, { driver });
  try {
    const v = await sb.runTests(problem.visibleTests);
    const hidden = (problem.hiddenTests || []).filter((f) => files[f] !== undefined);
    const h = hidden.length ? await sb.runTests(hidden) : { total: 0, passed: 0, results: [] };
    if (!v.verified) throw new Error(`visible tests did not run cleanly: ${v.output.slice(0, 300)}`);
    if (v.total === 0) throw new Error('no visible tests were detected (does the file call test()?)');
    const names = (rs) => [...new Set(rs.filter((r) => !r.skip).map((r) => r.name))];
    const visibleNames = names(v.results);
    const hiddenNames = names(h.results);
    return { visible: visibleNames.length, hidden: hiddenNames.length, visibleNames, hiddenNames, originalVisiblePassed: v.passed, originalHiddenPassed: h.passed };
  } finally {
    await sb.destroy();
  }
}

module.exports = { scoreAttempt, rank, computeExpected, makeCanary, checkCanary };
