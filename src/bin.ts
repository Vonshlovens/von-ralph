#!/usr/bin/env node
/**
 * ralph-next: the Effect-based Ralph runner. Runs directly with Node's type
 * stripping: `node src/bin.ts …` (or the `bin/ralph-next` shim).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Option, Schedule } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type HarnessId, type Instance, StateError, harnessIds } from "./domain.ts";
import { checkBinary } from "./harness.ts";
import { listLegacy } from "./legacy.ts";
import { defaults, runLoop } from "./loop.ts";
import { harnesses } from "./registry.ts";
import * as StoreModule from "./store.ts";
import { NAME_RE, Store, formatLogLine, isAlive } from "./store.ts";

const VERSION = "0.3.0";
const SCRIPT = fileURLToPath(import.meta.url);

const nameArg = Argument.String("name").pipe(
  Argument.withDescription("Ralph name (most recent run) or run id"),
);

const autoName = () =>
  `ralph-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.pid}`;

/** Re-exec this CLI detached from the terminal; early errors go to `<root>/launch/<name>.out`. */
const spawnDetached = (argv: ReadonlyArray<string>, name: string, cwd: string) =>
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
      `🚀 ${r.name} started (run ${r.id}, pid ${r.pid})\n   log ${store.logPath(r.id)}`,
    );
  });

/** CLI args that reproduce a run's configuration (used by --detach and restart). */
const runArgv = (r: {
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
}): Array<string> => [
  "run",
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
  "--quiet",
  r.prompt,
];

const run = Command.make(
  "run",
  {
    prompt: Argument.String("prompt").pipe(
      Argument.withDescription("Prompt sent each iteration (fresh context every time)"),
    ),
    name: Flag.String("name").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("Ralph name (default: ralph-<timestamp>)"),
      Flag.optional,
    ),
    dir: Flag.String("dir").pipe(
      Flag.withAlias("d"),
      Flag.withDescription("Working directory (default: cwd)"),
      Flag.optional,
    ),
    harness: Flag.Literals("harness", harnessIds).pipe(
      Flag.withAlias("H"),
      Flag.withDescription(
        "Agent harness: claude (Claude Code background session), codex, opencode, gh",
      ),
      Flag.withDefault("claude" as HarnessId),
    ),
    model: Flag.String("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Model (default depends on harness)"),
      Flag.optional,
    ),
    effort: Flag.String("effort").pipe(
      Flag.withAlias("e"),
      Flag.withDescription("Reasoning effort (harness-specific; default depends on harness)"),
      Flag.optional,
    ),
    max: Flag.Int("max").pipe(
      Flag.withAlias("N"),
      Flag.withDescription("Max iterations, 0 = unlimited"),
      Flag.withDefault(0),
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Per-iteration timeout in minutes, 0 = none"),
      Flag.withDefault(defaults.iterationTimeoutSeconds / 60),
    ),
    marathon: Flag.Boolean("marathon").pipe(
      Flag.withDescription("On rate limit, sleep 30 min and continue instead of stopping"),
      Flag.withDefault(false),
    ),
    detach: Flag.Boolean("detach").pipe(
      Flag.withDescription("Run in the background (survives the terminal); prints the run id"),
      Flag.withDefault(false),
    ),
    quiet: Flag.Boolean("quiet").pipe(
      Flag.withAlias("q"),
      Flag.withDescription("Do not echo the log to stdout"),
      Flag.withDefault(false),
    ),
    bead: Flag.String("bead").pipe(
      Flag.withDescription("Beads issue id this run works on (recorded in metadata)"),
      Flag.optional,
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const harness = harnesses[a.harness];
      const name = Option.getOrElse(a.name, autoName);
      if (!NAME_RE.test(name)) {
        return yield* new StateError({
          path: name,
          reason: "name must match [A-Za-z0-9._-]{1,100}",
        });
      }
      const cfg = {
        name,
        harness,
        model: Option.getOrElse(a.model, () => harness.defaultModel),
        effort: Option.getOrElse(a.effort, () => harness.defaultEffort) ?? null,
        dir: path.resolve(Option.getOrElse(a.dir, () => process.cwd())),
        prompt: a.prompt,
        maxIterations: a.max,
        marathon: a.marathon,
        iterationTimeoutSeconds: a.timeout * 60,
        beadId: Option.getOrNull(a.bead),
      };
      if (a.detach) {
        yield* checkBinary(harness);
        return yield* spawnDetached(runArgv({ ...cfg, harness: harness.id }), name, cfg.dir);
      }
      const { reason } = yield* runLoop({
        ...cfg,
        rateLimitSleepSeconds: defaults.rateLimitSleepSeconds,
        pauseBetween: defaults.pauseBetween,
        maxConsecutiveFailures: defaults.maxConsecutiveFailures,
        echo: !a.quiet,
      });
      if (reason !== "max_iterations" && reason !== "operator_stop") {
        process.exitCode = reason === "interrupted" ? 130 : 1;
      }
    }),
).pipe(Command.withDescription("Run a prompt in a loop, one fresh agent session per iteration"));

const stateLabel = (r: Instance) => {
  if (r.status === "running")
    return isAlive(r.pid) ? "🟢 running" : "🔴 dead (run `ralph-next clean`)";
  return `⚪ ${r.status}${r.stopReason === null ? "" : ` (${r.stopReason})`}`;
};

const status = Command.make(
  "status",
  {
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Every run, not just the latest per name"),
      Flag.withDefault(false),
    ),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const runs = yield* store.list({ all: a.all });
      const rows = yield* Effect.forEach(runs, (r) =>
        store.iterations(r.id).pipe(
          Effect.map((its) => ({
            ...r,
            alive: r.status === "running" && isAlive(r.pid),
            lastOutcome: its.at(-1)?.outcome ?? null,
            costUsd: its.reduce((s, i) => s + (i.costUsd ?? 0), 0),
            logPath: store.logPath(r.id),
          })),
        ),
      );
      const legacy = listLegacy().filter((l) => l.alive || a.all);
      if (a.json) return yield* Console.log(JSON.stringify({ runs: rows, legacy }, null, 2));
      if (rows.length === 0 && legacy.length === 0) return yield* Console.log("No ralphs.");
      for (const r of rows) {
        const model = r.model ?? "(cli default)";
        const effort = r.effort === null ? "" : ` · effort ${r.effort}`;
        const bead = r.beadId === null ? "" : ` · bead ${r.beadId}`;
        const max = r.maxIterations > 0 ? `/${r.maxIterations}` : "";
        const last = r.lastOutcome === null ? "" : ` · last ${r.lastOutcome}`;
        const cost = r.costUsd > 0 ? ` · $${r.costUsd.toFixed(2)}` : "";
        const prompt = r.prompt.replace(/\s+/g, " ");
        yield* Console.log(
          [
            `${r.name}  ${stateLabel(r)}  run ${r.id} · pid ${r.pid}`,
            `  harness ${r.harness} · model ${model}${effort}${bead}`,
            `  dir     ${r.dir}`,
            `  iter    ${r.currentIteration}${max}${last}${cost} · started ${r.startedAt}`,
            `  prompt  ${prompt.slice(0, 100)}${prompt.length > 100 ? "…" : ""}`,
            `  log     ${r.logPath}`,
          ].join("\n"),
        );
      }
      for (const l of legacy) {
        const max = l.maxRuns > 0 ? `/${l.maxRuns}` : "";
        yield* Console.log(
          [
            `${l.name}  ${l.alive ? "🟢 running" : "🔴 dead"} (legacy bash ralph)  pid ${l.pid}`,
            `  harness ${l.harness} · dir ${l.dir} · run ${l.currentRun}${max}`,
            `  log     ${l.logPath}`,
          ].join("\n"),
        );
      }
    }),
).pipe(Command.withDescription("List ralphs (new runner, plus live legacy bash ralphs)"));

const show = Command.make(
  "show",
  { name: nameArg, json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const r = yield* store.get(a.name);
      const its = yield* store.iterations(r.id);
      if (a.json) {
        const out = {
          run: r,
          iterations: its,
          logPath: store.logPath(r.id),
          runDir: store.runDir(r.id),
        };
        return yield* Console.log(JSON.stringify(out, null, 2));
      }
      yield* Console.log(
        `${r.name}  ${stateLabel(r)}  run ${r.id}\n  dir ${r.dir}\n  prompt:\n${r.prompt.replace(/^/gm, "    ")}\n`,
      );
      for (const i of its) {
        const moved =
          i.headBefore !== null && i.headAfter !== null && i.headBefore !== i.headAfter
            ? ` · HEAD ${i.headBefore.slice(0, 7)}→${i.headAfter.slice(0, 7)}`
            : "";
        const cost = i.costUsd === null ? "" : ` · $${i.costUsd.toFixed(3)}`;
        const attach = i.attachId === null ? "" : ` · claude attach ${i.attachId}`;
        const err = i.error === null ? "" : `\n      ⚠️  ${i.error.slice(0, 200)}`;
        yield* Console.log(
          `  #${i.iteration} ${i.outcome.padEnd(12)} ${Math.round(i.durationMs / 1000)}s · in ${i.inputTokens} out ${i.outputTokens}${cost}${moved}${attach}${err}`,
        );
      }
    }),
).pipe(Command.withDescription("Show a run and its iterations (outcomes, tokens, cost, commits)"));

const tail = Command.make(
  "tail",
  {
    name: nameArg,
    lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(50)),
    follow: Flag.Boolean("follow").pipe(Flag.withAlias("f"), Flag.withDefault(false)),
  },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const r = yield* store.get(a.name);
      const file = store.logPath(r.id);
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      yield* Console.log(
        text
          .split("\n")
          .filter((l) => l !== "")
          .slice(-a.lines)
          .join("\n"),
      );
      if (!a.follow) return;
      // Follow the event stream until the run ends.
      let after = (yield* store.events(r.id, { limit: 1_000_000 })).at(-1)?.id ?? 0;
      while (true) {
        yield* Effect.sleep("1 second");
        for (const e of yield* store.events(r.id, { afterId: after })) {
          after = e.id;
          const line = formatLogLine(e.event);
          if (line !== undefined) yield* Console.log(line);
          if (e.event.type === "run_finished") return;
        }
        const cur = yield* store.get(r.id);
        if (cur.status === "running" && !isAlive(cur.pid)) {
          return yield* Console.log("🔴 process is gone");
        }
      }
    }),
).pipe(Command.withDescription("Print a run's log; -f follows live events until it ends"));

const steer = Command.make(
  "steer",
  {
    name: nameArg,
    text: Argument.String("text").pipe(
      Argument.withDescription("Note appended to the next iteration's prompt"),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const r = yield* store.get(a.name);
      if (r.status !== "running") {
        return yield* new StateError({ path: a.name, reason: `run ${r.id} is ${r.status}` });
      }
      const id = yield* store.addSteer(r.id, "note", a.text);
      yield* Console.log(
        `🧭 queued steer #${id} for ${r.name}; it is added to the next iteration's prompt`,
      );
    }),
).pipe(
  Command.withDescription("Queue a note for the next iteration (consumed between iterations)"),
);

const stopOne = (r: Instance, graceful: boolean) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (r.status !== "running") return yield* Console.log(`${r.name} is not running (${r.status})`);
    if (!isAlive(r.pid)) {
      yield* store.update(r.id, { status: "failed", stopReason: "crashed" });
      return yield* Console.log(`${r.name}: process ${r.pid} was already gone (marked crashed)`);
    }
    if (graceful) {
      yield* store.addSteer(r.id, "stop", "stop requested by operator");
      return yield* Console.log(`🧭 ${r.name} will stop after the current iteration`);
    }
    process.kill(r.pid, "SIGTERM");
    // The runner stops its agent session/process and records `stopped`; give it time.
    const done = yield* store.get(r.id).pipe(
      Effect.flatMap((cur) =>
        cur.status === "running" && isAlive(r.pid)
          ? Effect.fail(new StateError({ path: r.id, reason: "still running" }))
          : Effect.succeed(cur),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
      Effect.option,
    );
    if (Option.isNone(done)) {
      if (isAlive(r.pid)) process.kill(r.pid, "SIGKILL");
      yield* store.update(r.id, { status: "failed", stopReason: "crashed" });
      return yield* Console.log(`⚠️  ${r.name} did not stop within 20s; killed (pid ${r.pid})`);
    }
    yield* Console.log(`🛑 ${r.name} stopped`);
  });

const stop = Command.make(
  "stop",
  {
    name: Argument.String("name").pipe(Argument.withDescription("Ralph name, run id, or 'all'")),
    graceful: Flag.Boolean("graceful").pipe(
      Flag.withAlias("g"),
      Flag.withDescription("Let the current iteration finish, then stop"),
      Flag.withDefault(false),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const targets =
        a.name === "all"
          ? (yield* store.list()).filter((r) => r.status === "running")
          : [yield* store.get(a.name)];
      if (targets.length === 0) return yield* Console.log("Nothing running.");
      yield* Effect.forEach(targets, (r) => stopOne(r, a.graceful), {
        concurrency: "unbounded",
        discard: true,
      });
    }),
).pipe(Command.withDescription("Stop a ralph (now, or --graceful after the current iteration)"));

const restart = Command.make(
  "restart",
  {
    name: nameArg,
    max: Flag.Int("max").pipe(
      Flag.withAlias("N"),
      Flag.withDescription("New max iterations (default: same)"),
      Flag.optional,
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const r = yield* store.get(a.name);
      if (r.status === "running" && isAlive(r.pid)) {
        return yield* new StateError({
          path: r.name,
          reason: `still running (pid ${r.pid}); stop it first`,
        });
      }
      yield* checkBinary(harnesses[r.harness]);
      const cfg = { ...r, maxIterations: Option.getOrElse(a.max, () => r.maxIterations) };
      yield* spawnDetached(runArgv(cfg), r.name, r.dir);
    }),
).pipe(Command.withDescription("Start a new run with a previous run's settings (detached)"));

const clean = Command.make("clean", {}, () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const dead = (yield* store.list({ all: true })).filter(
      (r) => r.status === "running" && !isAlive(r.pid),
    );
    for (const r of dead) {
      yield* store.update(r.id, { status: "failed", stopReason: "crashed" });
      yield* Console.log(`  marked crashed: ${r.name} (run ${r.id})`);
    }
    if (dead.length === 0) yield* Console.log("Nothing to clean.");
  }),
).pipe(Command.withDescription("Mark runs whose process died as crashed"));

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const store = yield* Store;
    for (const id of harnessIds) {
      const h = harnesses[id];
      const ok = yield* checkBinary(h).pipe(
        Effect.as(true),
        Effect.catchTag("HarnessUnavailable", () => Effect.succeed(false)),
      );
      yield* Console.log(
        `${ok ? "✅" : "❌"} ${id.padEnd(9)} ${h.binary.padEnd(9)} default model ${h.defaultModel ?? "(cli default)"}${ok ? "" : `  — ${h.installHint}`}`,
      );
    }
    yield* Console.log(`state: ${store.dbPath}`);
  }),
).pipe(Command.withDescription("Check which harness CLIs are installed"));

const root = Command.make("ralph-next").pipe(
  Command.withDescription("Headless agent loops (Ralph Wiggum technique)"),
  Command.withSubcommands([run, status, show, tail, steer, stop, restart, clean, doctor]),
);

const MainLive = StoreModule.layer().pipe(Layer.provideMerge(NodeServices.layer));

Command.run(root, { version: VERSION }).pipe(Effect.provide(MainLive), NodeRuntime.runMain);
