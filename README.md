# von-ralph

Headless agent loops, inspired by the [Ralph Wiggum technique](https://ghuntley.com/ralph/) by Geoffrey Huntley.

`ralph` drives **Claude Code**, **OpenAI Codex**, **opencode** (sst/opencode), or
**GitHub Copilot CLI** in a managed loop: one fresh agent session per
iteration, the plan on disk as memory, runner-side validation, and a SQLite
record of every run. It is an Effect v4 / TypeScript CLI that runs directly
with Node ≥24 type stripping — no build step (design:
[docs/ralph-v2-design.md](docs/ralph-v2-design.md)).

| Command              | Description                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| `ralph`              | The runner: the spec → plan → build process, free-form loops, monitoring, steering |
| `rmux` / `ralph-tui` | TUI for launching and monitoring ralphs (reads the same database)                  |
| `ralph serve`        | HTTP API + SSE for n8n, scripts and the web UI (`web/`, SvelteKit)                 |
| `legacy/`            | The retired bash scripts (`ralph-v1`, `alph`, `cody`, …), see below                |

## Install

```bash
cd ~/von/ralph && pnpm install
ln -sf ~/von/ralph/bin/ralph ~/.local/bin/ralph
ln -sf ~/von/ralph/rmux ~/.local/bin/rmux
ralph doctor                     # which harness CLIs are installed and logged in
```

## The process: spec → plan → build

`ralph` encodes the Huntley / Farr Ralph playbook as commands. Prompts live in
the project (`.ralph/prompts/*.md`), are re-read every iteration, and
accumulate "signs" as you tune the loop.

```bash
cd ~/proj
ralph init                       # .ralph/ (ralph.toml, prompts), AGENTS.md, CLAUDE.md, specs/, plan
ralph spec "billing"             # interactive Claude Code session: interview → specs/*.md (you own these)
ralph reverse                    # brownfield alternative: derive specs from existing code
ralph plan                       # gap analysis → plan; no code changes; stops when the plan stops changing
ralph build --detach             # one plan item per iteration, validated by the runner, until the plan is done
ralph watch build-proj           # watch it (this is where you learn which signs to add)
ralph sign "Run the migrations before the tests"   # guardrail for the next iteration
ralph report build-proj          # commits, files, validation, plan delta, cost, what needs you
```

- **Plan backends** (both first-class): with a `.beads/` directory the plan is
  the Beads database (`bd ready` is the queue; `--bead <id>` builds a single
  bead). Otherwise it is `.ralph/plan.json` with a generated
  `IMPLEMENTATION_PLAN.md`; agents edit it with `ralph task …`
  (`list --ready`, `add`, `start`, `done --note`, `block --note`, `learn`).
- **Backpressure**: `[validate].commands` in `.ralph/ralph.toml` run after
  every build iteration; failures go into the next prompt, and three in a row
  stop the run.
- **Stop reasons**: `plan_complete`, `plan_exhausted` (only blocked items
  left), `plan_converged` (plan/reverse), `no_progress`, `validate_failed`,
  `scope_violation` (a plan iteration touched code; the diff is kept), plus the
  per-iteration ones below. Exit code 0 = done, 3 = ended but needs a human,
  1 = failed, 130 = interrupted.

## Free-form loops and operations

```bash
ralph run "See AGENT_PROMPT.md" -N 10 -d ~/cwl-api -n kanban-worker --detach
ralph run "Fix lint" -H codex -N 3             # foreground; codex uses its configured model
ralph run "Fix lint" -H codex -N 1             # a single run (what alph/cody did)
ralph status                                   # every ralph (and any live ralph-v1 loops)
ralph show kanban-worker                       # per-iteration outcome, tokens, cost, commits
ralph tail kanban-worker -f                    # follow the log live (same as watch)
ralph steer kanban-worker "Skip docs; fix the failing tests first."
ralph stop kanban-worker --graceful            # after the current iteration (or now, without -g)
ralph restart kanban-worker -N 5
```

- `ralph run "<prompt>"` ends early when the agent prints
  `<promise>COMPLETE</promise>`.
- Every iteration ends with a recorded outcome (`completed`, `failed`,
  `blocked`, `rate_limited`, `auth_failed`, `timed_out`, `interrupted`).
  Blocked and auth failures stop the loop instead of spinning; three
  consecutive failures stop it too. `--timeout <min>` bounds each iteration
  (default 120). `--marathon` sleeps through rate limits instead of stopping.
- Steering notes are consumed between iterations and appended to the next
  prompt; `stop --graceful` ends the run at the next boundary.
- State is SQLite at `~/.ralph/v2/ralph.db` plus per-run logs and raw harness
  output ([docs/state-schema.md](docs/state-schema.md)). Runs keep history; a
  name refers to its latest run.
- The TUI (`rmux`) reads the same database, launches through `ralph`, and
  steers with `s`.

Develop with `pnpm test` (Vite+ / vitest) and `pnpm check` (tsc + oxlint).

## Service, callbacks, schedules

```bash
ralph serve                                    # HTTP API + SSE (+ web UI) on 127.0.0.1:7420
ralph serve --host 0.0.0.0 --token "$TOKEN"    # beyond loopback a token is required
ralph build -d ~/api --callback https://n8n.example/webhook-waiting/…   # POST a summary at the end
ralph schedule add nightly --cron "0 2 * * *" -- build -d ~/api -N 8
ralph schedule list                            # next/last run, last exit code
ralph schedule run nightly                     # start it now; pause / resume / rm
```

- **`ralph serve`** exposes `/v1/runs` (list, start, show, report, events,
  log, steer, stop, restart, `wait` long-poll), SSE streams
  (`/v1/runs/:id/stream` with `Last-Event-ID` resume, `/v1/stream` for the
  run list), and `/v1/schedules`. Starting a run re-execs the CLI detached, so
  runs outlive the server. Full route list: [src/server.ts](src/server.ts).
- **Callbacks**: `--callback <url>` (or `callbackUrl` over the API) POSTs
  `{event, reason, exitCode, needsHuman, run, report}` when the run ends,
  HMAC-signed with `RALPH_CALLBACK_SECRET[_FILE]`. That is n8n's
  Wait-for-webhook pattern: [docs/n8n.md](docs/n8n.md).
- **Schedules** are systemd user timers (`ralph-sched-<name>.timer` + a
  oneshot service that runs ralph in the foreground, so systemd records the
  real exit code: 0 done, 3 needs a human, 1 failed). `--cron` is converted to
  `OnCalendar`; `--at` takes an `OnCalendar` expression directly;
  `--persistent` catches up on runs missed while the machine was off.

## Harnesses

`-H/--harness` selects which agent CLI drives the loop.

| Harness            | Binary     | Install                    | Default model                               | Reasoning                         |
| ------------------ | ---------- | -------------------------- | ------------------------------------------- | --------------------------------- |
| `claude` (default) | `claude`   | Claude Code                | `opus` (Opus 5.5; `-m fable` for Fable 5.1) | Claude Code default               |
| `codex`            | `codex`    | `npm i -g @openai/codex`   | codex config default                        | `-c model_reasoning_effort=xhigh` |
| `opencode`         | `opencode` | see https://opencode.ai    | `openai/gpt-6.1-terra`                      | `variant: xhigh`                  |
| `gh`               | `copilot`  | `npm i -g @github/copilot` | copilot default                             | `--reasoning-effort high`         |

All four harnesses run **interactive CLIs inside Herdr Core (`hc`) terminals**.
Install `hc` separately from the older `herdr` multiplexer; `ralph doctor`
checks both hc and each harness executable. Each iteration starts a fresh
terminal/context with a unique name. The log and `ralph show` include the
appropriate `hc attach` command; detach with Ctrl+\. After an iteration ends,
Ralph stops its terminal but retains the finished hc record (`hc read <id>`)
and its native session transcript. Use the CLI's resume command for another
interactive turn. Ralph never stops the shared hc server.

- **claude** uses normal `claude --session-id … --permission-mode bypassPermissions`.
  It uses neither Claude's `--bg` nor `-p`. The normal CLI works with Underclass's
  existing client check; Underclass needs no changes for this launch mode.
- **codex** uses interactive `codex --no-daemon --dangerously-bypass-approvals-and-sandbox`.
  With no `-m`, it uses the Codex CLI/config default model.
- **opencode** uses interactive `opencode --auto --prompt …`. A temporary,
  process-local plugin forwards session events and applies the requested effort
  variant. Global and project configuration files are not edited.
- **gh** uses interactive `copilot -i …` with
  `--allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user`.

Ralph follows native transcripts/events, plus hc process/status events. Startup
idle, silence, and intermediate tool turns do not count as completion. Codex
and OpenCode prompts include a unique iteration marker to associate events with
the correct root session when concurrent Ralphs share a working directory.
Timeout, interruption, error, or completion stops only that iteration's terminal.
If hc cannot confirm cleanup, Ralph aborts the run, reports the terminal, and
retains any private files it still needs. Finished terminal records can be removed with `hc rm <id>`.
A hard kill of the Ralph runner cannot run its finalizers; inspect its terminals
with `hc ls` and stop any surviving work explicitly.

Claude sessions (including the human-led `ralph spec` interview) use **Underclass
by default**. Ralph reads `~/.config/underclass/config.toml` for the bind address
and proxy key, falling back to the minted key in
`~/.local/share/underclass/pool.db` (read-only). The default endpoint is
`http://127.0.0.1:8080`. Overrides:

- `UNDERCLASS_URL` (a trailing `/v1` is removed), `UNDERCLASS_BIND`, and
  `UNDERCLASS_PROXY_KEY` override endpoint/bind/key respectively.
- `UNDERCLASS_CONFIG_DIR` and `UNDERCLASS_DATA_DIR` select other local directories.

Ralph puts `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN` in a private temporary
settings file and the child environment. It clears competing API credentials and
cloud-provider flags, and removes settings after the session stops. Credentials
are never command arguments. Missing credentials fail the launch. Existing Claude
settings are not edited. Other harnesses retain their own configured providers
and login flows; hc does not change authentication.

Verified with hc 0.1.18, Claude Code 2.1.319, and OpenCode 1.17.15. Native transcript
formats are internal and can change; unknown records are kept raw and ignored.

## Claude Code skill

The `/ralph` skill lets an interactive Claude Code session run the process and
supervise ralphs (status, spawn, watch, report, steer, sign, stop, restart).

## Legacy bash scripts

`legacy/` holds the original bash runner, kept for reference while old habits
migrate. It drives Claude with `claude -p` and keeps state in
`~/.ralph/{logs,pids}`; `ralph status` still lists its live loops.

| Script                  | Replacement                   |
| ----------------------- | ----------------------------- |
| `legacy/ralph-v1`       | `ralph run`                   |
| `legacy/alph`, `cody`   | `ralph run -N 1` (`-H codex`) |
| `legacy/ralph-marathon` | `ralph run --marathon`        |
| `legacy/ralph-status`   | `ralph status / tail / stop`  |

## Design direction

See [AI workflow direction](docs/ai-workflow-direction.md) for research and
roadmap (worktree isolation, observability, supervision, Beads integration,
lessons from Firstmate, Gas Town/Gas City, and Geoffrey Huntley's `sup`), and
[docs/ralph-v2-design.md](docs/ralph-v2-design.md) for the milestones.
