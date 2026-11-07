'use strict';
// Problem library: seeded problems in /problems plus custom problems posted at runtime
// (stored in data/problems). Layout per problem:
//   problem.json              metadata (title, summary, brief, test lists, expected totals)
//   repo/**                   files the agent sees (source + visible tests)
//   hidden/**                 hidden tests, mounted as test-hidden/** at scoring time only
//   rehearsal/solution/**     reference fix (used by rehearsal agents + verification)
//   rehearsal/partial/**      plausible-but-incomplete fix (rehearsal "partial" persona)
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { normalizeRel } = require('./sandbox/common');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

function readTree(dir, prefix = '') {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readTree(abs, rel));
    else if (e.isFile()) out[rel] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}

function customDir() {
  return path.join(config.dataDir, 'problems');
}

function loadOne(dir, source) {
  const metaPath = path.join(dir, 'problem.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const hiddenRaw = readTree(path.join(dir, 'hidden'));
  const hidden = {};
  for (const [k, v] of Object.entries(hiddenRaw)) hidden[`test-hidden/${k}`] = v;
  return {
    ...meta,
    source,
    repo: readTree(path.join(dir, 'repo')),
    hidden,
    rehearsal: {
      solution: readTree(path.join(dir, 'rehearsal', 'solution')),
      partial: readTree(path.join(dir, 'rehearsal', 'partial')),
    },
  };
}

function listProblems() {
  const out = [];
  for (const [base, source] of [[config.problemsDir, 'seed'], [customDir(), 'custom']]) {
    if (!fs.existsSync(base)) continue;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const p = loadOne(path.join(base, e.name), source);
        if (p) out.push(p);
      } catch (err) {
        console.warn(`[problems] skipping ${e.name}: ${err.message}`);
      }
    }
  }
  return out;
}

function getProblem(id) {
  if (!ID_RE.test(String(id))) return null;
  for (const [base, source] of [[config.problemsDir, 'seed'], [customDir(), 'custom']]) {
    const dir = path.join(base, id);
    if (fs.existsSync(path.join(dir, 'problem.json'))) return loadOne(dir, source);
  }
  return null;
}

/** Paths the agent must never modify. */
function protectedPathsFor(problem) {
  return [...new Set([...(problem.visibleTests || []), 'test/', 'test-hidden/', 'package.json'])];
}

/** Public view (no hidden tests, no reference solutions). */
function publicProblem(p) {
  return {
    id: p.id,
    title: p.title,
    summary: p.summary,
    brief: p.brief,
    tags: p.tags || [],
    source: p.source,
    sourceFiles: p.sourceFiles,
    visibleTests: p.visibleTests,
    hiddenTestCount: p.expected ? p.expected.hidden : Object.keys(p.hidden).length,
    visibleTestCount: p.expected ? p.expected.visible : undefined,
    files: Object.keys(p.repo),
    hasRehearsal: Object.keys(p.rehearsal.solution).length > 0,
  };
}

function str(v, max, name) {
  if (typeof v !== 'string' || !v.trim()) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  if (v.length > max) throw Object.assign(new Error(`${name} is too long (max ${max})`), { status: 400 });
  return v;
}

/**
 * Create a custom problem from the UI/API.
 * body: { title, summary, brief?, sourcePath?, source, visibleTest, hiddenTest?, solution? }
 */
async function createCustomProblem(body, { computeExpected } = {}) {
  const title = str(body.title, 120, 'title').trim();
  const summary = str(body.summary, 1000, 'summary').trim();
  const brief = (typeof body.brief === 'string' && body.brief.trim() ? body.brief : summary).slice(0, 4000);
  const sourcePath = normalizeRel(body.sourcePath || 'src/index.js');
  if (!sourcePath.endsWith('.js') || sourcePath.startsWith('test')) throw Object.assign(new Error('sourcePath must be a .js file outside test/'), { status: 400 });
  const source = str(body.source, 100000, 'source');
  const visibleTest = str(body.visibleTest, 100000, 'visibleTest');
  const hiddenTest = typeof body.hiddenTest === 'string' && body.hiddenTest.trim() ? body.hiddenTest : '';
  const base = sourcePath.split('/').pop().replace(/\.js$/, '');
  const requireHint = `../${sourcePath}`;
  for (const [n, t] of [['visibleTest', visibleTest], ['hiddenTest', hiddenTest]]) {
    if (t && !t.includes('node:test')) throw Object.assign(new Error(`${n} must use node:test (require('node:test'))`), { status: 400 });
  }

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'problem';
  const id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(customDir(), id);
  const meta = {
    id,
    title,
    summary,
    brief: `${brief}\n\nThe code under test is ${sourcePath} (tests import it via ${requireHint}).`,
    tags: ['custom'],
    sourceFiles: [sourcePath],
    visibleTests: [`test/${base}.test.js`],
    hiddenTests: hiddenTest ? [`test-hidden/${base}.hidden.test.js`] : [],
    createdAt: new Date().toISOString(),
  };
  await fsp.mkdir(path.join(dir, 'repo', path.dirname(sourcePath)), { recursive: true });
  await fsp.mkdir(path.join(dir, 'repo', 'test'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'repo', sourcePath), source);
  await fsp.writeFile(path.join(dir, 'repo', 'test', `${base}.test.js`), visibleTest);
  if (hiddenTest) {
    await fsp.mkdir(path.join(dir, 'hidden'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'hidden', `${base}.hidden.test.js`), hiddenTest);
  }
  if (typeof body.solution === 'string' && body.solution.trim()) {
    const solDir = path.join(dir, 'rehearsal', 'solution', path.dirname(sourcePath));
    await fsp.mkdir(solDir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'rehearsal', 'solution', sourcePath), body.solution);
  }
  await fsp.writeFile(path.join(dir, 'problem.json'), JSON.stringify(meta, null, 2));
  let problem = getProblem(id);
  if (computeExpected) {
    try {
      meta.expected = await computeExpected(problem);
      await fsp.writeFile(path.join(dir, 'problem.json'), JSON.stringify(meta, null, 2));
      problem = getProblem(id);
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw Object.assign(new Error(`Tests could not be run: ${e.message}`), { status: 400 });
    }
  }
  return problem;
}

async function deleteCustomProblem(id) {
  if (!ID_RE.test(String(id))) return false;
  const dir = path.join(customDir(), id);
  if (!fs.existsSync(dir)) return false;
  await fsp.rm(dir, { recursive: true, force: true });
  return true;
}

module.exports = { listProblems, getProblem, publicProblem, protectedPathsFor, createCustomProblem, deleteCustomProblem, readTree };
