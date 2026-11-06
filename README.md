# von-ralph

Headless agent loops, inspired by the [Ralph Wiggum technique](https://ghuntley.com/ralph/) by Geoffrey Huntley.

Drive **Claude Code**, **OpenAI Codex**, **opencode** (sst/opencode), or **GitHub Copilot CLI** — each in non-interactive full-autonomy mode — in a managed loop with logging, PID tracking, and rate-limit recovery.

## Scripts

| Script | Description |
|--------|-------------|
| `ralph` | Main loop — runs a prompt N times with logging, PID tracking, and optional rate-limit recovery. Supports multiple harnesses via `-H`. |
| `alph` | Single headless run (no loop), same `-H` harness flag |
| `cody` | Single headless Codex run. Uses Codex CLI/config default model unless `-m` is supplied. |
| `ralph-marathon` | Legacy infinite loop with rate-limit sleep (use `ralph --marathon` instead) |
| `ralph-status` | Monitor running ralphs — list, tail logs, kill instances (preserves harness on restart) |
| `rmux` / `ralph-tui` | TUI for launching and monitoring ralphs, with a harness picker in the spawn form |

## Quick start

```bash
# Run 10 loops against cwl-api's AGENT_PROMPT
ralph "See AGENT_PROMPT.md" 10 -d ~/cwl-api -n kanban-worker

# Background it (survives terminal close)
nohup ralph "See AGENT_PROMPT.md" 10 -d ~/cwl-api -n kanban-worker > /dev/null 2>&1 &

# Check status
ralph-status list

# Tail the log
ralph-status tail kanban-worker

# Kill it
ralph-status kill kanban-worker

# Single headless Codex run
cody "Fix lint errors"
```

## ralph-next

`bin/ralph-next` is the Effect v4 / TypeScript runner (see
[docs/ralph-v2-design.md](docs/ralph-v2-design.md)); the bash scripts below
are legacy. It runs directly with Node ≥24 type stripping — no build step:

```bash
pnpm install
bin/ralph-next doctor                                   # which harness CLIs are installed
bin/ralph-next run "See AGENT_PROMPT.md" -N 10 -d ~/cwl-api -n kanban-worker --detach
bin/ralph-next run "Fix lint" -H codex -N 3             # foreground; codex uses its configured model
bin/ralph-next status                                   # also lists live legacy bash ralphs
bin/ralph-next show kanban-worker                       # per-iteration outcome, tokens, cost, commits
bin/ralph-next tail kanban-worker -f                    # follow the log live
bin/ralph-next steer kanban-worker "Skip docs; fix the failing tests first."
bin/ralph-next stop kanban-worker --graceful            # after the current iteration (or now, without -g)
bin/ralph-next restart kanban-worker -N 5
```

- `-H claude` (default) drives **real Claude Code background sessions**
  (`claude --bg`), one fresh session per iteration — not `claude -p`.
  `claude attach <id>` opens any iteration; the id is in the log and `show`.
- State is SQLite at `~/.ralph/v2/ralph.db` plus per-run logs and raw harness
  output ([docs/state-schema.md](docs/state-schema.md)). Runs keep history; a
  name refers to its latest run.
- Every iteration ends with a recorded outcome (`completed`, `failed`,
  `blocked`, `rate_limited`, `auth_failed`, `timed_out`, `interrupted`).
  Blocked and auth failures stop the loop instead of spinning; three
  consecutive failures stop it too. `--timeout <min>` bounds each iteration
  (default 120).
- Steering notes are consumed between iterations and appended to the next
  prompt; `stop --graceful` ends the run at the next boundary.
- The TUI (`rmux`) reads the same database, launches through `ralph-next`, and
  steers with `s`.

Develop with `pnpm test` (Vite+ / vitest) and `pnpm check` (tsc + oxlint).

## Harnesses

`-H/--harness` selects which agent CLI drives the loop. Each one is invoked in
non-interactive / full-autonomy mode (no per-action permission prompts) and its
JSONL event stream is parsed into a uniform log.

| Harness | Binary | Install | Default model | Reasoning |
|---------|--------|---------|---------------|-----------|
| `claude` (default) | `claude` | Claude Code | `opus` | — |
| `codex` | `codex` | `npm i -g @openai/codex` | codex config default | `-c model_reasoning_effort=xhigh` |
| `opencode` | `opencode` | see https://opencode.ai | `openai/gpt-5.5` | `--variant max` |
| `gh` | `copilot` | `npm i -g @github/copilot` | copilot default | `--effort high` |

```bash
ralph "Refactor utils" -H codex
cody "Refactor utils"
cody "Refactor utils" -m gpt-5.5
ralph "Add tests" -H opencode -m openai/gpt-5.5
ralph "Triage TODOs" -H gh
```

Notes:
- **codex** uses `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` and `--json` event streaming.
- **cody** is a Codex-only `alph` variant. By default it omits `-m/--model`, so Codex uses the CLI/config default model. Pass `-m gpt-5.5` to pin the current recommended Codex model explicitly.
- **opencode** uses `opencode run --format json --auto`. Assistant text, tool output, step summaries, and API errors are parsed into the log.
- **gh** (GitHub Copilot CLI's `copilot` binary, not `gh copilot`) is invoked with `--allow-all-tools --allow-all-paths --allow-all-urls --reasoning-effort high`. The JSONL schema is undocumented and shifting; the parser is best-effort with raw-line fallback.
- Auth is per-harness (use each CLI's normal login flow before launching).

## Claude Code skill

The `/ralph` skill lets an interactive Claude Code session supervise ralphs:
- `/ralph status` — check running instances
- `/ralph spawn` — launch a new ralph
- `/ralph review` — analyze what a ralph accomplished
- `/ralph kill all` — stop everything

## Architecture

```
~/.ralph/
  logs/       # Timestamped log files per ralph
  pids/       # PID files + metadata for monitoring
```

## Design direction

See [AI workflow direction](docs/ai-workflow-direction.md) for the current
research and roadmap covering worktree isolation, observability, supervision,
Beads integration boundaries, and lessons from Firstmate, Gas Town/Gas City,
and Geoffrey Huntley's `sup` prototype.

## TODO

- [ ] Allow on-the-fly prompt updates / interruption / check-in
- [ ] Agent analytics — analyze agent trends to improve specs/prompts
- [ ] Git worktree isolation per ralph (avoid conflicts)
- [ ] Slack/webhook notifications for completions and errors
