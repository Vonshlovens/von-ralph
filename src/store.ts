/**
 * Versioned instance state under `$RALPH_HOME` (default `~/.ralph/v2`).
 *
 *   instances/<name>/instance.json          Instance (schema v1)
 *   instances/<name>/events.jsonl           RalphEvent per line
 *   instances/<name>/log                    human-readable log (emoji format)
 *   instances/<name>/iterations/<n>.json    IterationRecord
 *   instances/<name>/raw/<n>.jsonl          raw harness output / transcript lines
 *
 * The legacy bash runner's `~/.ralph/{logs,pids}` are untouched.
 */
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as os from "node:os";
import { Instance, IterationRecord, type RalphEvent, StateError, clip } from "./domain.ts";

export interface StoreShape {
  readonly root: string;
  readonly instanceDir: (name: string) => string;
  readonly logPath: (name: string) => string;
  readonly create: (instance: Instance) => Effect.Effect<void, StateError>;
  readonly writeInstance: (instance: Instance) => Effect.Effect<void, StateError>;
  readonly readInstance: (name: string) => Effect.Effect<Instance, StateError>;
  readonly list: Effect.Effect<ReadonlyArray<Instance>, StateError>;
  readonly appendEvent: (event: RalphEvent) => Effect.Effect<void, StateError>;
  readonly appendRaw: (
    name: string,
    iteration: number,
    line: string,
  ) => Effect.Effect<void, StateError>;
  readonly writeIteration: (
    name: string,
    record: IterationRecord,
  ) => Effect.Effect<void, StateError>;
}

export class Store extends Context.Service<Store, StoreShape>()("ralph/Store") {}

export const defaultRoot = () => process.env.RALPH_HOME ?? `${os.homedir()}/.ralph/v2`;

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const InstanceJson = Schema.fromJsonString(Instance);
const IterationJson = Schema.fromJsonString(IterationRecord);

/** Human-readable log line, same emoji vocabulary as the bash runner. */
export const formatLogLine = (e: RalphEvent): string | undefined => {
  const t = new Date(e.ts).toTimeString().slice(0, 8); // local time, like the bash runner
  switch (e.type) {
    case "run_started":
      return `[${t}] 🚀 Ralph '${e.instance}' started (harness=${e.harness}, model=${e.model ?? "default"}, max_runs=${e.maxIterations}, dir=${e.dir})`;
    case "iteration_started":
      return `[${t}] --- RUN ${e.iteration} ---`;
    case "session":
      return `[${t}] 🧵 session ${e.sessionId}${e.attachId === undefined ? "" : ` (claude attach ${e.attachId})`}`;
    case "assistant":
      return `💬 ${e.text}`;
    case "thinking":
      return undefined;
    case "tool_call":
      return `🔧 ${e.name}: ${clip(e.input, 150)}`;
    case "tool_result":
      return `📋 ${e.isError ? "[error] " : ""}${clip(e.output, 200)}`;
    case "usage":
    case "turn_end":
      return undefined;
    case "error":
      return `[${t}] ⚠️  ${e.kind}: ${clip(e.message, 300)}`;
    case "needs_input":
      return `[${t}] ✋ needs input: ${e.reason}`;
    case "harness_exit":
      return e.status === "ok"
        ? undefined
        : `[${t}] ⚠️  harness ${e.status}${e.detail === undefined ? "" : `: ${e.detail}`}`;
    case "iteration_finished":
      return `[${t}] --- RUN ${e.iteration} ${e.outcome.toUpperCase()} (${Math.round(e.durationMs / 1000)}s) ---`;
    case "rate_limit_sleep":
      return `[${t}] ⏳ Rate limited. Sleeping ${Math.round(e.seconds / 60)} minutes...`;
    case "run_finished":
      return `[${t}] 🛑 Ralph '${e.instance}' stopped after ${e.iterations} runs (${e.reason}).`;
  }
};

export const makeStore = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    const instancesDir = p.join(root, "instances");
    const instanceDir = (name: string) => p.join(instancesDir, name);
    const logPath = (name: string) => p.join(instanceDir(name), "log");
    const err = (path: string) => (e: unknown) =>
      new StateError({ path, reason: e instanceof Error ? e.message : String(e) });

    const writeAtomic = (file: string, data: string) =>
      Effect.gen(function* () {
        const tmp = `${file}.tmp-${process.pid}`;
        yield* fs.writeFileString(tmp, data);
        yield* fs.rename(tmp, file);
      }).pipe(Effect.mapError(err(file)));

    const append = (file: string, data: string) =>
      fs.writeFileString(file, data, { flag: "a" }).pipe(Effect.mapError(err(file)));

    const writeInstance = (inst: Instance) =>
      Schema.encodeEffect(InstanceJson)(inst).pipe(
        Effect.mapError(err(instanceDir(inst.name))),
        Effect.flatMap((json) =>
          writeAtomic(p.join(instanceDir(inst.name), "instance.json"), `${json}\n`),
        ),
      );

    const readInstance = (name: string) => {
      const file = p.join(instanceDir(name), "instance.json");
      return fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(InstanceJson)), Effect.mapError(err(file)));
    };

    const create = (inst: Instance) =>
      Effect.gen(function* () {
        if (!NAME_RE.test(inst.name))
          return yield* new StateError({
            path: inst.name,
            reason: "name must match [A-Za-z0-9._-]{1,100}",
          });
        const dir = instanceDir(inst.name);
        const existing = yield* readInstance(inst.name).pipe(Effect.option);
        if (
          existing._tag === "Some" &&
          existing.value.status === "running" &&
          isAlive(existing.value.pid)
        ) {
          return yield* new StateError({
            path: dir,
            reason: `instance '${inst.name}' is already running (pid ${existing.value.pid})`,
          });
        }
        yield* fs
          .makeDirectory(p.join(dir, "iterations"), { recursive: true })
          .pipe(Effect.mapError(err(dir)));
        yield* fs
          .makeDirectory(p.join(dir, "raw"), { recursive: true })
          .pipe(Effect.mapError(err(dir)));
        yield* writeInstance(inst);
      });

    const list = Effect.gen(function* () {
      const exists = yield* fs.exists(instancesDir).pipe(Effect.mapError(err(instancesDir)));
      if (!exists) return [];
      const names = yield* fs.readDirectory(instancesDir).pipe(Effect.mapError(err(instancesDir)));
      const out: Array<Instance> = [];
      for (const n of names.toSorted()) {
        const inst = yield* readInstance(n).pipe(Effect.option);
        if (inst._tag === "Some") out.push(inst.value);
      }
      return out;
    });

    const appendEvent = (e: RalphEvent) =>
      Effect.gen(function* () {
        yield* append(p.join(instanceDir(e.instance), "events.jsonl"), `${JSON.stringify(e)}\n`);
        const line = formatLogLine(e);
        if (line !== undefined) yield* append(logPath(e.instance), `${line}\n`);
      });

    const appendRaw = (name: string, iteration: number, line: string) =>
      append(p.join(instanceDir(name), "raw", `${iteration}.jsonl`), `${line}\n`);

    const writeIteration = (name: string, rec: IterationRecord) =>
      Schema.encodeEffect(IterationJson)(rec).pipe(
        Effect.mapError(err(instanceDir(name))),
        Effect.flatMap((json) =>
          writeAtomic(
            p.join(instanceDir(name), "iterations", `${rec.iteration}.json`),
            `${json}\n`,
          ),
        ),
      );

    return Store.of({
      root,
      instanceDir,
      logPath,
      create,
      writeInstance,
      readInstance,
      list,
      appendEvent,
      appendRaw,
      writeIteration,
    });
  });

export const layer = (root: string = defaultRoot()) => Layer.effect(Store, makeStore(root));
