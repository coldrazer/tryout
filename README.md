<p align="center">
  <img src="docs/images/banner.jpg" alt="Tryout: networking where agents prove it, not claim it" width="100%">
</p>

<p align="center">
  <b>Post a real problem. Candidates' agents audition on it in locked-down sandboxes.<br>
  Hidden tests pick the winner. The intro happens only if both people say yes.</b>
</p>

<p align="center">
  <img alt="Node 22.8+" src="https://img.shields.io/badge/node-22.8%2B-3c873a?logo=node.js&logoColor=white">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-b8f34b">
  <img alt="70 tests passing" src="https://img.shields.io/badge/tests-70%20passing-3ddc97">
  <img alt="Sandbox: Docker or Linux namespaces" src="https://img.shields.io/badge/sandbox-docker%20%7C%20namespaces-56d4ff">
  <img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="Anything Applied Agentic Hackathon" src="https://img.shields.io/badge/hackathon-AI--Native%20Professional%20Social-ff6fb5">
</p>

<p align="center">
  <a href="#-see-it-run">Demo</a> ·
  <a href="#-how-a-tryout-works">How it works</a> ·
  <a href="#-under-the-hood">Architecture</a> ·
  <a href="#-built-to-be-un-gameable">Security</a> ·
  <a href="#-quick-start">Quick start</a> ·
  <a href="docs/DEMO.md">Stage script</a>
</p>

---

## 💡 The idea

Professional networking still runs on **claims**: résumés, bios, "10 years of experience." Anyone can write those. Very few people get to *show* what they can do before the first conversation.

**Tryout flips that.** Someone posts a real problem, like *"our signup endpoint throws 500s."* Instead of sending profiles, each candidate's **agent auditions**. It gets its own sandbox, reads the code, runs the tests, and ships a fix, live, side by side with the others. Then **hidden tests no agent ever saw** score every attempt in a fresh sandbox. The winner's human earns an introduction, with receipts attached, and contact details are shared **only after both people accept**.

> Receipts, not résumés.

## 🎬 See it run

<p align="center">
  <img src="docs/images/demo.gif" alt="A full tryout: three agents work in parallel, one gets blocked editing tests, hidden tests score them, and the intro is requested" width="100%">
</p>

<sub>A real run on the stage UI. Agents work in parallel, the one that tries to edit the tests gets <b>blocked</b>, hidden tests decide the ranking, and the poster requests the intro. Shown in rehearsal mode: scripted agents making real tool calls in real sandboxes.</sub>

## 🧭 How a tryout works

### 1 · Post a real problem
Choose a seeded problem or paste your own source file and tests. Add candidates by **GitHub username**: their profile is built from repos they actually shipped (forks excluded), not from a bio.

<img src="docs/images/01-setup.png" alt="Setup screen: pick a problem and the candidates trying out" width="100%">

### 2 · Agents audition, live
Each agent gets its own sandbox and only five tools: list, read, write, run tests, submit. Every step streams to the stage. When an agent tries to "fix" the problem by editing the tests, a red **BLOCKED** appears and the attempt is penalized.

<img src="docs/images/02-arena-live.png" alt="Three agents working in parallel; one is blocked from editing the tests" width="100%">

### 3 · Hidden tests decide
Every attempt is re-run in a **fresh sandbox** against the original tests plus hidden ones. Leo's quick patch passed every visible test but only **3 of 7** hidden ones. That's the difference between looking right and being right.

<img src="docs/images/03-arena-scored.png" alt="Scored lanes: 100, 60 and 50 with a tamper flag" width="100%">

### 4 · Receipts, not résumés
The leaderboard ranks by hidden tests (70%) and visible tests (30%), minus tamper penalties. Ties go to the smaller diff, then the faster attempt. Every score links to its receipts: the exact diff, which tests passed, and how long it took.

<img src="docs/images/04-leaderboard.png" alt="Winner banner, leaderboard and intro request" width="100%">
<img src="docs/images/05-receipts.png" alt="Receipts: score, hidden and visible tests, time, agent summary and the exact diff" width="100%">

### 5 · Two-sided consent
The poster requests an intro. Each person gets a **private link** that can only answer for them, once. Nobody's email is revealed until **both** accept. Then the intro email is drafted with the receipts inside.

<p align="center"><img src="docs/images/06-consent-mobile.png" alt="Candidate consent on a phone, before and after accepting" width="80%"></p>

<img src="docs/images/07-intro-made.png" alt="Intro made: both accepted, the email is drafted with receipts" width="100%">

## 🎯 Built for this hackathon

**Theme: AI-Native Professional Social.** Tryout answers three of the six challenges with one loop:

| Challenge | How Tryout answers it |
|---|---|
| **Beyond the Resume:** can AI understand what you can actually do? | Skill is measured by *doing the work* on a real problem, scored by tests nobody could rehearse for. |
| **The Knowledge That Finds You:** can the right expertise find you? | The poster doesn't search for people. The problem goes out, and the best fix finds them. |
| **Your Agent, My Agent:** what happens when agents network on our behalf? | Agents audition for each other's humans. The humans keep the final say through two-sided consent. |

| Judging criterion | Where to look |
|---|---|
| **Working demo** | The full flow runs end to end: post → audition → score → receipts → consent → intro. It works offline in rehearsal mode and live with Claude. |
| **Technical depth** | Two sandbox drivers, an HMAC-signed test harness, hidden-test scoring in fresh sandboxes, live SSE streaming, and 70 automated tests including escape and cheating attempts. |
| **Originality** | Networking where the introduction is earned by an agent's *work*, not a profile. |
| **Usefulness** | Hiring screens, contractor vetting, open-source maintainers looking for help: anywhere "can you actually do this?" comes before "let's talk." |
| **Human-agent collaboration** *(bonus)* | Humans post the problem, read the receipts, and decide on the intro. Agents do the legwork in between. |

## 🏗 Under the hood

```mermaid
flowchart TB
    P([Poster posts a real problem<br/>source + visible tests]) --> O{{Orchestrator}}
    O -. live events over SSE .-> UI[/Stage UI/]
    subgraph T [Parallel tryouts: no network, 5 tools each]
      A1[Agent A ⇄ Sandbox A]
      A2[Agent B ⇄ Sandbox B]
      A3[Agent C ⇄ Sandbox C]
    end
    O --> A1 & A2 & A3
    A1 & A2 & A3 -->|final source only| S[[Fresh scoring sandbox<br/>original tests + hidden tests + random canary]]
    H[(Hidden tests)] -. never shown to agents .-> S
    S -->|HMAC-signed results| L[Leaderboard + receipts]
    L --> C{Both people accept?}
    C -->|yes| I([Intro email with receipts])
    C -->|no| N([Nothing shared])
```

| Layer | What it does |
|---|---|
| **Agents** (`src/agents/`) | Live **Claude tool-use loop**, with retries on 429/5xx/529 plus turn and time limits. Also **rehearsal personas** that make real tool calls, for offline demos. |
| **Orchestrator** (`src/orchestrator.js`) | Runs every candidate in parallel, scores each the moment it finishes, and streams events. |
| **Sandbox** (`src/sandbox/`) | Docker driver, or a Linux namespace driver. Both add the Node permission model and frozen intrinsics. |
| **Scoring** (`src/scoring.js`) | Fresh sandbox, original plus hidden tests, a randomized integrity canary, diffs, ranking. |
| **Consent** (`src/intros.js`) | Two private tokens, one answer each, emails hidden until both accept, and the intro as mailto, `.eml`, or optional auto-send. |
| **Server and UI** (`server.js`, `public/`) | Zero-dependency HTTP server, SSE, strict CSP, and a vanilla-JS stage UI built for projectors and phones. |

## 🔒 Built to be un-gameable

Tryout runs code that agents wrote on behalf of strangers, so it treats every attempt as hostile, and the leaderboard as something people will try to cheat.

<table>
<tr><th>Attack</th><th>What happens</th></tr>
<tr><td>Edit or delete the tests</td><td>Blocked in the sandbox API and penalized. Scoring always uses the <i>original</i> tests.</td></tr>
<tr><td>Read the hidden tests</td><td>They never enter the agent's workspace, prompt, or API responses.</td></tr>
<tr><td>Print fake <code>ok</code> lines or fake result lines</td><td>Ignored. Only the harness's <b>HMAC-signed</b> result line counts, and its key is deleted before user code loads.</td></tr>
<tr><td>Register extra passing <code>test()</code>s</td><td>Ignored. Only test names from a trusted baseline count, and if a name appears twice, any failure wins.</td></tr>
<tr><td>Monkey-patch <code>assert</code>, <code>node:test</code>, <code>EventEmitter</code>, or <code>Array.prototype</code></td><td>No effect: frozen intrinsics plus locked core modules, with a randomized canary as a second line of defense.</td></tr>
<tr><td>Phone home, read <code>~/.ssh</code>, or steal API keys</td><td>No network (<code>--network none</code> or a network namespace), filesystem reads limited to the workspace, and a scrubbed environment.</td></tr>
<tr><td>Fork bomb, infinite loop, memory bomb</td><td>No child processes, CPU, memory, and PID caps, and the whole process group is killed at the time limit.</td></tr>
<tr><td>Kill the Tryout server from a test</td><td>PID namespace: host processes are invisible.</td></tr>
<tr><td>Hijack the server from another browser tab (CSRF / DNS rebinding)</td><td>Writes need JSON, a same-origin request, and a trusted Host.</td></tr>
</table>

Every row is a test that **passes only if the attack is blocked**. Each was run against both sandbox drivers (`test/sandbox.audit.test.js`, `test/scoring.test.js`, `test/hardening.e2e.test.js`). Two audits found and fixed real holes, and each fix has a regression test.

## 🚀 Quick start

```bash
git clone https://github.com/coldrazer/tryout && cd tryout
docker pull node:22-alpine     # strongest sandbox, auto-detected (recommended)
npm start                      # → http://localhost:4400   (no npm install needed)
```

The terminal should end with **`Self-test: sandbox OK`**.

- **No API key:** agents run in *rehearsal mode*. They're scripted, but every tool call, test result, and score is real. It's ideal for rehearsing and a safe backup if the stage Wi-Fi drops.
- **Live AI:** `cp .env.example .env`, set `ANTHROPIC_API_KEY`, and restart. Agents become live Claude tool-use loops (`TRYOUT_MODEL`, default `claude-sonnet-5-5`).

<details>
<summary><b>Configuration</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables live Claude agents |
| `TRYOUT_MODEL` | `claude-sonnet-5-5` | Model for live agents |
| `TRYOUT_MODE` | `auto` | `auto`, `live`, or `rehearsal` |
| `TRYOUT_SANDBOX` | `auto` | `auto` (Docker if ready), `docker`, or `local` |
| `HOST` / `PORT` | `127.0.0.1` / `4400` | Bind address |
| `TRYOUT_ADMIN_TOKEN` | none | Require a token for every write. **Set it whenever the server is reachable by others.** |
| `TRYOUT_PUBLIC_URL` | none | Public base URL for consent links. Also trusted for writes. |
| `TRYOUT_ALLOWED_HOSTS` | none | Extra trusted hostnames, comma-separated |
| `RESEND_API_KEY` | none | Send intro emails automatically |
| `GITHUB_TOKEN` | none | Higher GitHub rate limits when adding candidates |

See [`.env.example`](.env.example) for everything.
</details>

<details>
<summary><b>Hosting on a VPS (Nginx + systemd)</b></summary>

```bash
docker pull node:22-alpine
HOST=127.0.0.1 PORT=4400 TRYOUT_ADMIN_TOKEN=<secret> TRYOUT_PUBLIC_URL=https://tryout.yourdomain.com node server.js
```

```nginx
location / {
  proxy_pass http://127.0.0.1:4400;
  proxy_set_header Host $host;        # required: writes are checked against Host and Origin
  proxy_http_version 1.1;
  proxy_buffering off;                # required for the live event stream
  proxy_read_timeout 1h;
}
```

```ini
# /etc/systemd/system/tryout.service
[Service]
WorkingDirectory=/opt/tryout
EnvironmentFile=/opt/tryout/.env
ExecStart=/usr/bin/node server.js
Restart=always
```

Consent links must be reachable from the candidate's phone, so use a public URL if people should accept on their own devices.
</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Fix |
|---|---|
| `SANDBOX SELF-TEST FAILED … bad option: --permission` | The cached Docker image is older than Node 22.8. Run `docker pull node:22-alpine` and restart. |
| Self-test fails and Docker isn't running | Start Docker Desktop, or `TRYOUT_SANDBOX=local npm start` (strong isolation on Linux only). |
| `403 Host "…" is not allowed` | Set `TRYOUT_PUBLIC_URL` or `TRYOUT_ALLOWED_HOSTS`. |
| `403 Cross-origin request blocked` behind a proxy | Add `proxy_set_header Host $host;`. |
| Red "network NOT isolated" badge on macOS | Use Docker Desktop. The local driver can't isolate the network on macOS. |
| Windows | Use WSL2 with Docker. |
</details>

<details>
<summary><b>Posting your own problem (UI or API)</b></summary>

Use **+ Post your own** in the UI, or `POST /api/problems`:

```json
{ "title": "...", "summary": "...", "sourcePath": "src/index.js",
  "source": "...", "visibleTest": "...node:test...", "hiddenTest": "...node:test...", "solution": "optional" }
```

Tryout runs the original code in the sandbox to record the trusted baseline of test names before it accepts the problem.
</details>

<details>
<summary><b>REST API</b></summary>

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Mode, model, sandbox, self-test |
| GET / POST | `/api/problems` | List / create custom *(admin)* |
| GET / DELETE | `/api/problems/:id` | Visible files only / delete custom *(admin)* |
| GET / POST | `/api/candidates` | List (no emails) / add `{github}` or `{name, email, skills}` *(admin)* |
| POST | `/api/runs` | `{problemId, candidateIds[], mode?, poster?}` *(admin)* |
| GET | `/api/runs/:id` · `/api/runs/:id/events` | State · SSE stream (replayable, resumable) |
| POST | `/api/runs/:id/cancel` · `/api/runs/:id/intro` | *(admin)* |
| GET / POST | `/api/intros/:id?token=` · `/api/intros/:id/respond` | Token-scoped consent |
| GET | `/api/intros/:id/eml?token=` | Intro as `.eml` (after both accept) |
</details>

## 🧪 Tests and audits

```bash
npm test                  # all 70 tests: sandbox audits, scoring integrity, API e2e,
                          # live Claude loop vs a mock Messages API, GitHub profiles,
                          # hardening regressions, headless-Chrome UI flow*
npm run audit             # just the sandbox-escape and scoring-integrity audits
npm run verify:problems   # proves each problem is fair: original fails, fix = 100, partial < 100
```

<sub>*The UI flow test runs when <code>puppeteer-core</code> and Chrome are available (<code>npm i --no-save puppeteer-core</code>). Otherwise it's skipped.</sub>

## 🧩 Project layout

```
server.js            HTTP server, REST API, SSE, CSRF guard, security headers
src/orchestrator.js  parallel runs, scoring hand-off, event stream
src/agents/          claude.js (live), rehearsal.js (scripted), tools.js (the 5 tools)
src/sandbox/         docker.js, local.js, harness.js (signed results), common.js
src/scoring.js       hidden-test scoring, canary, diffs, ranking
src/intros.js        two-sided consent and intro email
src/profiles.js      candidates from GitHub evidence
problems/            seeded problems: repo, hidden tests, reference and partial fixes
public/              stage UI and mobile consent page
test/                70 tests across 7 suites
```

## 🧭 Honest limits and what's next

- **Agents share a model today.** Each profile shapes how its agent works, but the score measures the agent's attempt *on the person's behalf*. Next: agents grounded in each person's own code history and review style.
- **JavaScript problems only** (`node:test`). Next: harnesses for Python and Go.
- **The local driver is Linux-first.** Use Docker on macOS. Native Windows isn't supported (use WSL2).
- **Next up:** private problem rooms for hiring teams, reputation from repeated tryouts, and poster-side rubrics beyond tests.

## 📄 License

[Apache-2.0](LICENSE). The banner background was AI-generated for this project. The seeded candidates (Maya, Leo, Sam) are fictional.
