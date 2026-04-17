# von-ralph

Headless Claude Code agent loop runner. Bash scripts handle process management and looping; a Rust/Ratatui TUI provides live monitoring and control.

## Architecture

```
~/.ralph/
  logs/     # timestamped log per instance
  pids/     # PID files + JSON metadata
```

| Component | Path | Purpose |
|-----------|------|---------|
| `ralph` | `./ralph` | Main loop runner |
| `alph` | `./alph` | Single headless run |
| `ralph-status` | `./ralph-status` | CLI monitor (list, tail, kill) |
| TUI | `ralph-tui/` | Ratatui terminal dashboard |
| Dashboard | `dashboard/` | Svelte web UI (exploratory) |

## Primary focus

`ralph-tui/` — the Rust TUI is where active development lives. Prioritize stability, UX, and feature completeness here.

## Coding standards

- **Conventional commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- **Minimal abstractions**: duplicate two or three times before abstracting
- **Tests**: write tests for new non-trivial Rust logic; skip for trivial getters/formatting
- **Comments**: only comment non-obvious WHY; never explain WHAT the code does

## Workflow

Use `ralph taskq` to discover/query/update the repo's task board. It supports JSON/YAML/Markdown boards with common task-list keywords.

Agents should start task selection with `ralph taskq next`, then query full details with `ralph taskq task <TASK-REF>`.

Use `ralph taskq chain <TASK-REF>` when chain-local context is needed.

Use `ralph taskq set-status` and `ralph taskq add-task` for board updates.

When running from presets, treat preset `dir` as the repo root/start path for task discovery.

Agents must not read full board files directly unless explicitly prompted to do so.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product vision, target users, and feature pillars
- [`docs/DESIGN.md`](docs/DESIGN.md) — TUI design philosophy, layout, keybindings, and data model
