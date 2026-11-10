/** Helpers shared by CLI commands: detached launches and reproducible argv. */
import { Console, Effect, Option, Schedule } from "effect";
import { Argument, Flag } from "effect/cli";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type HarnessId, type Instance, type RunMode, StateError } from "../domain.ts";
export { exitCodeFor } from "../exitCodes.ts";
import { isCallbackUrl } from "../callback.ts";
import { Store } from "../store.ts";
import type { ObserverConfig } from "../observer.ts";
import { observerEnvDisabled, realObserver } from "../observer.ts";

/** `--no-observer` / `--observer-interval`: the background summaries (Claude Haiku 5.5). */
export const observerFlags = {
  noObserver: Flag.Boolean("no-observer").pipe(
    Flag.withDescription("Do not run the background observer (Claude Haiku 5.5 summaries)"),
    Flag.withDefault(false),
  ),
  observerInterval: Flag.Int("observer-interval").pipe(
    Flag.withDescription(
      "Seconds between current-activity summaries (default 60; 0 = end-of-iteration summaries only)",
    ),
    Flag.optional,
  ),
};

/** The observer setting for runLoop: undefined = default (on for real harnesses). */
export const observerOf = (a: {
  readonly noObserver: boolean;
  readonly observerInterval: Option.Option<number>;
}): ObserverConfig | false | undefined =>
  a.noObserver || observerEnvDisabled()
    ? false
    : Option.isNone(a.observerInterval)
      ? undefined
      : realObserver({ activityIntervalMs: Math.max(0, a.observerInterval.value) * 1000 });

/** The CLI entry point (re-executed for --detach). */
export const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin.ts");

export const nameArg = Argument.String("name").pipe(
  Argument.withDescription("Ralph name (most recent run) or run id"),
);

export const autoName = () =>
  `ralph-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.pid}`;

/** A valid ralph name derived from free text (e.g. `build-<repo dir>`). */
export const safeName = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "ralph";

/**
 * Re-exec this CLI detached from the terminal and wait for it to register its
 * run; early errors go to `<root>/launch/<name>.out`.
 */
export const launchDetached = (argv: ReadonlyArray<string>, name: string, cwd: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const launchDir = path.join(store.root, "launch");
    fs.mkdirSync(launchDir, { recursive: true });
    const outPath = path.join(launchDir, `${name}.out`);
    const out = fs.openSync(outPath, "w");
    const since = new Date().toISOString();
    const child = spawn(process.execPath, [...process.execArgv, SCRIPT, ...argv], {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, RALPH_HOME: store.root },
    });
    child.unref();
    fs.closeSync(out);
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const started = yield* store.get(name).pipe(
      Effect.flatMap((r) =>
        r.startedAt >= since
          ? Effect.succeed(r)
          : Effect.fail(new StateError({ path: name, reason: "not started" })),
      ),
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        times: 40,
        while: () => !exited,
      }),
      Effect.option,
    );
    if (Option.isNone(started)) {
      const err = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").trim() : "";
      return yield* new StateError({
        path: name,
        reason: `did not start${err === "" ? "" : `:\n${err}`}`,
      });
    }
    return started.value;
  });

/** `launchDetached`, then tell the operator where to look. */
export const spawnDetached = (argv: ReadonlyArray<string>, name: string, cwd: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const r: Instance = yield* launchDetached(argv, name, cwd);
    yield* Console.log(
      `🚀 ${r.name} started (${r.mode}, run ${r.id}, pid ${r.pid})\n   log ${store.logPath(r.id)}\n   watch: ralph watch ${r.name}`,
    );
  });

/** Validate an optional `--callback` URL. */
export const callbackOf = (o: Option.Option<string>) =>
  Option.match(o, {
    onNone: () => Effect.succeed(null),
    onSome: (url) =>
      isCallbackUrl(url)
        ? Effect.succeed(url)
        : Effect.fail(new StateError({ path: url, reason: "--callback must be an http(s) URL" })),
  });

export interface RunSpec {
  readonly mode: RunMode;
  readonly name: string;
  readonly prompt: string;
  readonly dir: string;
  readonly harness: HarnessId;
  readonly model: string | null;
  readonly effort: string | null;
  readonly maxIterations: number;
  readonly marathon: boolean;
  readonly iterationTimeoutSeconds: number;
  readonly beadId: string | null;
  readonly scope: string | null;
  readonly callbackUrl: string | null;
  /** false = --no-observer; undefined = default */
  readonly observer?: boolean | undefined;
  readonly observerIntervalSeconds?: number | null | undefined;
}

/**
 * The observer setting a run was STARTED with: its first `observer_status`
 * event (later ones report health, e.g. "unavailable"). Runs from before the
 * observer have none → default.
 */
export const savedObserver = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const first = (yield* store.eventsOfType(runId, ["observer_status"], { limit: 1 }))[0]?.event;
    if (first?.type !== "observer_status") return {};
    if (!first.enabled) return { observer: false };
    return {
      observer: true,
      observerIntervalSeconds: first.activityIntervalSeconds ?? null,
    };
  });

/** argv for `restart`: the run's settings, its original observer setting, a new max. */
export const restartArgv = (r: Instance, maxIterations: number) =>
  savedObserver(r.id).pipe(Effect.map((o) => runArgv({ ...r, maxIterations, ...o })));

/** CLI args that reproduce a run's configuration (used by --detach and restart). */
export const runArgv = (r: RunSpec): Array<string> => [
  r.mode,
  "--name",
  r.name,
  "--dir",
  r.dir,
  "--harness",
  r.harness,
  ...(r.model === null ? [] : ["--model", r.model]),
  ...(r.effort === null ? [] : ["--effort", r.effort]),
  "--max",
  String(r.maxIterations),
  "--timeout",
  String(Math.round(r.iterationTimeoutSeconds / 60)),
  ...(r.marathon ? ["--marathon"] : []),
  ...(r.beadId === null ? [] : ["--bead", r.beadId]),
  ...(r.mode !== "run" && r.scope !== null ? ["--scope", r.scope] : []),
  ...(r.callbackUrl === null ? [] : ["--callback", r.callbackUrl]),
  ...(r.observer === false ? ["--no-observer"] : []),
  ...(r.observerIntervalSeconds == null
    ? []
    : ["--observer-interval", String(r.observerIntervalSeconds)]),
  "--quiet",
  ...(r.mode === "run" ? [r.prompt] : []),
];
