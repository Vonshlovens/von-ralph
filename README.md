# von-ralph

Headless Claude Code agent loops, inspired by the [Ralph Wiggum technique](https://ghuntley.com/ralph/) by Geoffrey Huntley.

## Scripts

| Script | Description |
|--------|-------------|
| `ralph` | Main loop — runs a prompt N times with logging, PID tracking, and optional rate-limit recovery |
| `alph` | Single headless run (no loop) |
| `ralph-marathon` | Legacy infinite loop with rate-limit sleep (use `ralph --marathon` instead) |
| `ralph-status` | Monitor running ralphs — list, tail logs, kill instances |
| `ralph taskq` | Cross-repo task board discovery/query/update (JSON/YAML/Markdown) |

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

# Query next actionable task from discovered board
ralph taskq next

# Query full task context
ralph taskq task TASK-004a
```

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

## TODO

- [ ] Web dashboard for live ralph monitoring
- [ ] Allow on-the-fly prompt updates / interruption / check-in
- [ ] Agent analytics — analyze agent trends to improve specs/prompts
- [ ] Git worktree isolation per ralph (avoid conflicts)
- [ ] Slack/webhook notifications for completions and errors
