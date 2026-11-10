import { attachCommand } from "./hc.ts";
/**
 * Ralph state: SQLite (WAL) at `$RALPH_HOME/ralph.db` (default `~/.ralph/v2`),
 * plus per-run files for bulky text:
 *
 *   runs/<run-id>/log               human-readable log (emoji format, tail-able)
 *   runs/<run-id>/raw/<n>.jsonl     raw harness output / transcript lines
 *
 * The schema is a contract: the Rust TUI reads it directly (read-only). Change
 * it only through a new migration, and keep docs/state-schema.md in sync.
 * The legacy bash runner's `~/.ralph/{logs,pids}` are untouched.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Context, Effect, FileSystem, Layer, Path, Schema, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import * as os from "node:os";
import {
  Instance,
  IterationRecord,
  type RalphEvent,
  type SteerKind,
  StateError,
  clip,
} from "./domain.ts";

export interface Steer {
  readonly id: number;
  readonly kind: SteerKind;
  readonly text: string;
}

export interface StoredEvent {
  readonly id: number;
  readonly event: RalphEvent;
}

export type InstancePatch = Partial<
  Pick<Instance, "pid" | "status" | "currentIteration" | "stopReason">
>;

export interface StoreShape {
  readonly root: string;
  readonly dbPath: string;
  readonly runDir: (id: string) => string;
  readonly logPath: (id: string) => string;
  readonly create: (instance: Instance) => Effect.Effect<void, StateError>;
  readonly update: (id: string, patch: InstancePatch) => Effect.Effect<void, StateError>;
  /** Exact run id, or the most recent run with that name. */
  readonly get: (nameOrId: string) => Effect.Effect<Instance, StateError>;
  /** Most recent run per name (or every run with `all`), newest first. */
  readonly list: (options?: {
    readonly all?: boolean;
  }) => Effect.Effect<ReadonlyArray<Instance>, StateError>;
  readonly iterations: (id: string) => Effect.Effect<ReadonlyArray<IterationRecord>, StateError>;
  readonly appendEvent: (event: RalphEvent) => Effect.Effect<void, StateError>;
  readonly events: (
    id: string,
    options?: { readonly afterId?: number; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, StateError>;
  /**
   * Events of the given types, oldest first. `newest` returns only the newest
   * `limit` of them (still oldest first).
   */
  readonly eventsOfType: (
    id: string,
    types: ReadonlyArray<RalphEvent["type"]>,
    options?: { readonly limit?: number; readonly newest?: boolean },
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, StateError>;
  readonly appendRaw: (
    id: string,
    iteration: number,
    line: string,
  ) => Effect.Effect<void, StateError>;
  readonly writeIteration: (id: string, record: IterationRecord) => Effect.Effect<void, StateError>;
  readonly addSteer: (
    id: string,
    kind: SteerKind,
    text: string,
  ) => Effect.Effect<number, StateError>;
  /** Pending steers for a run, oldest first, marked consumed at `iteration`. */
  readonly takeSteers: (
    id: string,
    iteration: number,
  ) => Effect.Effect<ReadonlyArray<Steer>, StateError>;
}

export class Store extends Context.Service<Store, StoreShape>()("ralph/Store") {}

export const defaultRoot = () => process.env.RALPH_HOME ?? `${os.homedir()}/.ralph/v2`;

export const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const isAlive = (pid: number): boolean => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Sortable, unique run id: `r<base36 ms><4 hex>`. Matches Beadsmith's id charset. */
export const newRunId = () =>
  `r${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0")}`;

// ------------------------------------------------------------- migrations

const migrations = {
  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pid INTEGER NOT NULL,
      harness TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      dir TEXT NOT NULL,
      prompt TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      marathon INTEGER NOT NULL,
      iteration_timeout_seconds INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_iteration INTEGER NOT NULL,
      stop_reason TEXT,
      bead_id TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX runs_name ON runs (name, started_at)`;
    yield* sql`CREATE TABLE iterations (
      run_id TEXT NOT NULL REFERENCES runs (id),
      iteration INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      session_id TEXT,
      attach_id TEXT,
      head_before TEXT,
      head_after TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL,
      last_assistant TEXT,
      error TEXT,
      PRIMARY KEY (run_id, iteration)
    )`;
    yield* sql`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs (id),
      iteration INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX events_run ON events (run_id, id)`;
    yield* sql`CREATE TABLE steers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs (id),
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_iteration INTEGER
    )`;
    yield* sql`CREATE INDEX steers_pending ON steers (run_id, consumed_at)`;
  }),
  "0002_modes": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'run'`;
    yield* sql`ALTER TABLE runs ADD COLUMN scope TEXT`;
    yield* sql`ALTER TABLE iterations ADD COLUMN validate_ok INTEGER`;
    yield* sql`ALTER TABLE iterations ADD COLUMN plan_open INTEGER`;
  }),
  "0003_callbacks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE runs ADD COLUMN callback_url TEXT`;
  }),
  /** Plan snapshots and observer summaries are events; find them without a scan. */
  "0004_event_types": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE INDEX events_run_type ON events (run_id, type, id)`;
  }),
};

// ------------------------------------------------------------- row codecs

const RunRow = Schema.Struct({
  ...Instance.fields,
  marathon: Schema.BooleanFromBit,
});
const decodeRun = Schema.decodeUnknownEffect(RunRow);
const IterationRow = Schema.Struct({
  ...IterationRecord.fields,
  validateOk: Schema.NullOr(Schema.BooleanFromBit),
});
const decodeIteration = Schema.decodeUnknownEffect(IterationRow);

/** Human-readable log line, same emoji vocabulary as the bash runner. */
export const formatLogLine = (e: RalphEvent): string | undefined => {
  const t = new Date(e.ts).toTimeString().slice(0, 8); // local time, like the bash runner
  switch (e.type) {
    case "run_started":
      return `[${t}] 🚀 Ralph '${e.instance}' started (run=${e.run}, harness=${e.harness}, model=${e.model ?? "default"}, mode=${e.mode}, max_runs=${e.maxIterations}, dir=${e.dir})`;
    case "iteration_started":
      return `[${t}] --- RUN ${e.iteration} ---`;
    case "session":
      return `[${t}] 🧵 session ${e.sessionId}${e.attachId === undefined ? "" : ` (${attachCommand(e.attachId)})`}`;
    case "assistant":
      return `💬 ${e.text}`;
    case "tool_call":
      return `🔧 ${e.name}: ${clip(e.input, 150)}`;
    case "tool_result":
      return `📋 ${e.isError ? "[error] " : ""}${clip(e.output, 200)}`;
    case "error":
      return `[${t}] ⚠️  ${e.kind}: ${clip(e.message, 300)}`;
    case "needs_input":
      return `[${t}] ✋ needs input: ${e.reason}`;
    case "harness_exit":
      return e.status === "ok"
        ? undefined
        : `[${t}] ⚠️  harness ${e.status}${e.detail === undefined ? "" : `: ${e.detail}`}`;
    case "steer_received":
      return `[${t}] 🧭 steer #${e.id} (${e.kind}): ${clip(e.text, 300)}`;
    case "iteration_finished":
      return `[${t}] --- RUN ${e.iteration} ${e.outcome.toUpperCase()} (${Math.round(e.durationMs / 1000)}s) ---`;
    case "validate":
      return e.ok
        ? `[${t}] ✅ validate passed (${e.results.map((r) => r.command).join(", ")})`
        : `[${t}] ❌ validate failed: ${e.results
            .filter((r) => r.exitCode !== 0)
            .map((r) => `${r.command} → ${r.exitCode === null ? "timeout" : `exit ${r.exitCode}`}`)
            .join(", ")}`;
    case "plan_status":
      return e.error !== undefined
        ? `[${t}] 🗺️  plan (${e.backend}): ${clip(e.error, 300)}`
        : `[${t}] 🗺️  plan (${e.backend}): ${e.open} open, ${e.actionable} ready, ${e.total} total${e.changed ? " (changed)" : ""}`;
    case "scope_violation":
      return `[${t}] 🚧 out-of-scope changes: ${clip(e.files.join(", "), 300)}${e.diffPath === undefined ? "" : ` (diff: ${e.diffPath})`}`;
    case "notice":
      return `[${t}] ℹ️  ${e.text}`;
    case "plan_updated": {
      const c = e.plan.counts;
      const doing = e.plan.items.filter((i) => i.status === "in_progress").map((i) => i.id);
      return `[${t}] 🗺️  ${e.final === true ? "final plan" : "plan updated"} (${e.plan.backend}): ${c.open} open, ${c.done} done${doing.length > 0 ? `, in progress: ${clip(doing.join(", "), 120)}` : ""}${e.plan.error === null ? "" : ` · read error: ${clip(e.plan.error, 200)}`}`;
    }
    case "activity_summary":
    case "iteration_summary": {
      const s = e.summary;
      const what = s.kind === "iteration" ? `iteration ${s.iteration} summary` : "now";
      return s.status === "ok"
        ? `[${t}] 👀 ${what}: ${clip(s.text, 600)}`
        : `[${t}] 👀 ${what}: (${s.status}${s.error === undefined ? "" : `: ${clip(s.error, 200)}`})`;
    }
    case "observer_status":
      return e.available === false
        ? `[${t}] 👀 observer ${e.model ?? ""} unavailable: ${e.error ?? "unknown"}`
        : `[${t}] 👀 observer: ${e.model ?? "?"}${e.error === null ? "" : ` (${e.error})`}`;
    case "rate_limit_sleep":
      return `[${t}] ⏳ Rate limited. Sleeping ${Math.round(e.seconds / 60)} minutes...`;
    case "run_finished":
      return `[${t}] 🛑 Ralph '${e.instance}' stopped after ${e.iterations} runs (${e.reason}).`;
    case "thinking":
    case "usage":
    case "turn_end":
      return undefined;
  }
};

export const makeStore = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    const runDir = (id: string) => p.join(root, "runs", id);
    const logPath = (id: string) => p.join(runDir(id), "log");
    const fail = (where: string) => (e: unknown) =>
      new StateError({ path: where, reason: e instanceof Error ? e.message : String(e) });
    const now = () => new Date().toISOString();

    const append = (file: string, data: string) =>
      fs.writeFileString(file, data, { flag: "a" }).pipe(Effect.mapError(fail(file)));

    const rowsToRuns = (rows: ReadonlyArray<unknown>) =>
      Effect.forEach(rows, (r) => decodeRun(r)).pipe(Effect.mapError(fail("runs")));

    const get = (nameOrId: string) =>
      sql`SELECT * FROM runs WHERE id = ${nameOrId}
          UNION ALL
          SELECT * FROM (SELECT * FROM runs WHERE name = ${nameOrId} ORDER BY started_at DESC LIMIT 1)
          LIMIT 1`.pipe(
        Effect.mapError(fail("runs")),
        Effect.flatMap(rowsToRuns),
        Effect.flatMap((runs) =>
          runs[0] === undefined
            ? Effect.fail(
                new StateError({ path: nameOrId, reason: "no such ralph (name or run id)" }),
              )
            : Effect.succeed(runs[0]),
        ),
      );

    const create = (inst: Instance) =>
      Effect.gen(function* () {
        if (!NAME_RE.test(inst.name)) {
          return yield* new StateError({
            path: inst.name,
            reason: "name must match [A-Za-z0-9._-]{1,100}",
          });
        }
        const live =
          yield* sql`SELECT * FROM runs WHERE name = ${inst.name} AND status = 'running'`.pipe(
            Effect.mapError(fail("runs")),
            Effect.flatMap(rowsToRuns),
          );
        const alive = live.find((r) => isAlive(r.pid));
        if (alive !== undefined) {
          return yield* new StateError({
            path: inst.name,
            reason: `'${inst.name}' is already running (run ${alive.id}, pid ${alive.pid})`,
          });
        }
        // Stale "running" rows for this name belong to a process that died without cleanup.
        yield* sql`UPDATE runs SET status = 'failed', stop_reason = 'crashed', updated_at = ${now()}
                   WHERE name = ${inst.name} AND status = 'running'`.pipe(
          Effect.mapError(fail("runs")),
        );
        yield* fs
          .makeDirectory(p.join(runDir(inst.id), "raw"), { recursive: true })
          .pipe(Effect.mapError(fail(runDir(inst.id))));
        yield* sql`INSERT INTO runs ${sql.insert({ ...inst, marathon: inst.marathon ? 1 : 0 })}`.pipe(
          Effect.mapError(fail("runs")),
        );
      });

    const update = (id: string, patch: InstancePatch) =>
      Object.keys(patch).length === 0
        ? Effect.void
        : sql`UPDATE runs SET ${sql.update({ ...patch, updatedAt: now() })} WHERE id = ${id}`.pipe(
            Effect.asVoid,
            Effect.mapError(fail(`runs/${id}`)),
          );

    const list = (options?: { readonly all?: boolean }) =>
      (options?.all === true
        ? sql`SELECT * FROM runs ORDER BY started_at DESC`
        : sql`SELECT r.* FROM runs r
              WHERE r.started_at = (SELECT MAX(started_at) FROM runs WHERE name = r.name)
              ORDER BY r.started_at DESC`
      ).pipe(Effect.mapError(fail("runs")), Effect.flatMap(rowsToRuns));

    const iterations = (id: string) =>
      sql`SELECT * FROM iterations WHERE run_id = ${id} ORDER BY iteration`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeIteration(r))),
        Effect.mapError(fail(`iterations/${id}`)),
      );

    const appendEvent = (e: RalphEvent) =>
      Effect.gen(function* () {
        const { ts, run, iteration, type } = e;
        yield* sql`INSERT INTO events ${sql.insert({ runId: run, iteration, ts, type, data: JSON.stringify(e) })}`.pipe(
          Effect.mapError(fail("events")),
        );
        const line = formatLogLine(e);
        if (line !== undefined) yield* append(logPath(run), `${line}\n`);
      });

    const events = (id: string, options?: { readonly afterId?: number; readonly limit?: number }) =>
      sql<{ readonly id: number; readonly data: string }>`
        SELECT id, data FROM events WHERE run_id = ${id} AND id > ${options?.afterId ?? 0}
        ORDER BY id LIMIT ${options?.limit ?? 1000}`.pipe(
        Effect.map((rows) =>
          rows.map((r) => ({ id: r.id, event: JSON.parse(r.data) as RalphEvent })),
        ),
        Effect.mapError(fail(`events/${id}`)),
      );

    const eventsOfType = (
      id: string,
      types: ReadonlyArray<RalphEvent["type"]>,
      options?: { readonly limit?: number; readonly newest?: boolean },
    ) =>
      (options?.newest === true
        ? sql<{ readonly id: number; readonly data: string }>`
            SELECT id, data FROM events WHERE run_id = ${id} AND ${sql.in("type", types)}
            ORDER BY id DESC LIMIT ${options?.limit ?? 1000}`
        : sql<{ readonly id: number; readonly data: string }>`
            SELECT id, data FROM events WHERE run_id = ${id} AND ${sql.in("type", types)}
            ORDER BY id LIMIT ${options?.limit ?? 1000}`
      ).pipe(
        Effect.map((rows) => {
          const out = rows.map((r) => ({ id: r.id, event: JSON.parse(r.data) as RalphEvent }));
          return options?.newest === true ? out.reverse() : out;
        }),
        Effect.mapError(fail(`events/${id}`)),
      );

    const appendRaw = (id: string, iteration: number, line: string) =>
      append(p.join(runDir(id), "raw", `${iteration}.jsonl`), `${line}\n`);

    const writeIteration = (id: string, rec: IterationRecord) =>
      sql`INSERT OR REPLACE INTO iterations ${sql.insert({
        runId: id,
        ...rec,
        validateOk: rec.validateOk === null ? null : rec.validateOk ? 1 : 0,
      })}`.pipe(Effect.asVoid, Effect.mapError(fail(`iterations/${id}`)));

    const addSteer = (id: string, kind: SteerKind, text: string) =>
      sql<{
        readonly id: number;
      }>`INSERT INTO steers ${sql.insert({ runId: id, kind, text, createdAt: now() })} RETURNING id`.pipe(
        Effect.map((rows) => rows[0]?.id ?? 0),
        Effect.mapError(fail(`steers/${id}`)),
      );

    const takeSteers = (id: string, iteration: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<Steer>`SELECT id, kind, text FROM steers
                                         WHERE run_id = ${id} AND consumed_at IS NULL ORDER BY id`;
            const last = rows.at(-1);
            if (last !== undefined) {
              yield* sql`UPDATE steers SET consumed_at = ${now()}, consumed_iteration = ${iteration}
                       WHERE run_id = ${id} AND consumed_at IS NULL AND id <= ${last.id}`;
            }
            return rows;
          }),
        )
        .pipe(Effect.mapError(fail(`steers/${id}`)));

    return Store.of({
      root,
      dbPath: p.join(root, "ralph.db"),
      runDir,
      logPath,
      create,
      update,
      get,
      list,
      iterations,
      appendEvent,
      events,
      eventsOfType,
      appendRaw,
      writeIteration,
      addSteer,
      takeSteers,
    });
  });

const sqliteLayer = (root: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
      return SqliteClient.layer({
        filename: `${root}/ralph.db`,
        busyTimeout: "10 seconds",
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel,
      });
    }),
  );

const migrationsLayer = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord(migrations),
});

/** Store + its SQLite client (migrated). Needs FileSystem and Path. */
export const layer = (root: string = defaultRoot()) =>
  Layer.effect(Store, makeStore(root)).pipe(
    Layer.provide(migrationsLayer),
    Layer.provideMerge(sqliteLayer(root)),
    Layer.orDie,
  );
