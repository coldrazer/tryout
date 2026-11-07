'use strict';
// Candidates: the people whose agents try out. A profile is built from what someone has
// actually shipped (their public GitHub), not from a self-written bio.
const crypto = require('node:crypto');
const config = require('./config');
const { Collection } = require('./store');

const SEED = [
  {
    id: 'maya',
    name: 'Maya Okafor',
    email: 'maya.okafor@example.com',
    headline: 'Backend & infra engineer',
    summary: 'Builds high-traffic APIs and edge services; known for edge-case hunting and test discipline.',
    skills: ['Node.js', 'Go', 'HTTP semantics', 'distributed systems', 'testing'],
    evidence: [
      { title: 'edge-gateway', detail: 'request router handling 40k rps' },
      { title: 'pg-migrate-safe', detail: 'zero-downtime Postgres migration tool' },
    ],
    rehearsalStrategy: 'thorough',
    source: 'seed',
  },
  {
    id: 'leo',
    name: 'Leo Park',
    email: 'leo.park@example.com',
    headline: 'Full-stack product engineer',
    summary: 'Ships features fast across React and Node; prefers minimal patches.',
    skills: ['React', 'TypeScript', 'Node.js', 'product iteration'],
    evidence: [{ title: 'shiplog', detail: 'changelog SaaS, 2k users' }],
    rehearsalStrategy: 'quick',
    source: 'seed',
  },
  {
    id: 'sam',
    name: 'Sam Rivera',
    email: 'sam.rivera@example.com',
    headline: 'Growth engineer',
    summary: 'Scrappy builder focused on speed and getting to green.',
    skills: ['JavaScript', 'automation', 'A/B testing'],
    evidence: [{ title: 'growth-scripts', detail: 'marketing automation toolkit' }],
    rehearsalStrategy: 'shortcut',
    source: 'seed',
  },
];

let candidates = null;
function coll() {
  if (!candidates) {
    candidates = new Collection('candidates');
    if (candidates.all().length === 0) {
      for (const c of SEED) candidates.items.set(c.id, { ...c, createdAt: new Date().toISOString() });
      candidates.save();
    }
  }
  return candidates;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const GH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function publicCandidate(c) {
  if (!c) return null;
  const { email, ...rest } = c;
  return { ...rest, hasEmail: Boolean(email) };
}

async function gh(pathname) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'tryout-app' };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
  const res = await fetch(`${config.githubApi}${pathname}`, { headers, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) throw Object.assign(new Error('GitHub user not found'), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`GitHub API error ${res.status}`), { status: 502 });
  return res.json();
}

/** Heuristic profile from repos (no AI needed). */
function heuristicProfile(user, repos) {
  const own = repos.filter((r) => !r.fork);
  const langs = {};
  for (const r of own) if (r.language) langs[r.language] = (langs[r.language] || 0) + 1 + (r.stargazers_count || 0) * 0.2;
  const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 5);
  const topics = [...new Set(own.flatMap((r) => r.topics || []))].slice(0, 5);
  const top = [...own]
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0) || new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 5);
  return {
    headline: user.bio ? String(user.bio).slice(0, 120) : `${topLangs[0] || 'Software'} developer`,
    summary: `${own.length} public repos${topLangs.length ? `, mostly ${topLangs.slice(0, 3).join(', ')}` : ''}.${top[0] ? ` Most notable: ${top[0].name}.` : ''}`,
    skills: [...topLangs, ...topics].slice(0, 8),
    evidence: top.map((r) => ({ title: r.name, detail: (r.description || '').slice(0, 140), url: r.html_url, stars: r.stargazers_count || 0 })),
  };
}

/** Optional AI summary of what someone has actually shipped. */
async function aiProfile(user, repos, base) {
  if (!config.anthropicKey) return base;
  try {
    const { callClaude } = require('./agents/claude');
    const repoLines = repos
      .filter((r) => !r.fork)
      .slice(0, 25)
      .map((r) => `- ${r.name} [${r.language || '?'}] ★${r.stargazers_count || 0}: ${(r.description || '').slice(0, 160)}`)
      .join('\n');
    const resp = await callClaude(
      {
        model: config.model,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: `From this developer's public GitHub, write a factual profile of what they have actually built. Do not invent anything not supported by the repos.\nUser: ${user.login} (${user.name || ''}) bio: ${user.bio || ''}\nRepos:\n${repoLines}\n\nReply with ONLY JSON: {"headline": "<=10 words", "summary": "<=2 sentences", "skills": ["up to 8 concrete skills"]}`,
          },
        ],
      },
      { signal: AbortSignal.timeout(20000) },
    );
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return {
      ...base,
      headline: String(json.headline || base.headline).slice(0, 120),
      summary: String(json.summary || base.summary).slice(0, 400),
      skills: Array.isArray(json.skills) ? json.skills.map(String).slice(0, 8) : base.skills,
    };
  } catch {
    return base;
  }
}

async function addFromGitHub({ github, email, name }) {
  const login = String(github || '').trim().replace(/^@/, '');
  if (!GH_RE.test(login)) throw Object.assign(new Error('Invalid GitHub username'), { status: 400 });
  const user = await gh(`/users/${encodeURIComponent(login)}`);
  const repos = await gh(`/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=50`);
  const base = heuristicProfile(user, Array.isArray(repos) ? repos : []);
  const prof = await aiProfile(user, Array.isArray(repos) ? repos : [], base);
  const finalEmail = (email && String(email).trim()) || user.email || '';
  if (finalEmail && !EMAIL_RE.test(finalEmail)) throw Object.assign(new Error('Invalid email'), { status: 400 });
  const id = `gh-${login.toLowerCase()}`;
  const c = {
    id,
    name: (name && String(name).trim().slice(0, 80)) || user.name || user.login,
    email: finalEmail,
    github: user.login,
    avatarUrl: user.avatar_url || '',
    ...prof,
    source: 'github',
    createdAt: new Date().toISOString(),
  };
  await coll().set(id, c);
  return c;
}

async function addManual(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) throw Object.assign(new Error('name is required (max 80 chars)'), { status: 400 });
  const email = String(body.email || '').trim();
  if (email && !EMAIL_RE.test(email)) throw Object.assign(new Error('Invalid email'), { status: 400 });
  const skills = (Array.isArray(body.skills) ? body.skills : String(body.skills || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 10);
  const strategy = ['thorough', 'quick', 'shortcut'].includes(body.rehearsalStrategy) ? body.rehearsalStrategy : 'thorough';
  const id = `m-${crypto.randomBytes(3).toString('hex')}`;
  const c = {
    id,
    name,
    email,
    headline: String(body.headline || '').slice(0, 120),
    summary: String(body.summary || '').slice(0, 400),
    skills,
    evidence: [],
    rehearsalStrategy: strategy,
    model: typeof body.model === 'string' && /^[a-z0-9.\-]{3,64}$/.test(body.model) ? body.model : undefined,
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  await coll().set(id, c);
  return c;
}

module.exports = {
  listCandidates: () => coll().all(),
  getCandidate: (id) => coll().get(id),
  deleteCandidate: (id) => coll().delete(id),
  addFromGitHub,
  addManual,
  publicCandidate,
  heuristicProfile,
  EMAIL_RE,
  _reset: () => (candidates = null),
};
