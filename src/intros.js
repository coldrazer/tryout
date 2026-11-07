'use strict';
// Two-sided consent. Nobody's contact details are shared until BOTH people say yes.
// Each side gets its own secret token (link); a token can only answer for its own side.
const crypto = require('node:crypto');
const config = require('./config');
const { Collection } = require('./store');
const { getRun, setIntro } = require('./orchestrator');
const { getCandidate, EMAIL_RE } = require('./profiles');

let intros = null;
const creating = new Set(); // runIds with an intro being created (prevents double-create races)
const coll = () => (intros ||= new Collection('intros'));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function token() {
  return crypto.randomBytes(18).toString('base64url');
}

function tokensMatch(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

function roleFor(intro, tok) {
  if (tokensMatch(tok, intro.posterToken)) return 'poster';
  if (tokensMatch(tok, intro.candidateToken)) return 'candidate';
  return null;
}

/** What a given party may see. Emails only after both accept. */
function viewIntro(intro, role) {
  const both = intro.status === 'accepted';
  return {
    id: intro.id,
    runId: intro.runId,
    role,
    status: intro.status,
    problem: intro.problem,
    poster: { name: intro.poster.name, email: both ? intro.poster.email : undefined, decision: intro.posterDecision },
    candidate: { name: intro.candidate.name, github: intro.candidate.github, email: both ? intro.candidate.email : undefined, decision: intro.candidateDecision },
    receipts: intro.receipts,
    email: both ? intro.email : null,
    delivery: intro.delivery || null,
    createdAt: intro.createdAt,
  };
}

function baseUrl(reqHost) {
  return config.publicUrl || (reqHost ? `http://${reqHost}` : `http://localhost:${config.port}`);
}

/**
 * Create the intro for a completed run's winner. Returns both links (show the poster link to
 * the poster; send/hand the candidate link to the candidate).
 */
async function createIntro(runId, opts = {}) {
  if (creating.has(runId)) throw httpError(409, 'An intro is already being created for this run');
  creating.add(runId);
  try {
    return await createIntroInner(runId, opts);
  } finally {
    creating.delete(runId);
  }
}

async function createIntroInner(runId, { posterEmail, reqHost } = {}) {
  const run = getRun(runId);
  if (!run) throw httpError(404, 'Run not found');
  if (run.status !== 'complete') throw httpError(409, 'Run is not complete yet');
  if (!run.winnerId) throw httpError(409, 'This run has no winner to introduce');
  if (run.introId) {
    const existing = coll().get(run.introId);
    if (existing) throw httpError(409, 'An intro already exists for this run');
  }
  const winner = run.entries.find((e) => e.candidateId === run.winnerId);
  const cand = getCandidate(run.winnerId);
  if (!cand) throw httpError(404, 'Winning candidate no longer exists');
  const pEmail = String(posterEmail || run.poster.email || '').trim();
  if (pEmail && !EMAIL_RE.test(pEmail)) throw httpError(400, 'Invalid poster email');

  const intro = {
    id: crypto.randomBytes(6).toString('hex'),
    runId,
    status: 'pending',
    problem: { id: run.problem.id, title: run.problem.title },
    poster: { name: run.poster.name, email: pEmail },
    candidate: { id: cand.id, name: cand.name, email: cand.email || '', github: cand.github || '' },
    posterToken: token(),
    candidateToken: token(),
    posterDecision: null,
    candidateDecision: null,
    receipts: {
      score: winner.result.score,
      hidden: `${winner.result.hidden.passed}/${winner.result.hidden.total}`,
      visible: `${winner.result.visible.passed}/${winner.result.visible.total}`,
      linesChanged: winner.result.linesChanged,
      durationSec: Math.round((winner.durationMs || 0) / 1000),
      summary: winner.summary || '',
      mode: run.mode,
      diff: winner.result.diffs.map((d) => d.text).join('\n\n').slice(0, 20000),
    },
    createdAt: Date.now(),
  };
  await coll().set(intro.id, intro);
  await setIntro(runId, intro.id);
  const base = baseUrl(reqHost);
  return {
    intro: viewIntro(intro, 'poster'),
    posterLink: `${base}/consent.html?intro=${intro.id}&token=${intro.posterToken}`,
    candidateLink: `${base}/consent.html?intro=${intro.id}&token=${intro.candidateToken}`,
  };
}

function getForToken(id, tok) {
  const intro = coll().get(String(id));
  if (!intro) throw httpError(404, 'Intro not found');
  const role = roleFor(intro, tok);
  if (!role) throw httpError(403, 'Invalid or missing token');
  return { intro, role };
}

function composeEmail(intro) {
  const r = intro.receipts;
  const subject = `Intro: ${intro.poster.name} ↔ ${intro.candidate.name} (Tryout: ${intro.problem.title})`;
  const body = [
    `Hi ${intro.poster.name} and ${intro.candidate.name},`,
    '',
    `You both said yes, so here's the intro.`,
    '',
    `${intro.poster.name} posted a real problem: "${intro.problem.title}".`,
    `${intro.candidate.name}'s agent took the top spot in the tryout. Receipts:`,
    `  • Score: ${r.score}/100`,
    `  • Hidden tests passed: ${r.hidden}   Visible tests passed: ${r.visible}`,
    `  • Lines changed: ${r.linesChanged}   Time: ${r.durationSec}s${r.mode === 'rehearsal' ? '   (rehearsal run)' : ''}`,
    r.summary ? `  • Agent's summary: ${r.summary}` : '',
    '',
    `${intro.poster.name}: ${intro.poster.email || '(no email on file)'}`,
    `${intro.candidate.name}: ${intro.candidate.email || '(no email on file)'}${intro.candidate.github ? `  ·  github.com/${intro.candidate.github}` : ''}`,
    '',
    `Take it from here — the agents did the audition, the next conversation is yours.`,
    '',
    '— Tryout',
  ]
    .filter((l) => l !== null)
    .join('\n');
  const to = [intro.poster.email, intro.candidate.email].filter(Boolean);
  const mailto = `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { to, subject, body, mailto };
}

async function deliver(intro) {
  if (!config.resendKey || intro.email.to.length === 0) return { method: 'manual', sent: false, note: config.resendKey ? 'No email addresses on file' : 'Set RESEND_API_KEY to send automatically; use the mailto/.eml instead' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.introFrom, to: intro.email.to, subject: intro.email.subject, text: intro.email.body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { method: 'resend', sent: false, note: `Resend error ${res.status}` };
    return { method: 'resend', sent: true };
  } catch (e) {
    return { method: 'resend', sent: false, note: e.message };
  }
}

async function respond(id, tok, decision) {
  if (!['accept', 'decline'].includes(decision)) throw httpError(400, 'decision must be accept or decline');
  const { intro, role } = getForToken(id, tok);
  if (intro.status !== 'pending') throw httpError(409, `Intro already ${intro.status}`);
  if (intro[`${role}Decision`]) throw httpError(409, 'You already answered');
  intro[`${role}Decision`] = decision;
  if (decision === 'decline') {
    intro.status = 'declined';
  } else if (intro.posterDecision === 'accept' && intro.candidateDecision === 'accept') {
    intro.status = 'accepted';
    intro.email = composeEmail(intro);
    intro.acceptedAt = Date.now();
    intro.delivery = await deliver(intro);
  }
  await coll().set(intro.id, intro);
  return viewIntro(intro, role);
}

function emlFor(id, tok) {
  const { intro } = getForToken(id, tok);
  if (intro.status !== 'accepted') throw httpError(409, 'Intro has not been accepted by both people');
  const e = intro.email;
  const fold = (s) => s.replace(/[\r\n]+/g, ' ');
  return [
    `From: ${fold(config.introFrom)}`,
    `To: ${e.to.map(fold).join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(fold(e.subject)).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    e.body,
  ].join('\r\n');
}

/** Admin/stage view (poster side) for a run's intro — used by the main UI. */
function introForRun(runId) {
  const run = getRun(runId);
  if (!run || !run.introId) return null;
  const intro = coll().get(run.introId);
  return intro ? viewIntro(intro, 'stage') : null;
}

module.exports = { createIntro, respond, getForToken, viewIntro, emlFor, introForRun, composeEmail, _reset: () => (intros = null) };
