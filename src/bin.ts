#!/usr/bin/env node
import { attachCommand } from "./hc.ts";
/**
 * ralph: the Effect-based Ralph runner. Runs directly with Node's type
 * stripping: `node src/bin.ts …` (or the `bin/ralph` shim).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as fs from "node:fs";
import * as path from "node:path";
import { build, init, plan, reverse, sign, spec } from "./cli/process.ts";
import { report } from "./cli/report.ts";
import { schedule, serve } from "./cli/serve.ts";
import {
  autoName,
  callbackOf,
  exitCodeFor,
  nameArg,
  observerFlags,
  observerOf,
  restartArgv,
  runArgv,
  spawnDetached,
} from "./cli/shared.ts";
import { task } from "./cli/task.ts";
import { type HarnessId, type Instance, StateError, harnessIds } from "./domain.ts";
import { checkBinary } from "./harness.ts";
import { listLegacy } from "./legacy.ts";
import { defaults, runLoop } from "./loop.ts";
import { runPolicy } from "./modes.ts";
import { steerRun, stopRun } from "./control.ts";
import { harnesses } from "./registry.ts";
import * as StoreModule from "./store.ts";
import { VERSION } from "./server.ts";
import { NAME_RE, Store, formatLogLine, isAlive } from "./store.ts";

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
      Flag.withDescription("Agent harness in an hc terminal: claude, codex, opencode, gh"),
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
    callback: Flag.String("callback").pipe(
      Flag.withDescription(
        "POST a JSON summary to this URL when the run ends (e.g. n8n resumeUrl)",
      ),
      Flag.optional,
    ),
    ...observerFlags,
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
        callbackUrl: yield* callbackOf(a.callback),
      };
      if (a.detach) {
        yield* checkBinary(harness);
        return yield* spawnDetached(
          runArgv({
            ...cfg,
            harness: harness.id,
            mode: "run",
            scope: null,
            observer: !a.noObserver,
            observerIntervalSeconds: Option.getOrNull(a.observerInterval),
          }),
          name,
          cfg.dir,
        );
      }
      const { reason } = yield* runLoop({
        ...cfg,
        policy: runPolicy(cfg.prompt),
        rateLimitSleepSeconds: defaults.rateLimitSleepSeconds,
        pauseBetween: defaults.pauseBetween,
        maxConsecutiveFailures: defaults.maxConsecutiveFailures,
        echo: !a.quiet,
        observer: observerOf(a),
      });
      process.exitCode = exitCodeFor(reason);
    }),
).pipe(
  Command.withDescription(
    "Run a prompt in a loop, one fresh agent session per iteration (ends early on <promise>COMPLETE</promise>)",
  ),
);

const stateLabel = (r: Instance) => {
  if (r.status === "running") return isAlive(r.pid) ? "🟢 running" : "🔴 dead (run `ralph clean`)";
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
            `${r.name}  ${stateLabel(r)}  ${r.mode} · run ${r.id} · pid ${r.pid}`,
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
            `${l.name}  ${l.alive ? "🟢 running" : "🔴 dead"} (ralph-v1 bash loop)  pid ${l.pid}`,
            `  harness ${l.harness} · dir ${l.dir} · run ${l.currentRun}${max}`,
            `  log     ${l.logPath}`,
          ].join("\n"),
        );
      }
    }),
).pipe(Command.withDescription("List ralphs (plus any live ralph-v1 bash loops)"));

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
        `${r.name}  ${stateLabel(r)}  ${r.mode} · run ${r.id}\n  dir ${r.dir}\n  prompt:\n${r.prompt.replace(/^/gm, "    ")}\n`,
      );
      for (const i of its) {
        const moved =
          i.headBefore !== null && i.headAfter !== null && i.headBefore !== i.headAfter
            ? ` · HEAD ${i.headBefore.slice(0, 7)}→${i.headAfter.slice(0, 7)}`
            : "";
        const cost = i.costUsd === null ? "" : ` · $${i.costUsd.toFixed(3)}`;
        const attach = i.attachId === null ? "" : ` · ${attachCommand(i.attachId)}`;
        const val = i.validateOk === null ? "" : i.validateOk ? " · ✅ valid" : " · ❌ invalid";
        const planOpen = i.planOpen === null ? "" : ` · plan ${i.planOpen} open`;
        const err = i.error === null ? "" : `\n      ⚠️  ${i.error.slice(0, 200)}`;
        yield* Console.log(
          `  #${i.iteration} ${i.outcome.padEnd(12)} ${Math.round(i.durationMs / 1000)}s · in ${i.inputTokens} out ${i.outputTokens}${cost}${moved}${val}${planOpen}${attach}${err}`,
        );
      }
    }),
).pipe(Command.withDescription("Show a run and its iterations (outcomes, tokens, cost, commits)"));

const tailRun = (a: { readonly name: string; readonly lines: number; readonly follow: boolean }) =>
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
  });

const tail = Command.make(
  "tail",
  {
    name: nameArg,
    lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(50)),
    follow: Flag.Boolean("follow").pipe(Flag.withAlias("f"), Flag.withDefault(false)),
  },
  tailRun,
).pipe(Command.withDescription("Print a run's log; -f follows live events until it ends"));

const watch = Command.make(
  "watch",
  { name: nameArg, lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(20)) },
  (a) => tailRun({ ...a, follow: true }),
).pipe(
  Command.withDescription(
    "Follow a run live (tail -f): watching is how you learn what signs to add",
  ),
);

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
      const id = yield* steerRun(r, a.text);
      yield* Console.log(
        `🧭 queued steer #${id} for ${r.name}; it is added to the next iteration's prompt`,
      );
    }),
).pipe(
  Command.withDescription("Queue a note for the next iteration (consumed between iterations)"),
);

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
      yield* Effect.forEach(
        targets,
        (r) => stopRun(r, a.graceful).pipe(Effect.flatMap((res) => Console.log(res.message))),
        { concurrency: "unbounded", discard: true },
      );
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
      // Process modes re-read ralph.toml and the prompts; run mode replays the prompt.
      const argv = yield* restartArgv(
        r,
        Option.getOrElse(a.max, () => r.maxIterations),
      );
      yield* spawnDetached(argv, r.name, r.dir);
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
      const missing = yield* checkBinary(h).pipe(
        Effect.as(""),
        Effect.catchTag("HarnessUnavailable", (error) => Effect.succeed(error.message)),
      );
      const ok = missing === "";
      yield* Console.log(
        `${ok ? "✅" : "❌"} ${id.padEnd(9)} ${h.binary.padEnd(9)} default model ${h.defaultModel ?? "(cli default)"}${ok ? "" : `  — ${missing}`}`,
      );
    }
    yield* Console.log(`state: ${store.dbPath}`);
  }),
).pipe(Command.withDescription("Check which harness CLIs are installed"));

const root = Command.make("ralph").pipe(
  Command.withDescription("Headless agent loops (Ralph Wiggum technique)"),
  Command.withSubcommands([
    init,
    spec,
    reverse,
    plan,
    build,
    run,
    task,
    status,
    show,
    report,
    tail,
    watch,
    steer,
    sign,
    stop,
    restart,
    clean,
    doctor,
    serve,
    schedule,
  ]),
);

const MainLive = StoreModule.layer().pipe(Layer.provideMerge(NodeServices.layer));

/** Our own errors are expected outcomes: one clean line on stderr, exit 1. */
const report1 = (e: { readonly message: string }) =>
  Effect.sync(() => {
    process.stderr.write(`ralph: ${e.message}\n`);
    process.exitCode = 1;
  });

Command.run(root, { version: VERSION }).pipe(
  Effect.catchTags({
    StateError: report1,
    HarnessUnavailable: report1,
  }),
  Effect.provide(MainLive),
  NodeRuntime.runMain,
);
