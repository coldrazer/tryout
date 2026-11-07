'use strict';
/* Private consent page: one link per person. Answers only for the token holder's side. */
(function () {
  const { h, api, renderDiff } = window.UI;
  const root = document.getElementById('root');
  const q = new URLSearchParams(location.search);
  const id = q.get('intro');
  const token = q.get('token');
  let poll = null;

  async function load() {
    if (!id || !token) return fail('This link is incomplete.');
    try {
      render(await api(`/api/intros/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`));
    } catch (e) {
      fail(e.message);
    }
  }

  function fail(msg) {
    root.replaceChildren(h('h1', { text: 'Link not valid' }), h('p', { class: 'muted', text: msg }));
  }

  function stat(k, v) {
    return h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  }

  function render(it) {
    const me = it.role === 'poster' ? it.poster : it.candidate;
    const other = it.role === 'poster' ? it.candidate : it.poster;
    const r = it.receipts;
    const kids = [];
    if (it.role === 'candidate') {
      kids.push(
        h('div', { class: 'eyebrow', text: 'Intro request' }),
        h('h1', { text: `${it.poster.name} wants to meet you` }),
        h('p', { class: 'muted', text: `Your Tryout agent took the top spot on "${it.problem.title}". Here's what it did on your behalf.` }),
      );
    } else {
      kids.push(h('div', { class: 'eyebrow', text: 'Your intro request' }), h('h1', { text: `Meet ${it.candidate.name}?` }), h('p', { class: 'muted', text: `Their agent topped your tryout for "${it.problem.title}".` }));
    }
    kids.push(
      h('div', { class: 'rcpt-grid' }, stat('Score', String(r.score)), stat('Hidden', r.hidden), stat('Visible', r.visible), stat('Time', `${r.durationSec}s`)),
      r.summary ? h('p', {}, h('b', { text: 'Agent summary: ' }), r.summary) : null,
      r.mode === 'rehearsal' ? h('p', { class: 'muted small', text: 'This was a rehearsal run (scripted agents, real sandbox).' }) : null,
      h('details', {}, h('summary', { class: 'muted', text: 'See the code it wrote' }), renderDiff(r.diff)),
    );
    if (it.status === 'pending' && !me.decision) {
      kids.push(
        h('p', { class: 'privacy', text: `Your contact details are shared with ${other.name} only if you both say yes.` }),
        h('div', { class: 'actions' }, h('button', { class: 'btn good', text: 'Yes, introduce us', onclick: () => respond('accept') }), h('button', { class: 'btn bad', text: 'No thanks', onclick: () => respond('decline') })),
      );
    } else if (it.status === 'pending') {
      kids.push(h('div', { class: 'panel' }, h('b', { text: 'You said yes. ' }), `Waiting on ${other.name}…`));
      startPoll();
    } else if (it.status === 'declined') {
      kids.push(h('div', { class: 'panel' }, h('b', { text: 'No intro. ' }), 'Nothing was shared. Thanks for answering.'));
    } else if (it.status === 'accepted') {
      kids.push(
        h('div', { class: 'panel' }, h('h3', { text: "You're connected 🤝" }), h('p', {}, `${other.name}: `, other.email ? h('a', { href: `mailto:${other.email}`, text: other.email }) : 'no email on file')),
      );
      if (it.email) kids.push(h('a', { class: 'btn primary', href: it.email.mailto, text: 'Open intro email' }));
    }
    root.replaceChildren(...kids.filter(Boolean));
    if (it.status !== 'pending' && poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  async function respond(decision) {
    try {
      render(await api(`/api/intros/${encodeURIComponent(id)}/respond`, { method: 'POST', body: { token, decision } }));
    } catch (e) {
      alert(e.message);
    }
  }

  function startPoll() {
    if (poll) return;
    poll = setInterval(load, 2000);
  }

  load();
})();
