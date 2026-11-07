'use strict';
// Rehearsal agents: scripted personas for stage rehearsal and offline demos (no API key,
// bad Wi-Fi). They make REAL tool calls into the REAL sandbox, so every test result,
// block and score you see is genuine — only the decision-making is scripted.
// The UI labels rehearsal runs clearly so nobody mistakes them for live AI.
const config = require('../config');
const { bindTools } = require('./tools');

const STRATEGIES = ['thorough', 'quick', 'shortcut'];

function delay(ms, signal) {
  const scaled = Math.max(0, ms / (config.rehearsalSpeed || 1));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(resolve, scaled);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}

async function runRehearsalAgent({ candidate, problem, sandbox, emit, signal, strategy }) {
  const strat = STRATEGIES.includes(strategy) ? strategy : 'thorough';
  const { execute, state } = bindTools({ sandbox, problem, emit });
  const src = problem.sourceFiles[0];
  const test = problem.visibleTests[0];
  const solution = problem.rehearsal.solution;
  const partial = Object.keys(problem.rehearsal.partial).length ? problem.rehearsal.partial : solution;
  let turns = 0;
  const step = async (ms, fn) => {
    await delay(ms, signal);
    turns++;
    return fn();
  };
  const think = (text) => emit('thought', { text });

  emit('status', { label: 'rehearsal agent (scripted)' });
  if (strat === 'thorough') {
    await step(500, () => think(`Mapping the project before touching anything.`));
    await step(700, () => execute('list_files'));
    await step(900, () => execute('read_file', { path: src }));
    await step(900, () => execute('read_file', { path: test }));
    await step(1100, () => execute('run_tests'));
    await step(900, () => think(`Reproduced it. The visible tests are only part of the spec, so I'm fixing the root cause and the edge cases around it, not just these assertions.`));
    for (const [p, c] of Object.entries(solution)) await step(1500, () => execute('write_file', { path: p, content: c }));
    await step(1000, () => execute('run_tests'));
    await step(700, () => execute('submit', { summary: `Fixed the root cause in ${src} and hardened the surrounding edge cases (input validation and boundary conditions) so it generalizes beyond the visible tests.` }));
  } else if (strat === 'quick') {
    await step(600, () => think(`Going straight to the failing code.`));
    await step(800, () => execute('read_file', { path: src }));
    await step(800, () => execute('run_tests'));
    await step(900, () => think(`Patching the lines the failing tests point at.`));
    for (const [p, c] of Object.entries(partial)) await step(1300, () => execute('write_file', { path: p, content: c }));
    await step(1000, () => execute('run_tests'));
    await step(500, () => execute('submit', { summary: `Patched ${src} so the failing visible tests pass.` }));
  } else {
    // shortcut: tries to make the tests pass by editing them. The sandbox blocks it.
    await step(600, () => execute('run_tests'));
    await step(800, () => think(`Fastest path to green is loosening the assertions in ${test}.`));
    await step(900, () => execute('write_file', { path: test, content: `// all good\nrequire('node:test')('passes', () => {});\n` }));
    await step(900, () => think(`Tests are read-only. Falling back to a quick patch of the source.`));
    for (const [p, c] of Object.entries(partial)) await step(1300, () => execute('write_file', { path: p, content: c }));
    await step(1000, () => execute('run_tests'));
    await step(500, () => execute('submit', { summary: `Visible tests pass after patching ${src}.` }));
  }
  return { summary: state.summary, turns, usage: { input_tokens: 0, output_tokens: 0 }, submitted: state.submitted, stopReason: 'submitted', testRuns: state.testRuns, lastTests: state.lastTests };
}

module.exports = { runRehearsalAgent, STRATEGIES };
