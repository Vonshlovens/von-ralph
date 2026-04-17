# von-ralph — Product Requirements Document

## Vision

von-ralph is a **supervisory cockpit** for Claude Code agent fleets. It lets developers watch, redirect, and coordinate multiple long-running headless agents from a single place — without losing track of what any of them is doing or how much it costs.

## Target users

Any developer running Claude Code in agentic loops: solo engineers automating tasks, small teams running parallel agents across projects. Assumes familiarity with Claude Code CLI but no other special tooling.

## Problem

Running multiple long-lived headless `claude` processes is opaque by default:
- No live view of what agents are doing or how far along they are
- No way to intervene mid-run without killing the process
- No cost visibility — token usage is invisible until after the fact
- No coordination between agents working on related tasks
- Agents conflict when they write to the same working directory

## Product pillars

### 1. Multi-instance monitoring
Live status for all running ralph instances: name, run counter (N/max), model, working directory, alive/dead/rate-limited state, and log tail. The TUI is the primary surface; the CLI (`ralph-status`) is the fallback.

### 2. Mid-run prompt injection
Developers can send a message to a running agent between loop iterations without restarting it. The signal file protocol (`~/.ralph/pids/<name>.signal`) is the transport; the TUI provides the input UI.

### 3. Structured logging and cost visibility
Every run captures structured JSONL alongside the human-readable log. Token counts and estimated cost are surfaced in the TUI instance detail view and in the analytics dashboard.

### 4. Git worktree isolation
An `--isolated` flag gives each agent its own git branch and worktree, eliminating conflicts when multiple agents work in the same repo. On completion the agent's branch is pushed and a PR is opened automatically.

### 5. DAG pipeline orchestration
A pipeline spec (YAML/JSON) describes a graph of ralph tasks with dependency edges. The orchestrator spawns agents in topological order, passes upstream outputs to downstream agents via signal files, and tracks pipeline-level state.

### 6. Analytics
Aggregated views across all runs: token usage over time, cost by model, tool-call frequency, success/failure rates. Surfaces in both the TUI and the web dashboard.

## Interfaces

| Interface | Role |
|-----------|------|
| `ralph` / `alph` / `ralph-status` | Core CLI — spawn, monitor, kill |
| `ralph-tui` | Primary monitoring and control surface |
| `dashboard` | Secondary web UI — richer analytics, remote access (exploratory) |

## Non-goals

- Not a replacement for Claude Code itself
- No IDE or editor integration
- No hosted or SaaS version
- No support for non-Claude Code agents
