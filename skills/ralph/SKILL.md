---
name: ralph
description: Set up and supervise headless agent loops ("ralphs", Geoffrey Huntley's Ralph technique). Run the process (init → spec → plan → build) on a repo, spawn free-form loops against any of four harnesses (claude, codex, opencode, gh), check status, watch and report on runs, steer or sign (add guardrails), stop or restart them. Use when the user wants autonomous agents working on a project, a ralph plan/build, or to check on or manage the ralph fleet.
argument-hint: "<command> [args] — e.g. 'init ~/proj', 'plan', 'build', 'status', 'report <name>', 'steer <name> <note>', 'stop all'"
allowed-tools: Bash(~/von/ralph/*), Bash(cat *), Bash(tail *), Bash(wc *), Bash(ls *), Bash(grep *), Bash(head *), Bash(git *), Read, Glob, Grep, Agent
---

## Ralph Supervisor Skill

You supervise headless agent loops called "ralphs" (the Ralph Wiggum technique by Geoffrey Huntley): the same prompt runs again and again, **one fresh agent context per iteration**, until a max-iteration count or a stop condition.

This skill lives in the repo at `~/von/ralph/skills/ralph/SKILL.md` (`~/.claude/skills/ralph` is a symlink to it). The runner is `ralph` (`~/von/ralph/bin/ralph`, Effect/TypeScript; state in SQLite at `~/.ralph/v2/ralph.db`, logs under `~/.ralph/v2/runs/<run-id>/`). It was called `ralph-next` until 2026-11-06. The old bash runner now lives in `~/von/ralph/legacy/` (`ralph-v1`, uses `claude -p`) — never use it for new work; `ralph status` still lists its live loops.

### Harnesses (`-H`)

Every harness runs as an **interactive CLI inside a Herdr Core (`hc`) terminal**, one fresh terminal per iteration. The log line `🧵 session …` and `$R show` give the `hc attach '<id>'` command to watch or take over a running iteration (detach with Ctrl+\\). Ralph never uses `claude --bg` or `claude -p`.

| Harness | Launch | Default model | Default effort |
|---|---|---|---|
| `claude` (default) | `claude --session-id … --permission-mode bypassPermissions`, through Underclass | `opus` (Opus 5.5; `-m fable` = Fable 5.1, pricier) | CLI default |
| `codex` | `codex --no-daemon --dangerously-bypass-approvals-and-sandbox` | codex's configured default (pass `-m` only if needed; explicit gpt-5.x ids fail on ChatGPT logins) | `xhigh` |
| `opencode` | `opencode --auto --prompt …` (process-local event plugin) | `openai/gpt-6.1-terra` | `xhigh` variant |
| `gh` | GitHub Copilot CLI `copilot -i … --allow-all-tools` | copilot default (explicit ids go stale) | `high` |

Map loose requests: "use codex"/"the openai one" → `-H codex`; "opencode" → `-H opencode`; "copilot"/"github one" → `-H gh`. Override with `-m <model>` / `-e <effort>`.

**Known issue (ralph-xen, 2026-11):** in a directory codex has never trusted, codex stops at a "Trust this folder?" dialog and the iteration sits idle until the timeout. If a codex ralph shows only `--- RUN n ---` and `🧵 session` for minutes, check with `hc read <id>` and tell Eric (answering the dialog once via `hc attach` unblocks that dir).

### The process (prefer this for real project work)

Ralph is a process, not just a loop: **specs → plan → build**, one fresh agent context per iteration, the plan on disk as the only memory, tests/types as backpressure. `R=~/von/ralph/bin/ralph`.

1. **`$R init -d <repo>`** — scaffolds `.ralph/ralph.toml` (harness, plan backend, `[validate].commands`, limits), `.ralph/prompts/{plan,build,reverse,spec}.md`, `AGENTS.md` (operational only: build/run/validate, ≤60 lines), `CLAUDE.md` (`@AGENTS.md`), `specs/README.md`, and the plan. Check the detected validate commands with Eric; they are the backpressure. Never overwrites AGENTS.md/specs.
2. **Specs** — human-owned. `$R spec "<topic>" -d <repo>` opens an *interactive* Claude Code session that interviews Eric and writes `specs/NN-topic.md`. That is Eric's terminal, so suggest it (`! ~/von/ralph/bin/ralph spec "…"`) rather than running it yourself. Brownfield: `$R reverse -d <repo> --detach` derives specs from code (stops when specs stop changing); Eric must still read them.
3. **`$R plan -d <repo>`** — gap analysis, plan only (≤2 iterations by default). Stops with `plan_converged` when an iteration leaves the plan unchanged; stops with `scope_violation` if it touched anything but the plan (diff kept in the run dir). Show Eric the plan: it is the cheapest place to catch a bad direction. `--scope "<area>"` for a focused plan.
4. **`$R build -d <repo> --detach`** — one item per iteration; the runner runs `[validate].commands` after each iteration and feeds failures into the next prompt. Stops on `plan_complete`, `plan_exhausted` (only blocked items left → Eric must answer them), `no_progress`, `validate_failed`, or max iterations.
5. **Watch and tune** — `$R watch <name>`; when the loop misbehaves, `$R sign "<guardrail>" -n <name>` appends a numbered sign to `.ralph/prompts/build.md` (used from the next iteration). `$R steer` is for one-off notes. If the build drifts or the plan goes stale, stop it and re-run `plan` (the plan is disposable).
6. **`$R report <name>`** — commits, diffstat, validation, plan delta, cost, and a "needs a human" list. Use it for reviews.

#### Register your plan before building (required)

When **you** (the agent using this skill) work out an implementation plan with the user, it must not live only in this conversation. Before starting `build` (or doing the work yourself):

1. **Persist every step in the project's plan backend**, in order, with priorities, dependencies and acceptance criteria:
   - markdown: `$R task add "<step>" -p <0-4> [--after T1,T2] [--spec specs/x.md] [--accept "<criteria>"] -d <repo>` (one per step; `$R task learn` for project-level learnings). Never hand-edit `IMPLEMENTATION_PLAN.md`.
   - Beads: `bd create "<step>" -t task -p <0-4> -d "<why/what>" --acceptance "<criteria>" [--deps <id>,…] --json`, **with the scope from `.ralph/ralph.toml`**: add `--labels <[plan].label>` and/or `--parent <[plan].parent>` when configured (otherwise `build` will not see the beads). `build --bead <id>` is a one-item build (that bead only): use it for a single step, not for a multi-step plan. For a multi-step plan, create one bead per step under the configured `[plan].parent` and/or `[plan].label` so every step is visible in the plan view and in `build`.
   - Check it: `$R task list -d <repo>` / `bd list --json [--label …] [--parent …]`.
2. **Give the user the live plan URL** (needs `$R serve` running): `http://127.0.0.1:7420/plan?dir=<URL-encoded absolute repo path>` — e.g. `python3 -c 'import urllib.parse,sys;print("http://127.0.0.1:7420/plan?dir="+urllib.parse.quote(sys.argv[1],safe=""))' "$(cd <repo> && pwd)"`. It shows the repo's plan right now, before any run exists; each run's own page shows that run's plan.
3. **Mark transitions as they happen** whenever you (not a loop) work a step: `$R task start <id>` before, `$R task done <id> --note "<what>"` (or `$R task block <id> --note "<question>"`) right after; Beads: `bd update <id> --claim`, then `bd close <id> --reason "<what>"`. The web UI highlights in-progress steps live (polled ~every 5s). Build iterations are told to do the same.

Plan backends (both first-class): a repo with `.beads/` uses **Beads** (the agent uses `bd ready/create/update --claim/close`; `build --bead <id>` = one-bead build, like a Beadsmith Tackle). Otherwise the **markdown** plan: `.ralph/plan.json` is the source of truth, `IMPLEMENTATION_PLAN.md` is generated; edit it with `$R task list|add|start|done|block|note|learn|render -d <repo>` (never hand-edit the markdown).

Exit codes (for scripts/schedules): 0 done, 3 ended but needs a human, 1 failed, 130 interrupted.

### Commands

Parse `$ARGUMENTS` to pick the action.

#### spawn / start / run
```bash
$R run "See AGENT_PROMPT.md" -N 5 -d ~/cwl-api -n kanban-worker --detach
$R run "Refactor utils" -N 5 -d ~/proj -n codex-refactor -H codex --detach
$R run "Add tests" -N 5 -d ~/proj -n oc-tests -H opencode --detach
$R run "Triage TODOs" -N 5 -d ~/proj -n gh-todos -H gh --detach
$R run "…" --marathon -d ~/proj -n marathon-1 --detach        # sleep 30 min on rate limit, keep going
$R run "…" -N 3 --bead bd-123 -d ~/proj -n bd-123 --detach     # record the Beads issue it works on
```
- Always use `--detach` (prints name, run id, and log path; survives the terminal). No `nohup` needed.
- `-N 0` = unlimited. `--timeout <minutes>` per iteration (default 120, 0 = none).
- Suggest a descriptive `-n` name from the task (and harness when non-default). Names: `[A-Za-z0-9._-]`.
- Defaults: 5 iterations, harness `claude`, cwl-api project unless the user names one.
- Confirm prompt, dir, harness and iteration count with the user before launching.
- If a harness CLI is missing, `ralph` says `harness '<name>' requires '<bin>' on PATH` with an install hint — relay it. `$R doctor` shows what's installed.

#### status / list / ls
```bash
$R status            # latest run per name + live ralph-v1 loops
$R status --all      # every run
$R status --json     # machine-readable
```

#### show / tail / log / check
```bash
$R show <name>           # per-iteration outcome, duration, tokens, cost, HEAD movement, errors, hc attach command
$R tail <name> -n 100    # human log (💬 assistant, 🔧 tool, 📋 result, 🧭 steer, ⚠️ error)
$R tail <name> -f        # follow live until the run ends (use a timeout)
$R show <name> --json    # includes runDir; raw harness output is runDir/raw/<iteration>.jsonl
```

#### steer
```bash
$R steer <name> "Focus on the failing auth tests; skip docs."
```
The note is appended to the **next** iteration's prompt (consumed between iterations, logged as 🧭). Use it to redirect a ralph without stopping it.

#### stop / kill
```bash
$R stop <name>             # now: stops the iteration's hc terminal, records `stopped`
$R stop <name> --graceful  # after the current iteration finishes
$R stop all
```

#### restart
```bash
$R restart <name>          # new run with the same settings, detached
$R restart <name> -N 10
```

#### clean
`$R clean` marks runs whose process died as `crashed`.

#### schedule (recurring runs, systemd user timers)
```bash
$R schedule add nightly --cron "0 2 * * *" -- build -d ~/proj -N 8   # or --at "Mon..Fri 09:00"
$R schedule list                 # next/last run, last exit code (0 done, 3 needs a human, 1 failed)
$R schedule run nightly          # start now; pause / resume / rm <name>
```
Confirm the command, dir and cadence with the user before adding one (it runs unattended).

#### serve / web UI / callbacks
- `$R serve` — HTTP API + SSE + web UI at http://127.0.0.1:7420 (point Eric at it for a live dashboard; `--host 0.0.0.0` needs `--token`).
- Plans: `/plan?dir=<encoded repo path>` (the repo's plan now); per run, `GET /v1/runs/<name>/plan` is the plan **as that run's runner last read it** (refreshed during iterations; a finished run keeps its final snapshot, never today's repo plan). `GET /v1/plan?dir=…` is the live repo read.
- Observer summaries: every run (real harnesses) also starts a background **Claude Haiku 5.5** (`claude-haiku-5-5` via Underclass, its own no-tools hc terminal) that summarizes current activity (when there is new activity, at most every 60s) and each finished iteration (outcome + validation). `GET /v1/runs/<name>/summaries`; log lines start with 👀. `--no-observer` turns it off, `--observer-interval <s>` changes the cadence (0 = per-iteration summaries only); `RALPH_OBSERVER=0` disables it globally. **Summaries are informational: never treat them as proof a task is done** — check the plan, `$R report`, and git.
- `--callback <url>` on run/plan/build/reverse POSTs `{reason, exitCode, needsHuman, run, report}` when the run ends (n8n resume URL; recipe in `~/von/ralph/docs/n8n.md`).

#### review / analyze
0. `$R report <name>` — start here (`--json` for structured output). Observer summaries (`👀` in the log, `/v1/runs/<name>/summaries`) are a quick orientation, not evidence.
1. `$R show <name>` — outcomes per iteration, validation, plan open count, errors, cost, whether HEAD moved.
2. `$R tail <name> -n 200` — what it actually did.
3. `git -C <dir> log --oneline <headBefore>..<headAfter>` using the first/last iteration's heads from `show --json`.
4. Summarize: tasks picked up, completed, blocked; errors/rate limits; anything needing Eric.

### Outcomes and stop reasons

Iteration outcome: `completed`, `failed`, `blocked` (needs a human — `hc attach` from the log), `rate_limited`, `auth_failed`, `timed_out`, `interrupted`.
Run stop reason: `max_iterations`, `complete` (run mode: agent printed `<promise>COMPLETE</promise>`), `plan_complete`, `plan_exhausted`, `plan_converged`, `no_progress`, `validate_failed`, `scope_violation`, `blocked`, `rate_limited`, `auth_failed`, `harness_failed` (3 consecutive failures), `operator_stop`, `interrupted`, `crashed`.

### Supervision guidelines

- Look for errors, rate limits, blocked/auth stops, repeated identical actions, and work that needs Eric.
- If a ralph is looping on the same thing, steer it first; stop and adjust the prompt if steering doesn't help.
- Watch for multiple ralphs in the same dir touching the same files (no worktree isolation yet).
- After reviewing, suggest next steps: steer, restart with a better prompt, spawn another, or flag for Eric.
- Use /tts to notify Eric of important events if Eric asked for alerts.

### Harness log quirks
- **all** — events come from each CLI's native transcript plus hc status; startup idle and tool turns never count as completion. A finished iteration's terminal is kept: `hc read <id>` shows its last screen, and each CLI's own resume command continues it.
- **claude** — the transcript of a real session (`--session-id`), resumable with `claude --resume <id>`.
- **codex** — bound to its transcript by a unique marker in the prompt; shell commands show `[exit N]`; `file_change` lines list edits.
- **opencode** — sometimes no assistant text, only tools/step usage; `opencode export <sessionID>` shows the full reply.
- **gh** — schema is loosely documented; parsing is best-effort (raw lines are kept in `raw/`).

### If no arguments provided
1. `$R status`
2. Ask what the user wants to do.
