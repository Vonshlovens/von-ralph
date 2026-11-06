# ralph state schema

`ralph` keeps its state in SQLite (WAL mode) at `$RALPH_HOME/ralph.db`,
default `~/.ralph/v2/ralph.db`. The Rust TUI reads it directly (read-only), so
this schema is a contract. Change it only by adding a migration in
`src/store.ts`, and update this file and `ralph-tui/src/ralph.rs` at the same
time.

Bulky text stays on disk next to the database:

```text
~/.ralph/v2/
  ralph.db                    runs, iterations, events, steers
  runs/<run-id>/log           human-readable log (emoji format; what `tail` shows)
  runs/<run-id>/raw/<n>.jsonl raw harness output / Claude transcript lines for iteration n
  launch/<name>.out           stdout/stderr of a `--detach` launch (early failures)
  runs/<run-id>/scope-violation-<n>.diff   what a plan/reverse iteration changed out of scope
```

## Tables (migrations `0001_init`, `0002_modes`)

### `runs`

One row per run of a named loop. A name can be reused after its previous run
ends; "the ralph called X" means its most recent run (`MAX(started_at)`).

| column                      | type      | notes                                                                                                                                                                                                                                                                     |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | TEXT PK   | `r<base36 ms><4 hex>`, matches Beadsmith's id charset                                                                                                                                                                                                                     |
| `name`                      | TEXT      | `[A-Za-z0-9._-]{1,100}`                                                                                                                                                                                                                                                   |
| `pid`                       | INTEGER   | runner process; liveness = `kill(pid, 0)`                                                                                                                                                                                                                                 |
| `harness`                   | TEXT      | `claude` \| `codex` \| `opencode` \| `gh`                                                                                                                                                                                                                                 |
| `model`, `effort`           | TEXT NULL | NULL = harness CLI default                                                                                                                                                                                                                                                |
| `dir`, `prompt`             | TEXT      | absolute working directory; base prompt                                                                                                                                                                                                                                   |
| `max_iterations`            | INTEGER   | 0 = unlimited                                                                                                                                                                                                                                                             |
| `marathon`                  | INTEGER   | 0/1                                                                                                                                                                                                                                                                       |
| `iteration_timeout_seconds` | INTEGER   | 0 = none                                                                                                                                                                                                                                                                  |
| `status`                    | TEXT      | `running` \| `finished` \| `failed` \| `stopped`                                                                                                                                                                                                                          |
| `current_iteration`         | INTEGER   |                                                                                                                                                                                                                                                                           |
| `stop_reason`               | TEXT NULL | `max_iterations` \| `complete` \| `plan_complete` \| `plan_exhausted` \| `plan_converged` \| `no_progress` \| `validate_failed` \| `scope_violation` \| `blocked` \| `rate_limited` \| `auth_failed` \| `harness_failed` \| `operator_stop` \| `interrupted` \| `crashed` |
| `bead_id`                   | TEXT NULL | Beads issue the run works on                                                                                                                                                                                                                                              |
| `mode`                      | TEXT      | `run` \| `plan` \| `build` \| `reverse` (0002; default `run`)                                                                                                                                                                                                             |
| `scope`                     | TEXT NULL | `--scope` text for process modes (0002)                                                                                                                                                                                                                                   |
| `callback_url`              | TEXT NULL | POSTed a JSON summary when the run ends (0003)                                                                                                                                                                                                                            |
| `started_at`, `updated_at`  | TEXT      | ISO-8601 UTC                                                                                                                                                                                                                                                              |

`status = 'running'` with a dead `pid` means the runner crashed; `ralph
clean` (or reusing the name) marks it `failed` / `crashed`.

### `iterations`

PK `(run_id, iteration)`. `outcome` is `completed` \| `failed` \| `blocked` \|
`rate_limited` \| `auth_failed` \| `timed_out` \| `interrupted`. Also
`started_at`, `finished_at`, `duration_ms`, `session_id` (harness session /
thread id), `attach_id` (legacy plain Claude attach ID, or `hc:` followed by a
JSON locator containing `address` and optional `session`, `socket`, `runtime`,
`stateHome`; rendered as an hc attach command), `head_before` / `head_after`
(git HEAD), `input_tokens`, `output_tokens`, `cost_usd`, `last_assistant`,
`error`, and (0002) `validate_ok` (0/1, NULL = not run) and `plan_open` (open
plan items after the iteration, NULL = no plan).

### `events`

`id` (autoincrement, the cursor for followers), `run_id`, `iteration`, `ts`,
`type`, `data` (the full `RalphEvent` JSON). Types: `run_started`,
`iteration_started`, `session`, `assistant`, `thinking`, `tool_call`,
`tool_result`, `usage`, `error`, `needs_input`, `turn_end`, `harness_exit`,
`steer_received`, `iteration_finished`, `rate_limit_sleep`, `run_finished`,
and for process modes `validate`, `plan_status`, `scope_violation`, `notice`.
See `src/domain.ts` for each payload.

### `steers`

Operator requests consumed between iterations. `kind` is `note` (appended to
the next iteration's prompt) or `stop` (end the run before the next
iteration). `consumed_at` / `consumed_iteration` are set when the loop takes
them; each consumed steer is also recorded as a `steer_received` event.
