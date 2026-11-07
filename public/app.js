'use strict';
/* Tryout stage UI. */
(function () {
  const { h, api, store, avatar, renderDiff, fmtClock } = window.UI;
  const $ = (id) => document.getElementById(id);
  // replaceChildren() would render null/false as text; always filter.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

  const state = {
    health: null,
    problems: [],
    candidates: [],
    problemId: null,
    selected: new Set(),
    run: null,
    lanes: new Map(), // candidateId -> { el, feed, fill, label, status, scorebox }
    es: null,
    clockTimer: null,
    introPoll: null,
    intro: null, // { posterLink, candidateLink, intro }
  };

  // ---------- boot ----------
  async function boot() {
    $('poster-name').value = store.get('tryout.posterName') || '';
    $('poster-email').value = store.get('tryout.posterEmail') || '';
    $('poster-name').addEventListener('input', (e) => store.set('tryout.posterName', e.target.value));
    $('poster-email').addEventListener('input', (e) => store.set('tryout.posterEmail', e.target.value));
    $('btn-start').addEventListener('click', start);
    $('btn-cancel').addEventListener('click', cancel);
    $('btn-new').addEventListener('click', () => {
      history.pushState(null, '', '/');
      showSetup();
    });
    $('gh-form').addEventListener('submit', addGitHub);
    $('btn-custom').addEventListener('click', () => $('dlg-custom').showModal());
    $('custom-form').addEventListener('submit', submitCustom);
    $('receipts-close').addEventListener('click', () => $('dlg-receipts').close());
    window.addEventListener('popstate', route);
    prefillCustomForm();

    try {
      state.health = await api('/api/health');
    } catch (e) {
      $('start-msg').textContent = `Server unreachable: ${e.message}`;
      $('start-msg').className = 'form-msg center err';
      return;
    }
    renderBadges();
    setupMode();
    await Promise.all([loadProblems(), loadCandidates(), loadRecent()]);
    route();
  }

  function route() {
    const m = /[?&]run=([a-f0-9]{6,32})/.exec(location.search);
    if (m) openRun(m[1]);
    else showSetup();
  }

  function renderBadges() {
    const hl = state.health;
    const b = $('badges');
    fill(b, 
      hl.liveAvailable ? h('span', { class: 'badge live', text: `Live · ${hl.model}` }) : h('span', { class: 'badge rehearsal', text: 'Rehearsal (no API key)' }),
      h('span', { class: `badge ${hl.sandbox.strong ? 'secure' : 'weak'}`, text: `Sandbox: ${hl.sandbox.driver} · network off`, title: Object.values(hl.sandbox).join(' · ') }),
    );
    if (!hl.sandbox.network.startsWith('blocked')) b.lastChild.textContent = `Sandbox: ${hl.sandbox.driver} · ⚠ network NOT isolated`;
    if (hl.selfTest && hl.selfTest.state === 'failed') {
      b.append(h('span', { class: 'badge weak', text: '✖ Sandbox self-test failed', title: hl.selfTest.error || '' }));
      const msg = $('start-msg');
      msg.className = 'form-msg center err';
      msg.textContent = `Sandbox self-test failed: ${hl.selfTest.error || 'unknown error'}. Attempts can't be scored until this is fixed.`;
    } else if (hl.selfTest && hl.selfTest.state === 'pending') {
      // Re-check shortly; the self-test runs right after startup.
      setTimeout(async () => {
        try {
          state.health = await api('/api/health');
          renderBadges();
        } catch {}
      }, 2500);
    }
  }

  function setupMode() {
    const radios = document.querySelectorAll('input[name="mode"]');
    const live = [...radios].find((r) => r.value === 'live');
    const reh = [...radios].find((r) => r.value === 'rehearsal');
    if (!state.health.liveAvailable) {
      live.disabled = true;
      live.parentElement.title = 'Set ANTHROPIC_API_KEY on the server to enable live agents';
      reh.checked = true;
    } else {
      const saved = store.get('tryout.mode');
      (saved === 'rehearsal' ? reh : live).checked = true;
    }
    radios.forEach((r) => r.addEventListener('change', () => store.set('tryout.mode', r.value)));
  }

  // ---------- setup: problems ----------
  async function loadProblems() {
    state.problems = await api('/api/problems');
    if (!state.problemId || !state.problems.some((p) => p.id === state.problemId)) state.problemId = state.problems[0] ? state.problems[0].id : null;
    renderProblems();
  }

  function renderProblems() {
    const list = $('problem-list');
    fill(list, 
      ...state.problems.map((p) =>
        h(
          'button',
          {
            class: `card${p.id === state.problemId ? ' selected' : ''}`,
            role: 'radio',
            'aria-checked': String(p.id === state.problemId),
            onclick: () => {
              state.problemId = p.id;
              renderProblems();
              updateStart();
            },
          },
          h('div', { class: 'check' }),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'title', text: p.title }),
            h('div', { class: 'desc', text: p.summary }),
            h(
              'div',
              { class: 'meta' },
              h('span', { class: 'chip cyan', text: `${p.visibleTestCount ?? '?'} visible tests` }),
              h('span', { class: 'chip accent', text: `${p.hiddenTestCount} hidden tests` }),
              ...(p.tags || []).map((t) => h('span', { class: 'chip', text: t })),
            ),
          ),
          p.source === 'custom'
            ? h('span', {
                class: 'x',
                role: 'button',
                title: 'Delete problem',
                'aria-label': `Delete ${p.title}`,
                text: '×',
                onclick: async (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete "${p.title}"?`)) return;
                  await api(`/api/problems/${p.id}`, { method: 'DELETE' });
                  await loadProblems();
                },
              })
            : null,
        ),
      ),
    );
    updateStart();
  }

  function prefillCustomForm() {
    const f = $('custom-form');
    f.source.value = `'use strict';\n// Returns the total in cents for a list of { price, qty } line items.\nfunction total(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\nmodule.exports = { total };\n`;
    f.visibleTest.value = `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/index.js');\n\ntest('sums cents without float drift', () => {\n  assert.equal(total([{ price: 0.1, qty: 3 }]), 30);\n});\n`;
    f.hiddenTest.value = `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/index.js');\n\ntest('empty list is 0', () => assert.equal(total([]), 0));\ntest('rounds half cents', () => assert.equal(total([{ price: 1.005, qty: 1 }]), 101));\n`;
  }

  async function submitCustom(e) {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const f = e.target;
    const msg = $('custom-msg');
    msg.className = 'form-msg';
    msg.textContent = 'Running your tests in the sandbox…';
    $('custom-submit').disabled = true;
    try {
      const body = Object.fromEntries(new FormData(f).entries());
      const p = await api('/api/problems', { method: 'POST', body });
      state.problemId = p.id;
      await loadProblems();
      $('dlg-custom').close();
      msg.textContent = '';
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    } finally {
      $('custom-submit').disabled = false;
    }
  }

  // ---------- setup: candidates ----------
  async function loadCandidates() {
    state.candidates = await api('/api/candidates');
    const ids = new Set(state.candidates.map((c) => c.id));
    for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
    if (state.selected.size === 0) state.candidates.slice(0, 3).forEach((c) => state.selected.add(c.id));
    renderCandidates();
  }

  function renderCandidates() {
    const max = state.health.limits.maxCandidates;
    $('cand-count').textContent = `${state.selected.size} of max ${max} selected`;
    fill($('candidate-list'), 
      ...state.candidates.map((c, i) =>
        h(
          'button',
          {
            class: `card${state.selected.has(c.id) ? ' selected' : ''}`,
            role: 'checkbox',
            'aria-checked': String(state.selected.has(c.id)),
            onclick: () => {
              if (state.selected.has(c.id)) state.selected.delete(c.id);
              else if (state.selected.size < max) state.selected.add(c.id);
              renderCandidates();
            },
          },
          h('div', { class: 'check' }),
          avatar(c, i),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'title', text: c.name }),
            h('div', { class: 'desc', text: c.headline || c.summary || '' }),
            h(
              'div',
              { class: 'meta' },
              c.github ? h('span', { class: 'chip cyan', text: `@${c.github}` }) : null,
              ...(c.skills || []).slice(0, 4).map((s) => h('span', { class: 'chip', text: s })),
              !c.hasEmail ? h('span', { class: 'chip', text: 'no email' }) : null,
            ),
          ),
          h('span', {
            class: 'x',
            role: 'button',
            title: 'Remove candidate',
            'aria-label': `Remove ${c.name}`,
            text: '×',
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm(`Remove ${c.name}?`)) return;
              await api(`/api/candidates/${c.id}`, { method: 'DELETE' });
              state.selected.delete(c.id);
              await loadCandidates();
            },
          }),
        ),
      ),
    );
    updateStart();
  }

  async function addGitHub(e) {
    e.preventDefault();
    const user = $('gh-user').value.trim();
    if (!user) return;
    const msg = $('gh-msg');
    msg.className = 'form-msg';
    msg.textContent = `Reading what @${user.replace(/^@/, '')} has actually shipped…`;
    try {
      const c = await api('/api/candidates', { method: 'POST', body: { github: user, email: $('gh-email').value.trim() || undefined } });
      msg.className = 'form-msg ok';
      msg.textContent = `Added ${c.name}.`;
      $('gh-user').value = '';
      $('gh-email').value = '';
      if (state.selected.size < state.health.limits.maxCandidates) state.selected.add(c.id);
      await loadCandidates();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  }

  function updateStart() {
    $('btn-start').disabled = !state.problemId || state.selected.size === 0;
  }

  async function loadRecent() {
    try {
      const runs = await api('/api/runs');
      const list = $('recent-list');
      if (!runs.length) return fill(list, h('p', { class: 'muted small', text: 'No tryouts yet.' }));
      fill(list, 
        ...runs.slice(0, 12).map((r) =>
          h(
            'div',
            { class: 'recent-row' },
            h('span', { class: `pill ${r.status}`, text: r.status }),
            h('span', { class: 'grow', text: r.problem || r.id }),
            h('span', { class: 'muted small', text: `${r.mode} · ${new Date(r.createdAt).toLocaleString()}` }),
            h('a', { class: 'btn ghost', href: `/?run=${r.id}`, text: 'Open', onclick: (e) => { e.preventDefault(); history.pushState(null, '', `/?run=${r.id}`); openRun(r.id); } }),
          ),
        ),
      );
    } catch {}
  }

  // ---------- start / arena ----------
  async function start() {
    const msg = $('start-msg');
    msg.className = 'form-msg center';
    msg.textContent = '';
    $('btn-start').disabled = true;
    const mode = (document.querySelector('input[name="mode"]:checked') || {}).value || 'auto';
    try {
      const run = await api('/api/runs', {
        method: 'POST',
        body: {
          problemId: state.problemId,
          candidateIds: [...state.selected],
          mode,
          poster: { name: $('poster-name').value.trim() || undefined, email: $('poster-email').value.trim() || undefined },
        },
      });
      history.pushState(null, '', `/?run=${run.id}`);
      openRun(run.id, run);
    } catch (err) {
      msg.className = 'form-msg center err';
      msg.textContent = err.message;
      updateStart();
    }
  }

  function showSetup() {
    teardown();
    $('arena').classList.add('hidden');
    $('setup').classList.remove('hidden');
    updateStart();
    loadRecent();
  }

  function teardown() {
    if (state.es) state.es.close();
    state.es = null;
    clearInterval(state.clockTimer);
    clearInterval(state.introPoll);
    state.introPoll = null;
    state.intro = null;
    state.lanes.clear();
  }

  async function openRun(id, initial) {
    teardown();
    let run = initial;
    try {
      run = await api(`/api/runs/${id}`);
    } catch (err) {
      if (!run) {
        alert(`Could not open run: ${err.message}`);
        history.pushState(null, '', '/');
        return showSetup();
      }
    }
    state.run = run;
    $('setup').classList.add('hidden');
    $('arena').classList.remove('hidden');
    $('arena-eyebrow').textContent = `Tryout · posted by ${run.poster.name}`;
    $('arena-title').textContent = run.problem.title;
    $('arena-summary').textContent = run.problem.summary;
    $('rehearsal-banner').classList.toggle('hidden', run.mode !== 'rehearsal');
    $('results').classList.add('hidden');
    buildLanes(run);
    setStatus(run.status);
    startClock();
    connect(run.id);
  }

  function buildLanes(run) {
    const lanes = $('lanes');
    lanes.style.setProperty('--cols', String(Math.min(4, Math.max(1, run.entries.length))));
    fill(lanes);
    run.entries.forEach((e, i) => {
      const status = h('div', { class: 'lane-status' }, h('span', { class: 'dot' }), h('span', { text: 'queued' }));
      const fill = h('div', { class: 'testbar-fill' });
      const label = h('span', { text: '— / —' });
      const feed = h('ol', { class: 'feed', 'aria-live': 'polite' });
      const scorebox = h('div', { class: 'scorebox hidden' });
      const rankBadge = h('div', { class: 'rank-badge hidden' });
      const el = h(
        'article',
        { class: 'lane', 'aria-label': `${e.candidate.name}'s agent` },
        rankBadge,
        h('div', { class: 'lane-head' }, avatar(e.candidate, i), h('div', { class: 'grow' }, h('div', { class: 'name', text: e.candidate.name }), h('div', { class: 'headline', text: e.candidate.headline || '' }), status)),
        h('div', { class: 'testbar' }, h('div', { class: 'testbar-top' }, h('span', { text: 'Visible tests' }), label), h('div', { class: 'testbar-track' }, fill)),
        feed,
        scorebox,
      );
      lanes.append(el);
      state.lanes.set(e.candidateId, { el, feed, fill, label, status: status.lastChild, scorebox, rankBadge, entry: e, idx: i });
    });
  }

  function setStatus(s) {
    const pill = $('arena-status');
    pill.textContent = s;
    pill.className = `pill ${s}`;
    const done = !['running', 'scoring'].includes(s);
    $('btn-cancel').classList.toggle('hidden', done);
    $('btn-new').classList.toggle('hidden', !done);
  }

  function startClock() {
    const tick = () => {
      const r = state.run;
      if (!r) return;
      const end = r.endedAt || Date.now();
      $('arena-clock').textContent = fmtClock(end - r.createdAt);
    };
    tick();
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(tick, 250);
  }

  function connect(runId) {
    const es = new EventSource(`/api/runs/${runId}/events`);
    state.es = es;
    const types = ['run_started', 'agent_started', 'status', 'thought', 'tool', 'write', 'tests', 'blocked', 'tool_error', 'submit', 'scoring', 'scored', 'agent_error', 'agent_cancelled', 'run_complete', 'run_cancelled', 'run_error'];
    for (const t of types) es.addEventListener(t, (m) => onEvent(JSON.parse(m.data)));
    es.addEventListener('end', async () => {
      es.close();
      await refreshRun();
    });
    es.onerror = () => {
      // EventSource auto-reconnects with Last-Event-ID; if the run is finished, refresh once.
      if (es.readyState === EventSource.CLOSED) refreshRun();
    };
  }

  async function refreshRun() {
    if (!state.run) return;
    try {
      const run = await api(`/api/runs/${state.run.id}`);
      state.run = run;
      setStatus(run.status);
      for (const e of run.entries) {
        const lane = state.lanes.get(e.candidateId);
        if (!lane) continue;
        laneState(lane, e.status);
        if (e.lastTests) setTests(lane, e.lastTests.passed, e.lastTests.total);
        if (e.result) renderScore(lane, e);
      }
      if (run.status === 'complete') renderResults(run);
      if (run.status === 'error') {
        $('results').classList.remove('hidden');
        $('winner').className = 'winner none';
        fill($('winner'), h('div', {}, h('h2', { text: 'Run failed' }), h('p', { text: run.error || 'Unknown error' })));
      }
    } catch {}
  }

  const ICON = { thought: '…', tool: '›', write: '✎', tests: '▶', blocked: '⛔', tool_error: '!', submit: '✓', scoring: '◎', scored: '★', agent_error: '!', agent_cancelled: '■', status: '·', agent_started: '▸' };

  function addFeed(lane, kind, text, extra = '') {
    const li = h('li', { class: `${kind} ${extra}`.trim() }, h('span', { class: 'ic', text: ICON[kind] || '·' }), h('span', { class: 'tx', text }));
    lane.feed.append(li);
    while (lane.feed.children.length > 120) lane.feed.firstChild.remove();
    lane.feed.scrollTop = lane.feed.scrollHeight;
  }

  function laneState(lane, s) {
    lane.el.classList.toggle('active', s === 'running');
    lane.el.classList.toggle('is-scoring', s === 'scoring');
    lane.el.classList.toggle('is-done', s === 'done');
    lane.status.textContent = { running: 'working', scoring: 'hidden tests', done: 'scored', error: 'error', cancelled: 'stopped', queued: 'queued' }[s] || s;
  }

  function setTests(lane, passed, total) {
    const pct = total ? Math.round((passed / total) * 100) : 0;
    lane.fill.style.width = `${Math.max(pct, total ? 3 : 0)}%`;
    lane.fill.classList.toggle('full', total > 0 && passed === total);
    lane.fill.classList.toggle('part', passed > 0 && passed < total);
    lane.label.textContent = `${passed} / ${total}`;
  }

  function onEvent(ev) {
    const d = ev.data || {};
    if (ev.type === 'run_complete' || ev.type === 'run_cancelled' || ev.type === 'run_error') {
      setStatus(ev.type === 'run_complete' ? 'complete' : ev.type === 'run_cancelled' ? 'cancelled' : 'error');
      return;
    }
    const lane = ev.candidateId && state.lanes.get(ev.candidateId);
    if (!lane) return;
    switch (ev.type) {
      case 'agent_started':
        laneState(lane, 'running');
        break;
      case 'status':
        addFeed(lane, 'status', d.label);
        break;
      case 'thought':
        addFeed(lane, 'thought', d.text);
        break;
      case 'tool':
        addFeed(lane, 'tool', d.label);
        break;
      case 'write':
        addFeed(lane, 'write', d.label);
        break;
      case 'tests':
        setTests(lane, d.passed, d.total);
        addFeed(lane, 'tests', `${d.passed}/${d.total} visible tests passing${d.timedOut ? ' (timed out)' : ''}`, d.passed === d.total ? 'pass' : 'fail');
        for (const f of (d.failures || []).slice(0, 2)) addFeed(lane, 'tool', `  ✗ ${f.name}`);
        break;
      case 'blocked':
        addFeed(lane, 'blocked', `Tried to edit ${d.path}: blocked (tests are read-only)`);
        break;
      case 'tool_error':
        addFeed(lane, 'tool_error', d.label, 'err');
        break;
      case 'submit':
        addFeed(lane, 'submit', `Submitted: ${d.summary}`);
        break;
      case 'scoring':
        laneState(lane, 'scoring');
        addFeed(lane, 'scoring', 'Running hidden tests in a fresh sandbox…');
        break;
      case 'scored':
        laneState(lane, 'done');
        addFeed(lane, 'scored', `Score ${d.score} · hidden ${d.hidden.passed}/${d.hidden.total}`);
        renderScore(lane, { result: { score: d.score, hidden: d.hidden, visible: d.visible, flags: d.flags || [], linesChanged: d.linesChanged } });
        break;
      case 'agent_error':
        laneState(lane, 'error');
        addFeed(lane, 'agent_error', d.label, 'err');
        break;
      case 'agent_cancelled':
        laneState(lane, 'cancelled');
        addFeed(lane, 'agent_cancelled', 'Stopped');
        break;
    }
  }

  function renderScore(lane, entry) {
    const r = entry.result;
    const dq = r.disqualified || (r.flags || []).some((f) => f.kind === 'integrity_violation');
    lane.el.classList.toggle('dq', dq);
    lane.scorebox.classList.remove('hidden');
    fill(lane.scorebox, 
      h('div', { class: 'score-num' }, String(r.score), h('small', { text: '/100' })),
      h(
        'div',
        { class: 'score-detail' },
        h('span', {}, 'Hidden ', h('b', { text: `${r.hidden.passed}/${r.hidden.total}` }), '  ·  Visible ', h('b', { text: `${r.visible.passed}/${r.visible.total}` })),
        r.linesChanged !== undefined ? h('span', { text: `${r.linesChanged} lines changed` }) : null,
        (r.flags || []).length ? h('div', { class: 'flags' }, ...r.flags.map((f) => h('span', { class: `flag ${f.kind}`, title: f.message, text: f.kind.replace(/_/g, ' ') }))) : null,
      ),
      entry.candidateId ? h('button', { class: 'btn ghost', text: 'Receipts', onclick: () => showReceipts(entry) }) : null,
    );
    if (entry.rank) {
      lane.rankBadge.classList.remove('hidden');
      lane.rankBadge.textContent = `#${entry.rank}`;
    }
  }

  function showReceipts(e) {
    const r = e.result;
    $('receipts-title').textContent = `Receipts: ${e.candidate.name}'s agent`;
    const body = $('receipts-body');
    fill(body, 
      h(
        'div',
        { class: 'rcpt-grid' },
        stat('Score', `${r.score}`),
        stat('Hidden tests', `${r.hidden.passed}/${r.hidden.total}`),
        stat('Visible tests', `${r.visible.passed}/${r.visible.total}`),
        stat('Time', e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : '—'),
      ),
      e.summary ? h('p', {}, h('b', { text: 'Agent summary: ' }), e.summary) : null,
      (r.flags || []).length ? h('div', { class: 'flags' }, ...r.flags.map((f) => h('span', { class: `flag ${f.kind}`, text: f.message }))) : null,
      r.hidden.failures && r.hidden.failures.length
        ? h('div', {}, h('div', { class: 'muted small', text: 'Hidden tests that caught it:' }), h('ul', { class: 'fail-list' }, ...r.hidden.failures.map((f) => h('li', { text: f.name }))))
        : null,
      h('div', { class: 'muted small', text: `Diff (${r.linesChanged} lines changed)${e.usage && e.usage.output_tokens ? ` · ${e.turns} turns · ${e.usage.input_tokens + e.usage.output_tokens} tokens` : ''}` }),
      renderDiff((r.diffs || []).map((d) => d.text).join('\n')),
    );
    $('dlg-receipts').showModal();
  }

  function stat(k, v) {
    return h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  }

  function renderResults(run) {
    $('results').classList.remove('hidden');
    const ranked = run.entries.filter((e) => e.result).sort((a, b) => (a.rank || 99) - (b.rank || 99));
    for (const e of run.entries) {
      const lane = state.lanes.get(e.candidateId);
      if (lane) lane.el.classList.toggle('lane-win', e.candidateId === run.winnerId);
    }
    const w = run.entries.find((e) => e.candidateId === run.winnerId);
    const winner = $('winner');
    if (w) {
      winner.className = 'winner';
      fill(winner, 
        h('div', { class: 'trophy', 'aria-hidden': 'true', text: '🏆' }),
        h('div', {}, h('h2', { text: `${w.candidate.name}'s agent earned the intro` }), h('p', { text: `Scored ${w.result.score}/100, passing ${w.result.hidden.passed}/${w.result.hidden.total} hidden tests it never saw, in ${Math.round((w.durationMs || 0) / 1000)}s. Receipts, not résumés.` })),
      );
    } else {
      winner.className = 'winner none';
      fill(winner, h('div', {}, h('h2', { text: 'No qualifying attempt' }), h('p', { text: 'Nobody scored above zero, so no intro is offered.' })));
    }
    const top = ranked[0] ? ranked[0].result.score : 0;
    fill($('leaderboard'), 
      ...ranked.map((e) => {
        const bar = h('div');
        requestAnimationFrame(() => (bar.style.width = `${top ? Math.max(2, e.result.score) : 0}%`));
        return h(
          'li',
          { class: `lb-row${e.rank === 1 && e.candidateId === run.winnerId ? ' first' : ''}` },
          h('div', { class: 'lb-rank', text: `${e.rank}` }),
          h('div', {}, h('div', { class: 'lb-name', text: e.candidate.name }), h('div', { class: 'lb-sub', text: `hidden ${e.result.hidden.passed}/${e.result.hidden.total} · ${e.result.linesChanged} lines · ${Math.round((e.durationMs || 0) / 1000)}s${e.result.flags.length ? ` · ${e.result.flags.map((f) => f.kind.replace(/_/g, ' ')).join(', ')}` : ''}` })),
          h('div', { class: 'lb-bar' }, bar),
          h('div', { class: 'lb-score', text: String(e.result.score) }),
        );
      }),
    );
    renderConsent(run);
  }

  // ---------- consent ----------
  function renderConsent(run) {
    const box = $('consent');
    const w = run.entries.find((e) => e.candidateId === run.winnerId);
    if (!w) return fill(box, h('p', { class: 'muted', text: 'No intro to offer for this run.' }));
    const intro = (state.intro && state.intro.intro) || run.intro;
    if (!intro) {
      const email = h('input', { type: 'email', placeholder: 'your email (for the intro)', value: run.poster && store.get('tryout.posterEmail') ? store.get('tryout.posterEmail') : '' });
      const msg = h('div', { class: 'form-msg', role: 'status' });
      fill(box, 
        h('h3', { text: `Request an intro to ${w.candidate.name}` }),
        h('p', { class: 'privacy', text: `Both of you have to say yes. Nobody's contact details are shared until you both do.` }),
        h('label', {}, 'Your email', email),
        msg,
        h('button', {
          class: 'btn primary',
          text: 'Request intro →',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              state.intro = await api(`/api/runs/${run.id}/intro`, { method: 'POST', body: { posterEmail: email.value.trim() || undefined } });
              store.set(`tryout.intro.${run.id}`, JSON.stringify({ posterLink: state.intro.posterLink, candidateLink: state.intro.candidateLink }));
              renderConsent(run);
              pollIntro();
            } catch (err) {
              msg.className = 'form-msg err';
              msg.textContent = err.message;
              ev.target.disabled = false;
            }
          },
        }),
      );
      return;
    }
    // Restore links from this browser if we created the intro here.
    if (!state.intro) {
      try {
        const saved = JSON.parse(store.get(`tryout.intro.${run.id}`) || 'null');
        if (saved) state.intro = { ...saved, intro };
      } catch {}
    }
    const links = state.intro || {};
    const it = intro;
    const dec = (d) => h('div', { class: `decision ${d || 'pending'}`, text: d === 'accept' ? '✓ Accepted' : d === 'decline' ? '✗ Declined' : 'Waiting…' });
    const posterTok = links.posterLink ? new URL(links.posterLink).searchParams.get('token') : null;
    const respond = (decision) => async () => {
      try {
        const v = await api(`/api/intros/${it.id}/respond`, { method: 'POST', body: { token: posterTok, decision } });
        state.intro = { ...links, intro: v };
        renderConsent(run);
      } catch (err) {
        alert(err.message);
      }
    };
    const children = [
      h('h3', { text: it.status === 'accepted' ? 'Intro made 🤝' : it.status === 'declined' ? 'Intro declined' : 'Waiting on both yeses' }),
      h('p', { class: 'privacy', text: it.status === 'accepted' ? 'You both said yes. Contact details are shared below.' : 'Each person answers from their own private link. Contact details stay hidden until both accept.' }),
      h(
        'div',
        { class: 'parties' },
        h(
          'div',
          { class: 'party' },
          h('div', { class: 'who', text: 'Poster' }),
          h('div', { class: 'pname', text: it.poster.name }),
          dec(it.poster.decision),
          it.status === 'pending' && !it.poster.decision && posterTok
            ? h('div', { class: 'row' }, h('button', { class: 'btn good', text: 'Accept', onclick: respond('accept') }), h('button', { class: 'btn bad', text: 'Decline', onclick: respond('decline') }))
            : null,
        ),
        h(
          'div',
          { class: 'party' },
          h('div', { class: 'who', text: 'Candidate' }),
          h('div', { class: 'pname', text: it.candidate.name }),
          dec(it.candidate.decision),
          links.candidateLink && it.status === 'pending'
            ? h(
                'div',
                { class: 'row' },
                h('button', { class: 'btn', text: 'Copy their link', onclick: (e) => copy(links.candidateLink, e.target) }),
                h('a', { class: 'btn ghost', href: links.candidateLink, target: '_blank', rel: 'noopener', text: 'Open as candidate' }),
              )
            : null,
        ),
      ),
    ];
    if (it.status === 'accepted' && it.email) {
      children.push(
        h('div', { class: 'email-preview', text: `To: ${it.email.to.join(', ') || '(no emails on file)'}\nSubject: ${it.email.subject}\n\n${it.email.body}` }),
        h(
          'div',
          { class: 'row', style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
          h('a', { class: 'btn primary', href: it.email.mailto, text: 'Send intro email' }),
          posterTok ? h('a', { class: 'btn ghost', href: `/api/intros/${it.id}/eml?token=${encodeURIComponent(posterTok)}`, text: 'Download .eml' }) : null,
          it.delivery && it.delivery.sent ? h('span', { class: 'decision accept', text: '✓ Sent automatically' }) : null,
        ),
      );
    }
    fill(box, ...children);
    if (it.status === 'pending') pollIntro();
    else {
      clearInterval(state.introPoll);
      state.introPoll = null;
    }
  }

  async function checkIntro() {
    if (!state.intro || !state.intro.posterLink || !state.intro.intro) return;
    const tok = new URL(state.intro.posterLink).searchParams.get('token');
    try {
      const v = await api(`/api/intros/${state.intro.intro.id}?token=${encodeURIComponent(tok)}`);
      const prev = state.intro.intro;
      const changed = v.status !== prev.status || v.candidate.decision !== prev.candidate.decision || v.poster.decision !== prev.poster.decision;
      state.intro.intro = v;
      if (changed && state.run) renderConsent(state.run);
    } catch {}
  }

  function pollIntro() {
    if (state.introPoll || !state.intro || !state.intro.posterLink) return;
    state.introPoll = setInterval(checkIntro, 1500);
  }
  // Background tabs throttle timers; refresh the moment the stage tab is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkIntro();
  });
  window.addEventListener('focus', checkIntro);

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
    } catch {
      window.prompt('Copy this link:', text);
    }
  }

  async function cancel() {
    if (!state.run) return;
    try {
      await api(`/api/runs/${state.run.id}/cancel`, { method: 'POST', body: {} });
    } catch (err) {
      alert(err.message);
    }
  }

  boot();
})();
