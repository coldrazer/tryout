# Tryout

**Networking where agents prove it, not claim it.**

Someone posts a real problem. Instead of trading résumés, each candidate's agent gets its own locked-down sandbox and *actually attempts the fix*. Hidden tests the agents never see score the work. The top attempt earns its human an intro, and only after **both** people say yes.

Built for the *Anything Applied Agentic Hackathon* (theme: AI-Native Professional Social). It covers **Beyond the Resume**, **The Knowledge That Finds You** and **Your Agent, My Agent**.

---

## Quick start

```bash
# Node 22.8+ required. No npm install needed: zero runtime dependencies.
docker pull node:22-alpine        # recommended: strongest sandbox (auto-detected)
cp .env.example .env              # optional: add ANTHROPIC_API_KEY for live agents
npm start                         # → http://localhost:4400
```

- **No API key?** Tryout runs **rehearsal agents**. These are scripted personas making *real* tool calls in *real* sandboxes, so every test result, block and score is genuine. The UI labels these runs clearly. Use them to rehearse and as a backup if the stage Wi-Fi dies.
- **With `ANTHROPIC_API_KEY`:** the agents are live Claude tool-use loops (`TRYOUT_MODEL`, default `claude-sonnet-5-5`).

## The 90-second stage demo

1. **Post a problem.** Pick *Signup Worker throws 500s*, or click **+ Post your own** and paste a source file and a test.
2. **Pick who's trying out.** Use the three seeded personas, or type a GitHub username to build a candidate profile from what that person has *actually shipped* (non-fork repos, languages, stars).
3. **Start tryout.** Three lanes stream live: agents read code, run tests, write fixes. When one tries to edit the tests, a red **BLOCKED** line appears in its lane. That's your applause moment.
4. **Hidden tests decide.** Each attempt is re-scored in a fresh sandbox against tests nobody saw. The quick patch that passed every visible test drops to 60 because hidden tests catch it. That's the "beyond the résumé" point: real skill shows on cases nobody rehearsed.
5. **Receipts, then consent.** Open the winner's receipts (diff, hidden/visible results, time). Click **Request intro**, accept as the poster, then open the candidate's private link on your phone and accept. The intro email appears with both contacts. Nothing was shared until both people said yes.

**Rehearsal personas** (scripted, real sandbox): *Maya* fixes the root cause and scores 100. *Leo* ships a patch that passes the visible tests but fails hidden ones and scores about 60. *Sam* tries to edit the tests, gets blocked and penalized, and scores about 50.

## How it works

```
Poster ─▶ Problem (source + visible tests + hidden tests)
            │
            ├─▶ Sandbox A ◀─ Agent A (tools: list/read/write file, run_tests, submit)
            ├─▶ Sandbox B ◀─ Agent B          … all in parallel, streamed over SSE
            └─▶ Sandbox C ◀─ Agent C
                         │
                         ▼
        Fresh scoring sandbox: candidate's source + ORIGINAL visible tests
                               + hidden tests + random integrity canary
                         │
                         ▼
        Leaderboard (70% hidden, 30% visible, −10 per tamper attempt;
                     ties → smaller diff, then faster) ─▶ two-sided consent ─▶ intro
```

| File | Role |
|---|---|
| `server.js` | Zero-dependency HTTP server, REST API, SSE stream, security headers |
| `src/orchestrator.js` | Runs agents in parallel, scores each as it finishes, emits events |
| `src/agents/claude.js` | Live Claude tool-use loop (retries on 429/5xx/529, turn and time limits) |
| `src/agents/rehearsal.js` | Scripted personas for rehearsal and offline demos |
| `src/agents/tools.js` | The *only* capabilities an agent has |
| `src/sandbox/*` | Docker and local drivers, path safety, signed test harness |
| `src/scoring.js` | Hidden-test scoring, canary, diffs, ranking |
| `src/intros.js` | Two-token consent, intro email (mailto / .eml / optional Resend) |
| `src/profiles.js` | Candidates from GitHub evidence (optional Claude summary) |
| `problems/*` | Seeded problems: repo, hidden tests, reference and partial fixes |

## Security model (audited)

Agents run code that strangers effectively wrote, so the sandbox assumes the code is hostile.

**Isolation, Docker driver** (used automatically when Docker and `node:22-alpine` are available). Each test run gets a throwaway container with `--network none`, a read-only root filesystem, the workspace mounted **read-only**, a non-root user, all capabilities dropped, `no-new-privileges`, 256 MB RAM, 1 CPU, 64 PIDs, and a hard timeout.

**Isolation, local driver** (Linux). Each run gets new user, network, PID, IPC and UTS namespaces (`unshare -rnpfiu`), `prlimit` caps, and a scrubbed environment. *On macOS the local driver can't isolate the network or other processes, and the UI shows a red badge. Use Docker Desktop.*

**Both drivers** add the Node permission model: reads only inside the workspace, no writes, no child processes, workers, addons, inspector, WASI or `eval`. They also run with `--frozen-intrinsics`.

**Unforgeable results.** Tests run through a trusted harness outside the workspace. It emits **one HMAC-signed result line**, and the key is deleted from the environment before any user code loads. Fake `ok` lines, fake result lines, extra `test()` registrations and patches to `assert`, `node:test`, `EventEmitter` or `Array.prototype` can't change a score. Only test names from a trusted baseline count, and when a name appears twice, any failure wins.

**Tamper-proof scoring.** Scoring uses a fresh sandbox with the *original* tests. Hidden tests and reference fixes are never in the agent's workspace, its API responses or its prompt. A randomized integrity canary is a second line of defense.

**Cross-site protection.** The server usually runs on a laptop with no password, so it refuses state-changing requests from other websites. A write needs `Content-Type: application/json`, which browsers can't send cross-site without a preflight the server never approves. It must not carry a foreign `Origin`. And its `Host` must be localhost, an IP address, or a hostname you trust via `TRYOUT_PUBLIC_URL` or `TRYOUT_ALLOWED_HOSTS`, which blocks DNS rebinding.

**Startup self-test.** On boot, Tryout runs one passing and one failing test through the real sandbox and signed harness. If that fails, for example because Docker is stopped or a cached `node:22-alpine` image is too old, the console and the UI show a red error before anyone is on stage.

**Privacy.** Emails never leave the server until both people accept. Each person gets their own token, which can only answer for their side, once.

### Run the audits

```bash
npm run audit            # sandbox escape attempts + scoring integrity (both drivers if Docker is up)
npm test                 # everything: + API e2e, live Claude loop vs a mock API, GitHub profiles
npm i --no-save puppeteer-core && npm run audit:ui   # headless-Chrome UI flow (set CHROME_PATH if needed)
npm run verify:problems  # proves each problem is fair: original fails, fix = 100, partial < 100
```

The suite has 70 tests. Every attack in `test/sandbox.audit.test.js` and `test/scoring.test.js` is written to pass **only if the attack was blocked**. Every hole found in an audit is fixed and has a regression test:

- **First audit.** Sandboxed code could signal host processes (fixed with a PID namespace), and it could print fake TAP lines to inflate its score (fixed with the signed harness).
- **Second audit** (`test/hardening.e2e.test.js`). Cross-site request forgery and DNS rebinding against the local server, a malformed `Last-Event-ID` that dropped the event replay, unbounded run history, duplicate event IDs on long runs, a race that could create two intros, poster emails that went unchecked, and silent failures when saving data or setting up the sandbox.

## Hosting (e.g. the Coldrazer VPS, which already runs Docker)

```bash
docker pull node:22-alpine
HOST=0.0.0.0 PORT=4400 TRYOUT_ADMIN_TOKEN=<secret> TRYOUT_PUBLIC_URL=https://tryout.yourdomain.com node server.js
```

Put it behind Nginx with TLS and **set `TRYOUT_PUBLIC_URL`** to its public address, because writes are only accepted for trusted hostnames. **Set `TRYOUT_ADMIN_TOKEN`** whenever the server is reachable by others, because runs spend API credits. The UI prompts for the token once. Consent links must be reachable from the candidate's phone, so use a public URL rather than a Tailscale-only address if you want people to accept on their own devices. Minimal Nginx location block:

```nginx
location / {
  proxy_pass http://127.0.0.1:4400;
  proxy_set_header Host $host;        # required: writes are checked against Host and Origin
  proxy_http_version 1.1;
  proxy_buffering off;                # required for the live event stream
  proxy_read_timeout 1h;
}
```

Example systemd unit (`/etc/systemd/system/tryout.service`):

```ini
[Service]
WorkingDirectory=/opt/tryout
EnvironmentFile=/opt/tryout/.env
ExecStart=/usr/bin/node server.js
Restart=always
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SANDBOX SELF-TEST FAILED … bad option: --permission` | Your cached Docker image is older than Node 22.8. Run `docker pull node:22-alpine` and restart. |
| Self-test fails and Docker isn't running | Start Docker Desktop, or run `TRYOUT_SANDBOX=local npm start` (Linux only for strong isolation). |
| `403 Host "…" is not allowed` | You're reaching the server by a hostname. Set `TRYOUT_PUBLIC_URL` (or `TRYOUT_ALLOWED_HOSTS=name1,name2`). |
| `403 Cross-origin request blocked` behind a proxy | Add `proxy_set_header Host $host;` so the Host matches the browser's Origin. |
| Red "network NOT isolated" badge on macOS | Install and start Docker Desktop. The local driver can't isolate the network on macOS. |
| Windows | Run inside WSL2 with Docker. Native Windows isn't supported. |

## Posting your own problem

Use **+ Post your own** in the UI, or `POST /api/problems`:

```json
{ "title": "...", "summary": "...", "sourcePath": "src/index.js",
  "source": "...", "visibleTest": "...node:test...", "hiddenTest": "...node:test...", "solution": "optional" }
```

Tryout runs the original code in the sandbox to record the baseline test names before accepting the problem.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | mode, model, sandbox description |
| GET/POST | `/api/problems` | list / create custom (admin) |
| GET/DELETE | `/api/problems/:id` | visible files only / delete custom (admin) |
| GET/POST | `/api/candidates` | list (no emails) / add `{github}` or `{name, email, skills}` (admin) |
| POST | `/api/runs` | `{problemId, candidateIds[], mode?, poster?}` (admin) |
| GET | `/api/runs/:id` · `/api/runs/:id/events` | state · SSE stream (replays, resumable) |
| POST | `/api/runs/:id/cancel` · `/api/runs/:id/intro` | admin |
| GET/POST | `/api/intros/:id?token=` · `/api/intros/:id/respond` | token-scoped consent |
| GET | `/api/intros/:id/eml?token=` | intro as .eml (after both accept) |

## Honest limits

- Today every candidate's agent uses the same model. The profile shapes how each agent works, but the score measures the agent's attempt on the person's behalf, not the person directly. The roadmap is agents built from each person's own code history and review style.
- Problems are JavaScript with `node:test`. Other languages need a harness per runtime.
- The local driver on macOS is weak (no network or PID isolation). Use Docker there.
- Native Windows isn't supported. Use WSL2.
