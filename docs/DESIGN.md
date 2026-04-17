# von-ralph — Design Spec

## TUI philosophy

The TUI targets **rich dashboard density** — think k9s or lazygit, not a sparse status line. Borders, colors, and multiple panes are first-class. Every element should earn its space, but the goal is _informed at a glance_, not minimal.

Principles:
- Keyboard-first, no mouse required
- Information density over whitespace
- State is visible without drilling in (alive/dead/cost/progress in the list)
- Modals for actions that need input (spawn, inject, confirm)

## Layout

```
┌─ Instances ──────────────────┬─ Detail / Log ──────────────────────────┐
│ ● kanban-worker  4/10  $0.12 │ name:    kanban-worker                  │
│ ● refactor-api   2/5   $0.04 │ model:   claude-sonnet-4-6              │
│ ✗ old-task       dead        │ dir:     ~/projects/api                 │
│                              │ started: 2026-04-17 01:30               │
│                              │ runs:    4 / 10                         │
│                              │ cost:    $0.12 (est.)                   │
│                              ├─ Log ───────────────────────────────────┤
│                              │ [tail of ~/.ralph/logs/<name>.log]      │
└──────────────────────────────┴─────────────────────────────────────────┘
 q quit  r restart  s spawn  i inject  l toggle-log  t split-term  T native-term  j/k navigate
```

- **Left pane**: scrollable instance list. Status icon (●=alive, ✗=dead, ⏸=rate-limited), name, run counter, estimated cost.
- **Right pane**: instance detail (top) + live log tail (bottom), toggled with `l`.
- **Modals**: spawn form and prompt injection overlay the full terminal.

## Key bindings

Established bindings — must not change:

| Key | Action |
|-----|--------|
| `q` | Quit TUI |
| `r` | Restart selected instance |
| `s` | Open spawn form |
| `l` | Toggle log view |
| `i` | Open prompt injection panel |
| `t` | Open side-by-side tmux terminal split |
| `T` | Open native embedded terminal popup |
| `j` / `k` | Navigate instance list |
| `↑` / `↓` | Navigate (alias) |

New bindings follow single-key convention. Avoid chords unless essential.

## Color palette

| State | Color |
|-------|-------|
| Alive | Green |
| Dead | Red |
| Rate-limited | Yellow |
| Selected | Bold / highlighted |
| Cost | Cyan |
| Header / borders | Default / dim |

No decorative color. Color encodes state, not aesthetics.

## Data model

```
~/.ralph/
  pids/
    <name>.meta      # JSON: name, pid, prompt, max_runs, model, work_dir, started, current_run
    <name>.signal    # plaintext: mid-run prompt injection; deleted after read
  logs/
    <name>.log       # human-readable log (appended per run)
    <name>.jsonl     # structured JSON events one-per-line (token usage, tool calls)
```

The TUI polls `pids/` on a short interval (≤1s). It reads `.meta` for state and `.jsonl` for cost data. It writes `.signal` when the user submits a prompt injection.

## Communication protocol

```
shell scripts ──write──▶ .meta, .log, .jsonl
TUI           ──poll──▶  .meta, .jsonl
TUI           ──write──▶ .signal
ralph script  ──read──▶  .signal (between iterations), deletes after read
```

No IPC, no sockets. File-based protocol keeps the TUI decoupled from the shell scripts.

## Shell script conventions

- POSIX-compatible bash (no bashisms that break on `sh`)
- `jq` for all JSON read/write
- No external dependencies beyond Claude Code CLI and standard Unix tools
- Targeted edits preferred over full rewrites
