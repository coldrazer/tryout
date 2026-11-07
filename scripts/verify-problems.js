#!/usr/bin/env node
'use strict';
// Verifies every problem is a good tryout and records expected test totals in problem.json:
//   - original code FAILS at least one visible test
//   - reference solution scores 100 (all visible + hidden pass, canary OK)
//   - partial solution passes visible tests but fails at least one hidden test
// Usage: node scripts/verify-problems.js [--driver local|docker] [--no-write]
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { listProblems } = require('../src/problems');
const { scoreAttempt, computeExpected } = require('../src/scoring');
const { getDriver } = require('../src/sandbox');

async function main() {
  const args = process.argv.slice(2);
  const driverName = args.includes('--driver') ? args[args.indexOf('--driver') + 1] : config.sandboxDriver;
  const write = !args.includes('--no-write');
  const driver = getDriver(driverName);
  console.log(`Sandbox driver: ${driver.name}`);
  let ok = true;
  for (const p of listProblems().filter((x) => x.source === 'seed')) {
    const expected = await computeExpected(p, driver);
    p.expected = expected;
    const orig = await scoreAttempt(p, p.repo, { driver });
    const sol = await scoreAttempt(p, { ...p.repo, ...p.rehearsal.solution }, { driver });
    const hasPartial = Object.keys(p.rehearsal.partial).length > 0;
    const part = hasPartial ? await scoreAttempt(p, { ...p.repo, ...p.rehearsal.partial }, { driver }) : null;

    const checks = [
      ['original fails a visible test', orig.visible.passed < orig.visible.total],
      ['solution scores 100', sol.score === 100 && sol.flags.length === 0],
      ...(part
        ? [
            ['partial passes all visible', part.visible.passed === part.visible.total],
            ['partial fails ≥1 hidden', part.hidden.passed < part.hidden.total],
          ]
        : []),
    ];
    const line = `${p.id.padEnd(14)} visible=${expected.visible} hidden=${expected.hidden} | original ${orig.score} | solution ${sol.score} | partial ${part ? part.score : '-'}`;
    console.log(line);
    for (const [name, pass] of checks) {
      console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${name}`);
      if (!pass) ok = false;
    }
    if (!sol.score || sol.score !== 100) console.log(JSON.stringify(sol, null, 2));
    if (write) {
      const metaPath = path.join(config.problemsDir, p.id, 'problem.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.expected = { visible: expected.visible, hidden: expected.hidden, visibleNames: expected.visibleNames, hiddenNames: expected.hiddenNames };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    }
  }
  console.log(ok ? '\nAll problems verified.' : '\nSome checks FAILED.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
