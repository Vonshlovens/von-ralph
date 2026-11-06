/** Helpers shared by CLI commands: detached launches and reproducible argv. */
import { Console, Effect, Option, Schedule } from "effect";
import { Argument } from "effect/cli";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type HarnessId, type RunMode, StateError, type StopReason } from "../domain.ts";
import { Store } from "../store.ts";

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

/** Re-exec this CLI detached from the terminal; early errors go to `<root>/launch/<name>.out`. */
export const spawnDetached = (argv: ReadonlyArray<string>, name: string, cwd: string) =>
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
    });
    child.unref();
    fs.closeSync(out);
    // Wait for the child to register its run (or die trying).
    const started = yield* store.get(name).pipe(
      Effect.flatMap((r) =>
        r.startedAt >= since
          ? Effect.succeed(r)
          : Effect.fail(new StateError({ path: name, reason: "not started" })),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
      Effect.option,
    );
    if (Option.isNone(started)) {
      const err = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").trim() : "";
      return yield* new StateError({
        path: name,
        reason: `did not start${err === "" ? "" : `:\n${err}`}`,
      });
    }
    const r = started.value;
    yield* Console.log(
      `🚀 ${r.name} started (${r.mode}, run ${r.id}, pid ${r.pid})\n   log ${store.logPath(r.id)}\n   watch: ralph-next watch ${r.name}`,
    );
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
}

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
  "--quiet",
  ...(r.mode === "run" ? [r.prompt] : []),
];

/** Process exit code for a finished run: 0 when it ended as intended. */
export const exitCodeFor = (reason: StopReason): number => {
  switch (reason) {
    case "interrupted":
      return 130;
    case "max_iterations":
    case "operator_stop":
    case "complete":
    case "plan_complete":
    case "plan_converged":
      return 0;
    // Ended on its own, but a human should look: distinguishable for schedulers.
    case "plan_exhausted":
    case "no_progress":
      return 3;
    default:
      return 1;
  }
};
