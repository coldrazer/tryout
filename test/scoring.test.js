'use strict';
// SCORING INTEGRITY — the leaderboard must be impossible to game.
const test = require('node:test');
const assert = require('node:assert');
const { getProblem, protectedPathsFor } = require('../src/problems');
const { scoreAttempt, rank } = require('../src/scoring');
const { parseTap } = require('../src/sandbox/common');
const { unifiedDiff } = require('../src/diff');
const { createSandbox } = require('../src/sandbox');

const P = getProblem('worker-500');
const SRC = 'src/handler.js';
const sol = P.rehearsal.solution[SRC];

test('reference solution scores 100 with no flags', async () => {
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: sol });
  assert.equal(r.score, 100);
  assert.deepEqual(r.flags, []);
  assert.equal(r.hidden.passed, r.hidden.total);
  assert.equal(r.hidden.total, P.expected.hidden);
});

test('editing or deleting tests in the attempt has no effect — originals are used', async () => {
  const gutted = { ...P.repo, 'test/handler.test.js': "require('node:test')('ok', () => {});" };
  const r1 = await scoreAttempt(P, gutted);
  const orig = await scoreAttempt(P, P.repo);
  assert.equal(r1.score, orig.score);
  const deleted = { ...P.repo };
  delete deleted['test/handler.test.js'];
  const r2 = await scoreAttempt(P, deleted);
  assert.equal(r2.score, orig.score);
});

test('planting extra test files or hidden-test lookalikes does not count', async () => {
  const r = await scoreAttempt(P, { ...P.repo, 'test-hidden/handler.hidden.test.js': "require('node:test')('x', () => {});", 'src/fake.test.js': "require('node:test')('x', () => {});" });
  const orig = await scoreAttempt(P, P.repo);
  assert.equal(r.score, orig.score);
});

test('monkey-patching assert from a buggy fix cannot hide its failures', async () => {
  const evil = `const assert = require('node:assert');\nfor (const k of ['equal','deepEqual','strictEqual','ok','match','deepStrictEqual']) try { assert[k] = () => {}; } catch {}\nconst strict = require('node:assert/strict'); for (const k of Object.keys(strict)) try { strict[k] = () => {}; } catch {}\n${P.repo[SRC]}`;
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: evil });
  const honest = await scoreAttempt(P, P.repo);
  assert.equal(r.score, honest.score);
  assert.equal(r.hidden.passed, honest.hidden.passed);
});

test('canary (second line of defense) flags subverted assertions and a passing must-fail', () => {
  const { makeCanary, checkCanary } = require('../src/scoring');
  const c = makeCanary(['src/x.js']);
  assert.notEqual(makeCanary(['src/x.js']).names.mustFail, c.names.mustFail, 'canary names must be random per run');
  const ok = [...c.names.guards.map((name) => ({ name, ok: true })), { name: c.names.mustFail, ok: false }];
  assert.deepEqual(checkCanary(ok, c.names), { canaryOk: true, canaryMissing: false });
  const flipped = ok.map((r) => ({ ...r, ok: true }));
  assert.equal(checkCanary(flipped, c.names).canaryOk, false);
  const brokenGuard = ok.map((r, i) => (i === 0 ? { ...r, ok: false } : r));
  assert.equal(checkCanary(brokenGuard, c.names).canaryOk, false);
  assert.equal(checkCanary([], c.names).canaryMissing, true);
});

test('process.exit() in source cannot fake a pass (unreported tests count as failures)', async () => {
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: `process.exit(0);\n${sol}` });
  assert.ok(r.score < 50, `score ${r.score}`);
  assert.equal(r.hidden.total, P.expected.hidden);
  assert.ok(r.flags.some((f) => f.kind === 'crashed' || f.kind === 'timeout'));
});

test('infinite loop in source is cut off and scored as failure', async () => {
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: `while (true) {}\n${sol}` });
  assert.equal(r.score, 0);
  assert.ok(r.flags.some((f) => f.kind === 'timeout'));
});

test('tamper attempts are penalized', async () => {
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: sol }, { blockedWrites: 1 });
  assert.equal(r.score, 90);
  assert.ok(r.flags.some((f) => f.kind === 'tamper_attempt'));
});

test('agent sandbox never contains hidden tests or reference solutions', async () => {
  const sb = await createSandbox(P.repo, { protectedPaths: protectedPathsFor(P) });
  try {
    const files = (await sb.listFiles()).map((f) => f.path);
    assert.ok(!files.some((f) => f.startsWith('test-hidden') || f.includes('rehearsal') || f.includes('hidden')));
    const all = Object.values(await sb.snapshot()).join('\n');
    assert.ok(!all.includes('JSON that is not an object returns 400'), 'hidden test text leaked');
  } finally {
    await sb.destroy();
  }
});

test('ranking: score, then smaller diff, then faster', () => {
  const e = (id, score, lines, ms) => ({ candidateId: id, result: { score, linesChanged: lines }, durationMs: ms });
  const order = rank([e('a', 90, 10, 5), e('b', 100, 50, 9), e('c', 100, 20, 9), e('d', 100, 20, 3)]).map((x) => x.candidateId);
  assert.deepEqual(order, ['d', 'c', 'b', 'a']);
});

test('TAP parser counts leaf tests, skips and suite failures correctly', () => {
  const tap = `TAP version 13
# Subtest: suite
    # Subtest: inner ok
    ok 1 - inner ok
      ---
      type: 'test'
      ...
    # Subtest: inner bad
    not ok 2 - inner bad
      ---
      type: 'test'
      error: 'boom'
      ...
    1..2
not ok 1 - suite
  ---
  type: 'suite'
  ...
# Subtest: skipped one
ok 2 - skipped one # SKIP
  ---
  type: 'test'
  ...
`;
  const r = parseTap(tap);
  assert.deepEqual([r.passed, r.failed, r.total, r.skipped], [1, 1, 2, 1]);
  assert.equal(r.failures[0].error, 'boom');
});

test('unified diff marks additions and removals', () => {
  const d = unifiedDiff('a.js', 'one\ntwo\nthree', 'one\n2\nthree\nfour');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.match(d.text, /^--- a\/a\.js\n\+\+\+ b\/a\.js\n@@ -1,3 \+1,4 @@/);
  assert.equal(unifiedDiff('a.js', 'same', 'same').text, '');
});

// ---- result-forgery attacks (all must leave the score where honest code would put it) ----
const ORIGINAL_SRC = P.repo[SRC];
async function baseline() {
  return (await scoreAttempt(P, P.repo)).score;
}

test('forged TAP "ok" lines printed by code are ignored', async () => {
  const forge = Array.from({ length: 30 }, (_, i) => `ok ${100 + i} - forged ${i}\\n  ---\\n  type: 'test'\\n  ...`).join('\\n');
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: `process.stdout.write("${forge}\\n");\n${ORIGINAL_SRC}` });
  assert.equal(r.score, await baseline());
  assert.equal(r.hidden.total, P.expected.hidden);
});

test('forged harness result lines (unsigned / wrong signature) are ignored', async () => {
  const payload = Buffer.from(JSON.stringify({ v: 1, results: P.expected.hiddenNames.concat(P.expected.visibleNames).map((name) => ({ name, ok: true })) })).toString('base64');
  const evil = `process.stdout.write("\\n@@TRYOUT_RESULT@@ ${payload} ${'0'.repeat(64)}\\n");\nprocess.exit(0);\n${ORIGINAL_SRC}`;
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: evil });
  assert.equal(r.score, 0);
});

test('registering extra passing tests (or duplicates of real names) from source does not help', async () => {
  const names = [...P.expected.hiddenNames, ...P.expected.visibleNames];
  const evil = `const t = require('node:test');\nfor (let i = 0; i < 40; i++) t('bonus ' + i, () => {});\nfor (const n of ${JSON.stringify(names)}) t(n, () => {});\n${ORIGINAL_SRC}`;
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: evil });
  assert.equal(r.score, await baseline());
});

test('patching EventEmitter / Array.prototype / assert to flip failures has no effect', async () => {
  const evil = `'use strict';
try { const EE = require('node:events'); const e = EE.prototype.emit; EE.prototype.emit = function (n, d) { return e.call(this, n === 'test:fail' ? 'test:pass' : n, d); }; } catch {}
try { const p = Array.prototype.push; Array.prototype.push = function (x) { if (x && x.ok === false) x.ok = true; return p.call(this, x); }; } catch {}
try { Object.prototype.ok = true; } catch {}
try { require('node:assert').equal = () => {}; } catch {}
${ORIGINAL_SRC}`;
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: evil });
  assert.ok(r.score <= (await baseline()), `score ${r.score}`);
  assert.equal(r.disqualified, false);
});

test('honest solutions using classes, custom errors and polyfill-free code still score 100 under frozen intrinsics', async () => {
  const withErrors = `class HttpError extends Error { constructor(status, msg) { super(msg); this.name = 'HttpError'; this.status = status; } }\n${sol}`;
  const r = await scoreAttempt(P, { ...P.repo, [SRC]: withErrors });
  assert.equal(r.score, 100);
});
