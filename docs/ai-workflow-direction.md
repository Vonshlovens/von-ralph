# AI workflow direction

Date: 2026-07-14

Status: Conversation summary and design direction. This is a research snapshot,
not a commitment to implement every feature described here.

## Executive decision

`von-ralph` should remain the focused execution layer for autonomous coding
loops and become safer, more observable, and easier to supervise. It should not
grow into a second issue tracker or a full multi-agent operating environment.

The preferred direction is:

1. Keep Beads as the durable source of truth for project work.
2. Keep Ralph as the small, harness-neutral process runner.
3. Add worktree isolation before increasing parallelism.
4. Improve structured event capture, steering, health classification, and
   restart safety.
5. Add lightweight dependency-aware workflows only after the execution layer is
   reliable.
6. Borrow ideas from Firstmate, Gas Town/Gas City, and `sup` selectively instead
   of adopting any of their complete operating models.

The near-term product opportunity is not "build another Gas Town." It is "make
the best local Ralph runner for a small number of powerful, observable,
interruptible agents working safely across real repositories."

## Current Ralph baseline

Ralph already provides more than a minimal shell loop:

- Claude Code, Codex, OpenCode, and GitHub Copilot CLI harnesses.
- Non-interactive, full-autonomy invocation with per-harness event parsing.
- Named instances, PID metadata, logs, status, tail, kill, clean, and restart
  operations.
- Finite runs and marathon mode with rate-limit recovery.
- A Rust TUI for launching and monitoring instances.
- Presets for repeatable worker behavior.

The current backlog already captures several important parts of the future
direction:

- `TASK-001`: portable binary discovery.
- `TASK-002a/b`: live prompt steering through signal files and the TUI.
- `TASK-003a/b`: raw JSONL events plus token/cost visibility.
- `TASK-004a/b`: isolated Git worktrees plus TUI visibility.
- `TASK-005a-d`: validated DAG specifications, execution, output passing, and
  monitoring.

Those are broadly the right feature chains. The main change suggested by this
research is priority: isolation and truthful lifecycle state should precede
large-scale orchestration.

## Desired system boundary

The intended relationship between the tools is:

```text
human / interactive agent
          |
          v
 Beads: durable work, dependencies, acceptance criteria, audit history
          |
          v
 Ralph: launch policy, harness adapter, loop, events, health, steering
          |
          v
 isolated Git worktree + named branch
          |
          v
 Claude / Codex / OpenCode / Copilot
          |
          v
 commit, PR, report, or explicit blocked result
```

Beads answers "what work exists and why?" Ralph answers "how is this agent run,
observed, steered, and stopped?" Git worktrees answer "where may it safely
change files?" These responsibilities should remain separable.

Ralph metadata may carry a Bead ID, but Ralph should not create a competing
project backlog. A future instance record could include fields such as
`bead_id`, `worktree_path`, `branch`, `delivery_mode`, and `parent_pipeline`
without attempting to replace Beads.

## Firstmate assessment

Repository: <https://github.com/kunchenguid/firstmate>

Firstmate is an agent distribution in which one conversational "first mate"
dispatches and supervises crewmates. It is not merely a loop runner. Its useful
ideas include:

- One human-facing liaison for several concurrent tasks.
- A clean worktree for every worker.
- Separate ship and scout/investigation task shapes.
- Visible terminal sessions.
- Explicit delivery modes for validated PRs, direct PRs, and approved local
  merges.
- Persistent local state and event-driven supervision.
- Dispatch profiles that can select different harnesses for different work.

These ideas match Ralph's next major gap: worktree isolation and coordinated
supervision. Firstmate itself is not a direct replacement for Ralph because it
is a much more opinionated environment with its own backlog and toolchain. Its
verified harness set also does not currently include GitHub Copilot, which is a
supported Ralph harness.

Decision: do not replace Ralph with Firstmate. Use Firstmate as a reference for
worktree safety, task shapes, guarded delivery, supervisor visibility, and
restart-resistant state. If Firstmate is piloted separately, Bead IDs should be
carried through its briefs and Beads should remain authoritative.

## Gas Town and Gas City assessment

Repositories:

- <https://github.com/gastownhall/gastown>
- <https://github.com/gastownhall/gascity>

Gas Town is a complete multi-agent workspace manager. Its model includes a
Mayor, project rigs, persistent crew, ephemeral polecats, Convoys, Beads-backed
mail and work state, watchdog roles, workflow formulas, and a merge refinery.
It targets persistent fleets and coordination at a scale much larger than the
current Ralph use case.

Its strongest ideas are:

- Durable state outside any one model context window.
- Deterministic work routing rather than conversation-only coordination.
- Persistent identities and handoffs.
- Health monitoring, escalation, admission control, and restart recovery.
- Dependency-aware workflows and a managed merge queue.
- Broad runtime support, including Codex, OpenCode, and Copilot.

It is not the preferred foundation for this workstation today because it wants
to become the operating environment: a new headquarters, rig clones,
town/rig-level Beads state, a managed Dolt service, background agents, and its
own merge lifecycle. That overlaps the existing tailnet-hosted Beads/Dolt
system and would introduce a second ownership model for project work unless a
careful migration and database-routing design were completed first.

Gas Town also has greater installation and operational weight than Ralph. At
the time of this research, its native prerequisites were ahead of the locally
installed Go and Dolt versions. This is solvable, but it is evidence that Gas
Town is an infrastructure adoption rather than a small runner upgrade.

Gas City's documentation says that the reusable machinery was extracted from
Gas Town into a configurable platform. Therefore, if future needs genuinely
reach persistent fleets, cross-project mailboxes, formula graphs, automated
merge queues, or roughly tens of concurrent agents, evaluate Gas City and its
Gastown pack rather than assuming the standalone Gas Town architecture is the
long-term destination.

Decision: do not turn Ralph into Gas Town. Borrow durable-state, health,
dependency, and escalation concepts in small pieces. Re-evaluate Gas City only
when the operational need clearly exceeds a lightweight local runner.

## `ghuntley/sup` assessment

Repository: <https://github.com/ghuntley/sup>

`sup` is especially interesting because Geoffrey Huntley originated the Ralph
Wiggum loop. The current repository, however, is an early personal prototype,
not an install-ready successor to Ralph.

The implementation examined on 2026-07-14 consisted of one substantive commit
and a 318-line Rust program. It:

- Creates multiple tmux panes.
- Starts the same external script in each pane.
- Tails one Amp log per pane.
- Restarts a pane after two minutes without log output.
- Restarts on a few hard-coded context/JSON/shutdown strings.

It does not implement the Ralph loop. The defaults point at Huntley's personal
`amp.sh`, four personal working directories, `/tmp/amp` logs, and `AMP_LOG_*`
environment variables. The repository had no README, tests, release, or
license. The only open pull requests were automated dependency/configuration
updates. Its source compiled successfully on this workstation, but that does
not make the behavior safe for daily use.

Important weaknesses in the prototype:

- It assumes tmux window `0` and pane indices, which can interfere with an
  existing session.
- Silence in a log is treated as a stalled process. A legitimate long build or
  tool call could be killed after two minutes.
- It has no harness abstraction, PID registry, structured event normalization,
  rate-limit policy, status command, or worktree isolation.
- Commands and paths are sent into tmux without robust argument boundaries.
- With no published license, its code should not be copied into this project
  unless licensing is clarified.

The transferable idea is a supervisor that owns several visible workers and
can restart a worker after a well-supported health verdict. Ralph should
reimplement that idea using its own process metadata and normalized harness
events, not import `sup`.

## Recommended architecture principles

### 1. Isolation before orchestration

Every concurrently mutating Ralph should run in its own Git worktree and named
branch. Worktree creation must fail closed on dirty or ambiguous repository
state. Cleanup must refuse to discard uncommitted or unlanded work.

An isolated run should record at least:

- Source repository and authoritative default branch.
- Worktree path and branch.
- Starting commit.
- Harness, model, prompt, Bead ID, and delivery mode.
- Final commit/PR/report or an explicit reason why nothing landed.

Automatic push or PR creation should be opt-in. Local changes should remain
recoverable after crashes or interrupted cleanup.

### 2. Structured events as the source of runtime truth

Human-readable logs are useful, but lifecycle decisions should use normalized
events and process state. Preserve each harness's raw event stream and produce
a stable Ralph event schema on top of it.

Useful normalized event types include:

- `run_started`, `run_finished`, and `run_failed`.
- `assistant_message`, `tool_started`, and `tool_finished`.
- `files_changed` and `commit_created`.
- `rate_limited`, `authentication_failed`, and `context_exhausted`.
- `waiting_external`, `needs_input`, and `heartbeat`.
- `process_exited` and `restart_scheduled`.

Unknown harness events should be retained rather than silently dropped. A
parser failure is observability degradation, not necessarily an agent failure.

### 3. Explicit restart policy

Do not copy `sup`'s "silent log for two minutes means kill it" rule. A future
watchdog should combine:

- OS process liveness.
- Harness-specific active/idle evidence.
- Recent structured events.
- Child-process state where practical.
- Configurable deadlines for known operations.
- A bounded retry budget and visible reason for every restart.

Useful policies might be `never`, `on-clean-exit`, `on-rate-limit`,
`on-retryable-error`, and `on-confirmed-stall`. Default behavior should be
conservative. After the retry budget is exhausted, stop and surface the failure
instead of entering an invisible crash loop.

### 4. Steering must be durable and auditable

The signal-file work in `TASK-002a/b` is a good first protocol. Prompt updates
should be queued atomically, assigned an ID, acknowledged by the runner, and
retained in the run event history. Signals should be consumed only at a safe
boundary unless a distinct interrupt operation is requested.

Longer term, distinguish:

- Add context for the next iteration.
- Interrupt the current iteration and redirect it.
- Pause after the current iteration.
- Stop gracefully.
- Stop immediately.

### 5. Preserve harness portability

Claude, Codex, OpenCode, and Copilot should remain first-class. A feature is not
complete merely because it works for Claude. Harness adapters should own
commands, autonomy flags, model/effort syntax, event parsing, retryable error
classification, and graceful shutdown behavior.

Shared orchestration code should consume adapter contracts instead of matching
vendor-specific strings throughout the runner.

### 6. Keep human authority visible

The TUI should make it easy to see what is running, where it is changing files,
what Bead it belongs to, when it last made meaningful progress, and why it
restarted. Destructive cleanup, branch landing, and automatic merge behavior
should remain explicit policies rather than incidental side effects.

## Priority roadmap

### Phase 0: portability and lifecycle correctness

1. Complete `TASK-001` so every control surface resolves the same Ralph binary.
2. Define a versioned instance metadata format while retaining compatibility
   with existing `.meta` files.
3. Make process-group termination and stale metadata cleanup testable.
4. Add focused shell and Rust tests for spawn, exit, kill, and restart behavior.

### Phase 1: observability

1. Complete `TASK-003a/b` for raw JSONL preservation and TUI metrics.
2. Introduce a normalized Ralph event format across all harnesses.
3. Record parser degradation and unknown events explicitly.
4. Show last meaningful event, exit reason, and retry state in the TUI.

### Phase 2: worktree isolation

1. Complete `TASK-004a/b` before making grouped parallel runs a normal path.
2. Separate worktree creation, delivery, and cleanup into explicit lifecycle
   steps.
3. Carry Bead IDs and delivery policy in instance metadata.
4. Test crashes, dirty trees, rebase requirements, unpushed commits, and cleanup
   refusal.

### Phase 3: steering and supervision

1. Complete `TASK-002a/b` with atomic signal delivery and acknowledgements.
2. Add named groups that can present several Ralphs in one tmux session or TUI
   view without making tmux the source of truth.
3. Add policy-driven watchdogs and bounded restart budgets.
4. Add optional desktop, webhook, or TTS-compatible completion/failure events;
   notification delivery should remain outside the core runner.

### Phase 4: dependency-aware workflows

1. Proceed with `TASK-005a-d` only after isolated workers and reliable terminal
   state exist.
2. Prefer Beads dependencies as inputs when practical instead of creating an
   unrelated second dependency graph.
3. Keep workflow execution deterministic: a node becomes runnable because its
   declared dependencies reached acceptable terminal states.
4. Pass artifacts and bounded summaries between nodes, not whole unfiltered
   logs.
5. Treat merge queues and autonomous landing as separate, optional policy
   layers.

## Candidate follow-on backlog items

These are ideas for later task creation, not edits to `docs/tasks.json` in this
decision record:

- Version and validate instance metadata.
- Normalize raw harness events into a stable Ralph JSONL schema.
- Add harness adapter tests using captured fixture streams.
- Add a named group/session model for several related Ralphs.
- Add restart-policy configuration and a retry budget.
- Add a health verdict that combines process, child process, and event state.
- Persist steering requests and acknowledgements.
- Add `bead_id` and delivery fields to presets and instance metadata.
- Add fail-closed worktree cleanup tests.
- Add a read-only run report summarizing commits, files, tests, failures, token
  usage, and unresolved decisions.

## Success criteria

The future Ralph workflow is successful when:

- Two or more mutating agents can run against one repository without sharing a
  checkout or overwriting each other.
- Killing or crashing Ralph never silently loses implementation work.
- Status reflects process and harness reality rather than a stale log line.
- Every automatic restart has a durable reason and a bounded retry count.
- The four supported harnesses retain comparable lifecycle behavior.
- A human can inspect, steer, pause, and stop work without hunting through
  unrelated terminals.
- A run can be traced from Bead to prompt, worktree, events, commit, tests, and
  delivery outcome.
- Adding workflow dependencies does not create a competing project backlog.

## Suggested first pilot

After the worktree lifecycle is implemented:

1. Choose a low-risk repository with a clean default branch.
2. Select two independent Beads: one small ship task and one scout/audit task.
3. Run two differently named Ralphs in isolated worktrees, preferably using two
   different harnesses.
4. Verify live status, raw and normalized events, prompt steering, and process
   shutdown.
5. Land or preserve the ship branch; retain the scout report without permitting
   unintended changes.
6. Confirm that cleanup refuses dirty or unlanded state and removes only proven
   safe worktrees.
7. Record what operator information was missing before expanding the feature.

This pilot tests Ralph's distinct value without introducing a new orchestration
platform or changing the existing Beads source of truth.

## Research sources

- Firstmate overview and architecture:
  <https://github.com/kunchenguid/firstmate>
- Firstmate configuration and toolchain:
  <https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md>
- Gas Town overview and concepts:
  <https://github.com/gastownhall/gastown>
- Gas Town installation requirements:
  <https://github.com/gastownhall/gastown/blob/main/docs/INSTALLING.md>
- Gas City transition guide for Gas Town users:
  <https://github.com/gastownhall/gascity/blob/main/docs/getting-started/coming-from-gastown.md>
- Geoffrey Huntley's `sup` prototype:
  <https://github.com/ghuntley/sup>
- `sup` implementation inspected for this summary:
  <https://github.com/ghuntley/sup/blob/trunk/sup/src/main.rs>
