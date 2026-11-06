# Ralph v2: process and runner design

Date: 2026-11-06
Status: Proposal. Builds on [ai-workflow-direction.md](ai-workflow-direction.md)
(the July decision record still holds: Beads is the source of truth for work,
Ralph is the harness-neutral runner, isolation before parallelism).

This document adds three things the July record did not cover:

1. **The process** — how a loop is set up (specs → plan → build), encoded as
   Ralph commands and templates instead of ad-hoc prompts.
2. **Claude as real Claude Code sessions** instead of `claude -p`.
3. **Ralph as a service** — something Beadsmith, n8n, systemd timers, and the
   TUI can all drive through one API.

---

## 1. What the research says (late 2026)

### 1.1 The Ralph method (Huntley / Farr playbook)

Sources: <https://ghuntley.com/ralph/>, <https://ghuntley.com/loop/>,
<https://ghuntley.com/porting/>, <https://github.com/ClaytonFarr/ralph-playbook>
(which Huntley forked in Jan 2026 — the closest thing to an endorsed template).

"Three phases, two prompts, one loop":

| Phase                  | Who                                                                                                                                  | Output                                                                            | Loop?            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------- |
| 1. Define requirements | Human + LLM conversation: jobs-to-be-done → topics of concern → one spec per topic                                                   | `specs/*.md` + `specs/README.md` index ("the pin")                                | No — interactive |
| 2. Plan                | Agent: gap analysis of specs vs code. **Plan only, no implementation, no commits.** Usually 1–2 iterations                           | `IMPLEMENTATION_PLAN.md` (priority-sorted bullets; structure is the LLM's choice) | Yes, short       |
| 3. Build               | Agent: pick the single most important item, search before assuming it's missing, implement fully, run tests, update the plan, commit | code, commits, plan updates                                                       | Yes, long        |

Supporting files:

- `AGENTS.md` — operational only: how to build, run, **validate** (test /
  typecheck / lint commands). ~60 lines max. Never status or changelog — that
  pollutes every future loop's context. The validation commands _are_ the
  backpressure.
- `src/lib/` (or equivalent) — the project's "standard library"; wrong patterns
  are fixed here, wrong behavior is fixed in specs.

Rules that matter for a runner:

- **Fresh context every iteration.** One task per loop. Huntley explicitly
  rejects the in-session Stop-hook loop (Anthropic's `ralph-loop` plugin) for
  this reason; its fresh-context issue is still open.
- **The plan is disposable.** Regenerate it (one cheap planning loop) when the
  build drifts, duplicates work, the plan is stale/cluttered, or specs change.
- **Backpressure** — tests, typecheck, lint, scanners, LLM-as-judge for
  subjective criteria — is what rejects bad iterations. Only one subagent runs
  build/tests.
- **Tuning with "signs".** When Ralph misbehaves, add a guardrail (the `999…`
  numbered lines in the build prompt, an `AGENTS.md` note, or a utility in the
  stdlib). Start minimal; add signs only when observed.
- **Termination.** Canonical Ralph has none besides max-iterations / Ctrl-C.
  Community variants add a sentinel (`<promise>COMPLETE</promise>`) once the
  plan is empty. Max-iterations stays the primary safety net.
- **Watch the loop.** Huntley: watching the stream is where you learn what
  signs to add. Monitoring is part of the method, not a nice-to-have.
- **Specs must be read by a human.** Unreviewed agent-written specs from a thin
  brief produce bad output (Horthy). Spec bugs are the most expensive bugs.
- 2026 evolution: "everything is a ralph loop" (generic, forward and reverse
  modes); porting/brownfield via reverse-engineering specs with citations to
  source; Oct 2026 "code is the spec… Markdown is not a spec" — i.e. lean on
  tests/types as the real spec, markdown as the map to them.
- A Beads-backed variant exists (maxinflection/how-to-ralph-w-beads): the plan
  is the `bd ready` queue instead of a markdown file.

### 1.2 `claude -p` vs Claude Code sessions

Implementation update (2026-11-06): all harnesses now use interactive CLIs in
Herdr Core terminals. Claude uses normal CLI mode, which passes Underclass's
existing client check. The background-mode findings below are historical;
see the README for current launch flags, event tracking, and lifecycle.

- `claude -p` / Agent SDK usage is the category Anthropic tried to move off
  subscription limits (announced May 13 2026 for June 15, **paused** June 15;
  "advance notice" promised before any future change). `--bare` "will become
  the default for `-p` in a future release" and bare mode never reads OAuth —
  a subscription-authed `-p` loop will eventually just stop working.
- **Background sessions** (`claude --bg`) are full Claude Code conversations,
  documented to "consume your subscription usage the same as interactive
  sessions", with `/status` showing `background job · unattended`. They are
  the first-party path for unattended runs and show up in `claude agents`,
  can be `claude attach`-ed live, and resumed.

Verified locally on 2.1.318 (probe run 2026-11-06):

| Fact                                                                                                                                     | Consequence for Ralph                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bg` prints `backgrounded · <short-id> · <name>`; **`--session-id` is ignored** with a warning                                         | Parse the short id from stdout; map to full `sessionId` via `claude agents --json --all`                                                                                                                                                                  |
| `claude agents --json --all` gives `{id, sessionId, cwd, kind, name, state, status?}`; `state ∈ working, blocked, done, failed, stopped` | Poll this for turn completion. `blocked` = needs a human → Ralph pauses and notifies, never loops past it                                                                                                                                                 |
| Transcript at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (internal format)                                                        | Tail it for events; treat parsing as best-effort and keep raw                                                                                                                                                                                             |
| `--settings '{"worktree":{"bgIsolation":"none"}}'` accepted                                                                              | Ralph owns worktree policy, not Claude's bg isolation (otherwise bg sessions auto-commit/push/draft-PR in `.claude/worktrees/`)                                                                                                                           |
| `--effort low` was not reflected (session showed high effort)                                                                            | Verify effort handling; may need `CLAUDE_CODE_EFFORT_LEVEL` env                                                                                                                                                                                           |
| **Probe got `API Error: 403 this endpoint only accepts official Claude Code clients` → `blocked`, "Please run /login"**                  | Blocker: `~/.claude/settings.json` routes all traffic through `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` (process `underclass`). Interactive sessions work through it; daemon-backed bg sessions don't. Must be resolved before the bg harness is default |

Other harness updates found:

- **codex 0.166**: `codex exec --json` unchanged in shape; `codex exec resume`,
  `codex queue`, `--worktree`, `--ephemeral`, `--output-schema` exist.
  `--full-auto` removed (we don't use it).
- **opencode 1.17**: documented autonomy flag is now `--auto`
  (`--dangerously-skip-permissions` is a hidden alias). `opencode serve` has an
  HTTP+SSE session API — a better long-term adapter than parsing `run`.
- **copilot 1.0.104**: documented flag is `--reasoning-effort` (we pass the
  undocumented `--effort`). Has `--session-id`, `--autopilot`,
  `--max-ai-credits`, `--usage-output-file`.

### 1.3 Scheduling and n8n

- n8n 2.x disables **Execute Command** by default and it runs inside the n8n
  container anyway. The robust pattern is: **Schedule Trigger → HTTP Request to
  a local runner** (returns a run id immediately) **→ Wait node "On Webhook
  Call"**, passing `$execution.resumeUrl` to the runner, which calls it when
  the run finishes. Nothing holds a node open for hours.
- Community "Claude Code" n8n nodes wrap `-p`/SDK — avoid.
- systemd user timers (`Persistent=true`) are the zero-dependency baseline.
  On WSL2 they need `systemd=true`; the unit must wait for the run (default
  `KillMode` kills children).
- Claude cloud scheduled tasks exist but run on a fresh GitHub clone in
  Anthropic's VM — no local repos, no tailnet Beads. Not a fit for this
  workstation's main use.

### 1.4 Beadsmith integration points (already specified there)

- **Webhook runner contract v1** (`docs/file-tackle-dispatch.md`):
  `POST /agents`, `GET /agents/{id}/latest-run`, `GET /agents/{id}/runs/{run}`,
  optional follow-up and cancel; HMAC-SHA256 signing over
  `<ts>.<METHOD> <path>\n<body>`. Ralph can _be_ this runner.
- **Mate runner contract v1** (`docs/first-mate.md`): long-lived session per
  chat with SSE MissionEvents (`user | assistant | thinking | tool_call |
  result | error`). A later, larger target.
- Beadsmith names Overalls (Huntley's Loom successor, launching 2026-11-12) as
  a possible native provider — worth re-checking when it ships.

---

## 2. The process, encoded

Ralph gains first-class **modes**. Each mode = a prompt template + a loop
policy + stop conditions. Templates live in the target repo under `.ralph/`
so they can be tuned per project (signs accumulate there).

```text
ralph init                 scaffold .ralph/ (+ AGENTS.md, specs/README.md if absent)
ralph spec [topic]         INTERACTIVE Claude Code session: interview → specs/*.md
ralph reverse [path]       loop: reverse-engineer specs from existing code (brownfield)
ralph plan [--scope s]     loop (max 2 by default): gap analysis → plan; no code changes
ralph build [-n N]         loop: one plan item per iteration, validate, commit
ralph run "<prompt>"       today's behavior: arbitrary prompt loop (kept)
```

### 2.1 Repo layout created by `ralph init`

```text
AGENTS.md                  build / run / validate commands (human-seeded)
specs/README.md            index: spec file → keywords ("the pin")
specs/NN-topic.md          one per topic of concern
IMPLEMENTATION_PLAN.md     generated by `ralph plan`, edited by `ralph build`
.ralph/
  ralph.toml               harness, model, effort, limits, validate cmds, plan backend
  prompts/plan.md          PROMPT_plan (Farr/Huntley canonical, adapted)
  prompts/build.md         PROMPT_build (+ 999… signs section)
  prompts/spec.md          interview prompt for `ralph spec`
  prompts/reverse.md       reverse-engineering prompt
```

`ralph.toml` sketch:

```toml
harness = "claude" # claude | codex | opencode | gh
model = "opus"
effort = "high"

[plan]
backend = "auto" # auto | beads | markdown (auto: beads if .beads/ exists)
file = "IMPLEMENTATION_PLAN.md"

[validate] # runner-enforced backpressure (mirrors AGENTS.md)
commands = ["cargo build", "cargo test"]

[limits]
max_iterations = 20
no_progress_iterations = 3 # stop after N iterations with no new commit
```

### 2.2 `ralph plan`

- Runs the plan prompt with fresh context, max 2 iterations by default.
- Stops early when an iteration leaves the plan unchanged (`plan_converged`).
- **Runner checks "plan only"**: if anything outside the plan (`.ralph/`, the
  plan file, `.beads/`) changed, the run stops with `scope_violation` and the
  diff is kept in the run dir for review (not silently reverted). Specs are
  out of bounds too: the human owns them, so the plan files an item for a
  missing or ambiguous spec instead.
- `--scope "<text>"` writes a scoped plan (Farr's `plan-work`) — useful for a
  branch or a single Bead.
- Ends by printing the plan for **human review** — the plan is the cheapest
  place to catch a bad direction.

### 2.3 `ralph build`

Per iteration:

1. Snapshot: HEAD, dirty state, plan item count.
2. Run the build prompt in a **fresh session**.
3. **Runner-side backpressure**: run `[validate].commands` itself and record
   pass/fail. The agent is told to run them too; the runner's result is the
   one that's trusted. A failing validate after the agent's commit is surfaced
   and fed into the next iteration's prompt as context.
4. Record: new commits, files changed, plan items closed, tokens/cost,
   validate result, session id (for `claude attach` / resume).
5. Stop conditions: plan empty (or sentinel `<promise>COMPLETE</promise>`),
   max iterations, N iterations without progress, harness `blocked` /
   auth failure, rate limit (sleep+retry only in marathon mode).

### 2.4 `ralph spec`

Not a loop. Launches a normal **foreground interactive** Claude Code session
with `.ralph/prompts/spec.md` appended: interview the human (AskUserQuestion)
on JTBD → topics of concern → acceptance criteria as observable behavior (no
implementation detail), write `specs/NN-topic.md`, update `specs/README.md`.
This is the step the human must own.

### 2.5 Plan backends: Beads and markdown (both first-class)

Both backends are required, not optional. Selection is automatic unless
`[plan].backend` pins it:

- `.beads/` present (or `bd` resolves a database for the repo) → **beads**.
- otherwise → **markdown**: `IMPLEMENTATION_PLAN.md` for humans _plus_ a
  machine-readable sidecar `.ralph/plan.json` (`{items: [{id, title, status,
  priority, depends_on, spec_refs, acceptance}]}`) so agents and the runner
  never have to parse prose to know what is open. The runner validates the
  sidecar after every iteration; the markdown is regenerated from it so the
  two cannot silently drift. Agents edit it with `ralph task …`
  (`list --ready`, `add`, `start`, `done --note`, `block --note`, `learn`),
  the markdown backend's equivalent of `bd`.

With the beads backend, the same process maps onto `bd`:

| Markdown                                     | Beads                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| plan writes `IMPLEMENTATION_PLAN.md` bullets | plan runs `bd create` (with `--deps`, priority, labels; parent epic per scope) |
| build picks the top bullet                   | build takes `bd ready` top, `bd update --claim`, `bd close`                    |
| "plan empty"                                 | `bd ready` empty for the scope                                                 |
| regenerate plan                              | plan loop reconciles: close stale, file missing, re-prioritise                 |

This is what makes Ralph first-class in Beadsmith: a Beadsmith "Tackle" is a
one-item `ralph build` against a Bead; a Beadsmith "File"/elaborate is a
`ralph plan --scope`.

### 2.6 Monitoring is part of the process

- `ralph watch <name>` — follow normalized events live.
- Every harness runs in a real hc terminal: use the `hc attach` command in
  the log to watch or take over a running iteration; use its native resume
  command afterwards.
- `ralph report <name>` — commits, files, validate results, cost, plan delta,
  open questions. (The July record's "read-only run report".)
- `ralph sign <name> "<text>"` — append a guardrail to `.ralph/prompts/build.md`
  and queue it for the next iteration (steering + tuning in one step).

---

## 3. Runner architecture

```text
 CLI (ralph …)   TUI (ralph-tui)   Beadsmith   n8n / systemd
        \             |               |           /
         \            |          HMAC webhook    / HTTP + resumeUrl callback
          v           v               v         v
        ralph core  ── state dir ~/.ralph/  ── `ralph serve` (HTTP + SSE)
          |
   harness adapters: claude (bg session) | codex | opencode | gh
          |
   iteration = fresh session → raw events + normalized events + run record
```

### 3.1 State

Implemented as SQLite (WAL) at `~/.ralph/v2/ralph.db` — tables `runs`,
`iterations`, `events`, `steers` — plus per-run `log` and `raw/<n>.jsonl`
files. The Rust TUI reads the database directly. Full contract:
[state-schema.md](state-schema.md). (Turso/libSQL remains an option if state
ever needs to be shared across machines, e.g. for Beadsmith; the Effect SQL
client makes the swap local to `src/store.ts`.)

Normalized event types (from the July record, plus Beadsmith's MissionEvent
mapping): `run_started/finished/failed`, `iteration_started/finished`,
`assistant`, `thinking`, `tool_call`, `tool_result`, `validate`,
`commit_created`, `rate_limited`, `auth_failed`, `needs_input`,
`steer_received`, `heartbeat`. Each adapter emits these; unknown raw events
are kept, never dropped.

### 3.2 Claude adapter (bg session)

```bash
claude --bg -n "<instance>-<iter>" --model "$MODEL" \
  --permission-mode bypassPermissions \
  --settings '{"worktree":{"bgIsolation":"none"}}' \
  "$PROMPT"                                  # → "backgrounded · <id> · <name>"
# poll:  claude agents --json --all  → state for <id>
# events: tail ~/.claude/projects/<slug>/<sessionId>.jsonl
# done/failed/stopped → record, `claude stop`, keep session for attach/resume
# blocked             → pause instance, emit needs_input, notify
```

There is no `claude -p` fallback (dropped 2026-11-06); when bg sessions
cannot authenticate the run stops with `auth_failed`.

### 3.3 `ralph serve`

One long-running local process (systemd user unit) exposing:

- **Beadsmith webhook runner v1** under `/beadsmith/` — signed, idempotent,
  maps `POST /agents` → instance, runs → iterations.
- **Native API** `/v1/instances…` — start/stop/steer/list, SSE event stream
  (used by the TUI or a small web page, and n8n).
- **Callbacks** — on finish, POST a summary to a `callback_url` (n8n's
  `$execution.resumeUrl`, ntfy, etc.).

### 3.4 Scheduling

- `ralph schedule add <name> --cron "…" -- build -d ~/repo -n 5` generates a
  systemd user timer + service that calls `ralph` and waits for completion.
- n8n uses the HTTP API + Wait-for-webhook pattern; no Execute Command.

---

## 4. Implementation choices

- **Rewrite the core** (bash is at its limit: JSON state, HTTP, HMAC, polling
  daemons, adapters with tests) in **TypeScript with Effect v4, Vite+ (`vp`),
  and pnpm** — decided 2026-11-06. Same toolchain as Beadsmith (Node ≥24,
  TypeScript 6, `vite-plus`), so the webhook contract, HMAC signing and
  MissionEvent types can be shared or lifted in later. Effect gives typed
  errors per harness failure class, `Schema` for versioned state and the HTTP
  contracts, structured concurrency for polling/streaming, and `Layer`s so
  adapters are swappable with fixture-backed fakes in `vp test`.
  Runs directly with Node's type stripping (`node src/bin.ts`), so no build
  step is needed for the CLI.
- **Keep the Rust TUI**, re-point it at the new state dir / `ralph serve`.
- **Web interface stack** (decided 2026-11-06): **SvelteKit 3** (Svelte 5
  runes) with **pnpm** and **Vite+**, in `web/` as a pnpm workspace package.
  Built with `adapter-static` as an SPA and served by `ralph serve` at `/`;
  it only talks to the `/v1` API and SSE streams (no server-side code of its
  own), so the server stays the single process. (An earlier SvelteKit
  dashboard was removed in 3d3d704; this one starts over on the v2 API.)
- **Retire the bash entry points** (done 2026-11-06, after M2): the Effect CLI
  is `ralph` (it was `ralph-next` while it grew beside v1); the bash scripts
  live in `legacy/` (`ralph-v1`, `alph`, `cody`, `ralph-marathon`,
  `ralph-status`). The v1 call shape `ralph "<prompt>" 10 -d …` is now
  `ralph run "<prompt>" -N 10 -d …`; `ralph status` still lists live v1 loops.
- Update the `/ralph` skill to teach the process (spec → plan → build →
  watch → sign), not just spawn/kill.

## 5. Milestones

Progress (2026-11-06):

- **M3 in progress** — `ralph serve` (Effect `HttpRouter` on node:http):
  `/v1/runs` start/list/show/report/events/log/steer/stop/restart/wait, SSE
  per run (`Last-Event-ID` resume) and for the run list, `/v1/schedules`;
  bearer token required beyond loopback. Completion callbacks
  (`--callback`, `callbackUrl`; HMAC-signed) with the report as payload —
  n8n recipe in [n8n.md](n8n.md). `ralph schedule add|list|run|pause|resume|rm`
  as systemd user timers (cron → `OnCalendar`, foreground oneshot service so
  systemd sees the exit code). Runs table gains `callback_url` (0003). Web UI
  in `web/` (SvelteKit 3 SPA served by `ralph serve`): live runs, event feed,
  iterations, report, steer/stop/restart, start, schedules. Remaining for M3:
  live n8n end-to-end against a real workflow.
- **Renamed** — `ralph-next` → `ralph` (0.5.0); bash scripts moved to
  `legacy/`.
- **M2 done** — the process as commands: `init` (config, prompts, AGENTS.md
  - CLAUDE.md import, specs index, detected validate commands), `spec`
    (interactive Claude Code / Codex session), `reverse`, `plan`, `build`,
    `task` (markdown plan CLI), `report`, `watch`, `sign`. Modes are policies on
    the one loop: prompts re-read every iteration, runner-side validation with
    failures fed into the next prompt, plan snapshots for both backends, scope
    checks, and stop reasons `plan_complete`, `plan_exhausted`,
    `plan_converged`, `no_progress`, `validate_failed`, `scope_violation`,
    `complete` (sentinel in `run` mode). Exit codes: 0 done, 3 needs a human,
    1 failed, 130 interrupted. Verified live with codex on a scratch project
    (init → spec → plan converged in 2 → build). Beads backend verified
    read-only against a real database; writes go through `bd` in the agent.

- **M0 done** — opencode `--auto`, copilot `--reasoning-effort`, TUI repo
  discovery includes `~/von/ralph`, preset path fixed, and **codex default
  model removed** (codex now rejects an explicit `gpt-5.5` on ChatGPT-account
  logins; it uses its configured default unless `-m` is given).
- **M1 done** — `bin/ralph` (Effect 4.0.6, Vite+ 1.4.0, pnpm):
  `run [--detach]`, `status`, `show`, `tail [-f]`, `steer`, `stop
  [--graceful]`, `restart`, `clean`, `doctor`; harnesses claude (bg
  session), codex, opencode, gh (`claude -p` dropped); SQLite state with run
  history; per-iteration timeout; steering consumed between iterations;
  interrupted iterations recorded; live legacy bash ralphs shown in `status`.
  TUI reads the database, launches/stops/restarts through `ralph`, and
  steers with `s`. `/ralph` skill rewritten for `ralph`. 16 tests.
  Verified live with codex: detach, steer → next prompt, graceful + hard
  stop, restart, TUI steer/kill. Claude bg sessions still blocked by the local
  proxy (stops with `auth_failed`); opencode and gh not yet live-tested.

1. **M0 — fixes in place (bash, small):** opencode `--auto`, copilot
   `--reasoning-effort`, preset path discovery (`~/von/ralph`), stale defaults
   in skill/preset, raw JSONL capture.
2. **M1 — core + claude bg adapter:** TS core, versioned state, claude-bg +
   codex/opencode/gh adapters, normalized events, `ralph run` parity.
   Gate: bg sessions authenticate (proxy issue resolved).
3. **M2 — the process:** `init`, `spec`, `plan`, `build` with runner-side
   validation and stop conditions; markdown backend; `report`, `watch`,
   `sign`.
4. **M3 — service:** `ralph serve`, native API + SSE, callbacks, systemd
   schedules, n8n recipe; TUI on the new state.
5. **M4 — Beadsmith:** webhook runner v1, Beads plan backend, worktree
   isolation per instance (July Phase 2) before parallel Tackles.
6. **Later:** mate runner contract; opencode via `serve` API; Overalls check.
