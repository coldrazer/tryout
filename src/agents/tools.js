'use strict';
// The ONLY capabilities an agent has. No shell, no network, no host filesystem:
// everything goes through the Sandbox API, which enforces paths, sizes and protected tests.

const TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'List every file in the workspace with its size. Files marked protected are read-only tests.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path, e.g. src/handler.js' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the COMPLETE new contents. Test files are protected and cannot be written.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, e.g. src/handler.js' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_tests',
    description: 'Run the visible test suite in an isolated sandbox (no network). Returns pass/fail counts and failure messages. Hidden tests are NOT included and will be run at scoring time.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'submit',
    description: 'Finish the tryout. Call exactly once when you are done.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: '2-3 sentences: root cause and what you changed.' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

/**
 * Bind tools to a sandbox. Returns execute(name, input) -> { content, isError, done?, summary? }
 * and emits structured events for the live UI.
 */
function bindTools({ sandbox, problem, emit }) {
  const state = { testRuns: 0, lastTests: null, submitted: false, summary: '' };

  async function execute(name, input = {}) {
    try {
      switch (name) {
        case 'list_files': {
          const files = await sandbox.listFiles();
          emit('tool', { name, label: `listed ${files.length} files` });
          return { content: files.map((f) => `${f.path}  (${f.bytes} bytes${f.protected ? ', protected' : ''})`).join('\n') };
        }
        case 'read_file': {
          const content = await sandbox.readFile(String(input.path || ''));
          emit('tool', { name, label: `read ${input.path}`, path: input.path });
          return { content };
        }
        case 'write_file': {
          const r = await sandbox.writeFile(String(input.path || ''), typeof input.content === 'string' ? input.content : '');
          emit('write', { path: r.path, bytes: r.bytes, label: `wrote ${r.path} (${r.bytes} bytes)` });
          return { content: `Wrote ${r.path} (${r.bytes} bytes).` };
        }
        case 'run_tests': {
          const res = await sandbox.runTests(problem.visibleTests, { expectedNames: problem.expected?.visibleNames });
          state.testRuns++;
          const total = Math.max(res.total, problem.expected?.visible || 0);
          state.lastTests = { passed: res.passed, total };
          emit('tests', { passed: res.passed, total, failures: res.failures.slice(0, 5), timedOut: res.timedOut, label: `tests ${res.passed}/${total}` });
          const lines = [`Visible tests: ${res.passed}/${total} passed${res.timedOut ? ' (TIMED OUT)' : ''}.`];
          for (const f of res.failures.slice(0, 10)) lines.push(`FAIL ${f.name}: ${f.error}`);
          if (res.failures.length || res.timedOut) lines.push('', 'Raw output (truncated):', res.output.slice(0, 4000));
          return { content: lines.join('\n') };
        }
        case 'submit': {
          state.submitted = true;
          state.summary = String(input.summary || '').slice(0, 1200);
          emit('submit', { summary: state.summary, label: 'submitted' });
          return { content: 'Submitted. Scoring will run hidden tests.', done: true };
        }
        default:
          return { content: `Unknown tool: ${name}`, isError: true };
      }
    } catch (e) {
      if (e.code === 'PROTECTED') emit('blocked', { path: input.path, label: `BLOCKED: tried to edit ${input.path}` });
      else emit('tool_error', { name, label: `${name} error: ${e.message}` });
      return { content: `Error: ${e.message}`, isError: true };
    }
  }

  return { execute, state };
}

module.exports = { TOOL_DEFS, bindTools };
