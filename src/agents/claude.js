'use strict';
// Live agent: a Claude tool-use loop over the sandbox tools.
const config = require('../config');
const { TOOL_DEFS, bindTools } = require('./tools');

function systemPrompt(candidate, problem) {
  const skills = (candidate.skills || []).join(', ') || 'general software engineering';
  const evidence = (candidate.evidence || [])
    .slice(0, 5)
    .map((e) => `- ${e.title}${e.detail ? `: ${e.detail}` : ''}`)
    .join('\n');
  return `You are the tryout agent for ${candidate.name}. ${candidate.name} is a developer. ${candidate.summary || ''}
Their strengths: ${skills}.${evidence ? `\nThings they have actually shipped:\n${evidence}` : ''}

You are auditioning on behalf of ${candidate.name} for a real problem someone posted. Your work is the proof of their skill, so work the way a strong engineer with their background would.

How the tryout works:
- The workspace contains the project. Test files are protected and read-only.
- run_tests runs the VISIBLE tests in an isolated sandbox. At scoring time, additional HIDDEN tests check the same requirements more thoroughly. Fix the root cause in a general, robust way. Never special-case the visible tests.
- You have no shell and no network; use only the provided tools.
- Score = hidden tests (70%) + visible tests (30%). Smaller, cleaner diffs win ties. Attempts to edit tests are blocked and penalized.
- Be efficient: you have at most ${config.agentMaxTurns} tool turns.
- When finished, call submit with a 2-3 sentence summary of the root cause and your fix.

Problem: ${problem.title}
${problem.brief}`;
}

async function callClaude(body, { signal }) {
  const url = `${config.anthropicBaseUrl}/v1/messages`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new Error('cancelled');
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new Error('cancelled');
      lastErr = e;
      await sleep(800 * 2 ** attempt, signal);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    lastErr = new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
    lastErr.status = res.status;
    if (![429, 500, 502, 503, 504, 529].includes(res.status)) throw lastErr;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt, signal);
  }
  throw lastErr;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}

/**
 * Run a live agent. Resolves with { summary, turns, usage, submitted, stopReason }.
 */
async function runClaudeAgent({ candidate, problem, sandbox, emit, signal }) {
  const { execute, state } = bindTools({ sandbox, problem, emit });
  const model = candidate.model || config.model;
  const messages = [
    {
      role: 'user',
      content: `Start your tryout now. Explore the workspace, reproduce the failure with run_tests, fix it, verify, then submit.`,
    },
  ];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const deadline = Date.now() + config.agentMaxMs;
  let turns = 0;
  let stopReason = 'max_turns';

  emit('status', { label: `${model} thinking…` });
  while (turns < config.agentMaxTurns) {
    if (signal?.aborted) {
      stopReason = 'cancelled';
      break;
    }
    if (Date.now() > deadline) {
      stopReason = 'time_limit';
      break;
    }
    turns++;
    const callSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1000, deadline - Date.now())), ...(signal ? [signal] : [])]);
    let resp;
    try {
      resp = await callClaude(
        { model, max_tokens: config.agentMaxTokens, system: systemPrompt(candidate, problem), tools: TOOL_DEFS, messages },
        { signal: callSignal },
      );
    } catch (e) {
      if (signal?.aborted) {
        stopReason = 'cancelled';
        break;
      }
      if (callSignal.aborted) {
        stopReason = 'time_limit';
        break;
      }
      throw e;
    }
    usage.input_tokens += resp.usage?.input_tokens || 0;
    usage.output_tokens += resp.usage?.output_tokens || 0;
    const blocks = Array.isArray(resp.content) ? resp.content : [];
    messages.push({ role: 'assistant', content: blocks });

    for (const b of blocks) {
      if (b.type === 'text' && b.text.trim()) emit('thought', { text: b.text.trim().slice(0, 600) });
    }
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (resp.stop_reason === 'end_turn') {
        // Nudge once to use submit; otherwise treat as done.
        if (!state.submitted && turns < config.agentMaxTurns) {
          messages.push({ role: 'user', content: 'Please call the submit tool to finish your tryout.' });
          continue;
        }
      }
      stopReason = resp.stop_reason || 'end_turn';
      break;
    }
    const results = [];
    let done = false;
    for (const tu of toolUses) {
      const r = await execute(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      if (r.done) done = true;
    }
    messages.push({ role: 'user', content: results });
    if (done) {
      stopReason = 'submitted';
      break;
    }
  }
  return { summary: state.summary, turns, usage, submitted: state.submitted, stopReason, testRuns: state.testRuns, lastTests: state.lastTests };
}

module.exports = { runClaudeAgent, systemPrompt, callClaude };
