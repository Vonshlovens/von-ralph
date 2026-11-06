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

## Harnesses

`-H/--harness` selects which agent CLI drives the loop.

| Harness            | Binary     | Install                    | Default model                               | Reasoning                         |
| ------------------ | ---------- | -------------------------- | ------------------------------------------- | --------------------------------- |
| `claude` (default) | `claude`   | Claude Code                | `opus` (Opus 5.5; `-m fable` for Fable 5.1) | Claude Code default               |
| `codex`            | `codex`    | `npm i -g @openai/codex`   | codex config default                        | `-c model_reasoning_effort=xhigh` |
| `opencode`         | `opencode` | see https://opencode.ai    | `openai/gpt-6.1-terra`                      | `--variant xhigh`                 |
| `gh`               | `copilot`  | `npm i -g @github/copilot` | copilot default                             | `--effort high`                   |

- **claude** runs each iteration as a **real Claude Code background session**
  (`claude --bg … --permission-mode bypassPermissions`), never `claude -p`.
  The runner polls `claude agents --json`, follows the session transcript into
  the log, and stops the session when the iteration ends; `claude attach <id>`
  opens any iteration (the id is in the log and `show`).
- **codex** uses `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`.
  With no `-m` it uses the Codex CLI/config default model (pinned ids go
  stale; gpt-5.5 has been retired for ChatGPT logins).
- **opencode** uses `opencode run --format json --auto`.
- **gh** (GitHub Copilot CLI's `copilot` binary, not `gh copilot`) runs with
  `--allow-all-tools --allow-all-paths --allow-all-urls`. Its JSONL schema is
  undocumented; the parser is best-effort with raw-line fallback.
- Auth is per-harness (use each CLI's normal login flow before launching).

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
