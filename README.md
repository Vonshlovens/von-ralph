# von-ralph

Supervise headless Claude Code loops like a cockpit, not a black box.

```text
┌─ Instances ──────────────────┬─ Detail / Log ──────────────────────────┐
│ ● kanban-worker  4/10  $0.12 │ name:    kanban-worker                  │
│ ● refactor-api   2/5   $0.04 │ model:   opus                           │
│ ✗ old-task       dead        │ dir:     ~/projects/api                 │
│                              │ runs:    4 / 10                         │
│                              │ cost:    $0.12 (est.)                   │
│                              ├─ Log ───────────────────────────────────┤
│                              │ [tail of ~/.ralph/logs/<name>.log]      │
└──────────────────────────────┴──────────────────────────────────────────┘
 q quit  r restart  s spawn  i inject  l toggle-log  j/k navigate
```

Inspired by the [Ralph Wiggum technique](https://ghuntley.com/ralph/) from Geoffrey Huntley.

## Why von-ralph

- Run long-lived agent loops with process metadata, logging, and recovery behavior.
- Monitor and control multiple agents from terminal-native tooling (`ralph-status` + TUI).
- Keep task-board flow tight with built-in `ralph taskq` discovery and updates.
- Use file-based state under `~/.ralph/` so tools stay composable and scriptable.

## 60-Second Quick Start

### 1) Prerequisites

- `claude` CLI
- `jq`
- `python3` (required for `ralph taskq`)
- `cargo` (only for `ralph-tui`)

### 2) Run a loop

```bash
# from repo root
./ralph "See AGENT_PROMPT.md" 10 -d ~/cwl-api -n kanban-worker

# run in background
nohup ./ralph "See AGENT_PROMPT.md" 10 -d ~/cwl-api -n kanban-worker > /dev/null 2>&1 &
```

### 3) Monitor and intervene

```bash
./ralph-status list
./ralph-status tail kanban-worker
./ralph-status restart kanban-worker 5
./ralph-status kill kanban-worker
```

### 4) Launch the TUI

```bash
cargo run --manifest-path ralph-tui/Cargo.toml
```

## Core Commands

| Command | What it does |
|---|---|
| `./ralph [prompt] [max_runs] [options]` | Main loop runner with PID tracking, logs, and optional rate-limit recovery |
| `./ralph --marathon` | Infinite looping with rate-limit sleep/retry behavior |
| `./ralph --enforce-taskq-cycle` | Fails run when no task-board progress occurs (`>=1 done` and `>=1 added`) |
| `./ralph taskq <subcommand>` | Cross-repo task board discovery/query/update utility |
| `./ralph-status <command>` | List, tail, restart, kill, and clean instance metadata |
| `./alph` | Single headless run (no loop manager) |

## TUI-First Workflow

The Rust TUI (`ralph-tui/`) is the primary UX surface for active development.

- Live multi-instance status (alive/dead/rate-limited)
- Per-instance detail + log tail
- Spawn form and mid-run injection modal
- Keyboard-first controls: `q`, `r`, `s`, `i`, `l`, `t` (tmux split), `T` (native terminal popup), `j/k`, `↑/↓`

## taskq Workflow

```bash
# pick next actionable task
./ralph taskq next

# inspect full task context
./ralph taskq task TASK-004a

# optional chain-local context
./ralph taskq chain TASK-004a

# update board progress
./ralph taskq set-status TASK-004a in_progress
./ralph taskq add-task --title "Follow-up" --priority low
```

## Architecture

```text
~/.ralph/
  logs/     # timestamped logs + structured JSONL
  pids/     # PID files + JSON metadata + signal files
```

Interfaces:

- `ralph`, `alph`, `ralph-status`: CLI runtime and process control
- `ralph-tui/`: Ratatui dashboard for live monitoring/control
- `dashboard/`: exploratory web UI

## Project Docs

- [`docs/PRD.md`](docs/PRD.md): product goals, users, and feature pillars
- [`docs/DESIGN.md`](docs/DESIGN.md): TUI layout, keybindings, and data model

## Roadmap (near-term)

- JSONL-first analytics and cost rollups
- Richer injection and orchestration workflows
- Worktree isolation improvements for parallel agents
