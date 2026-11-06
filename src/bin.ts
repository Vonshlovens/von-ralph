#!/usr/bin/env node
/**
 * ralph-next: the Effect-based Ralph runner (M1). Runs directly with Node's
 * type stripping: `node src/bin.ts …` (or the `bin/ralph-next` shim).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { type HarnessId, harnessIds } from "./domain.ts";
import { checkBinary } from "./harness.ts";
import { defaults, runLoop } from "./loop.ts";
import { harnesses } from "./registry.ts";
import * as StoreModule from "./store.ts";
import { Store, isAlive } from "./store.ts";

const VERSION = "0.2.0";

const harnessFlag = Flag.Literals("harness", harnessIds).pipe(
  Flag.withAlias("H"),
  Flag.withDescription(
    "Agent harness: claude (Claude Code background session), claude-print (claude -p), codex, opencode, gh",
  ),
  Flag.withDefault("claude" as HarnessId),
);

const run = Command.make(
  "run",
  {
    prompt: Argument.String("prompt").pipe(
      Argument.withDescription("Prompt sent each iteration (fresh context every time)"),
    ),
    name: Flag.String("name").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("Instance name (default: ralph-<timestamp>)"),
      Flag.optional,
    ),
    dir: Flag.String("dir").pipe(
      Flag.withAlias("d"),
      Flag.withDescription("Working directory (default: cwd)"),
      Flag.optional,
    ),
    harness: harnessFlag,
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
    marathon: Flag.Boolean("marathon").pipe(
      Flag.withDescription("On rate limit, sleep 30 min and continue instead of stopping"),
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
      const name = Option.getOrElse(
        a.name,
        () => `ralph-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.pid}`,
      );
      const reason = yield* runLoop({
        name,
        harness,
        model: Option.getOrElse(a.model, () => harness.defaultModel),
        effort: Option.getOrElse(a.effort, () => harness.defaultEffort) ?? null,
        dir: Option.getOrElse(a.dir, () => process.cwd()),
        prompt: a.prompt,
        maxIterations: a.max,
        marathon: a.marathon,
        rateLimitSleepSeconds: defaults.rateLimitSleepSeconds,
        pauseBetween: defaults.pauseBetween,
        maxConsecutiveFailures: defaults.maxConsecutiveFailures,
        echo: !a.quiet,
        beadId: Option.getOrNull(a.bead),
      });
      if (reason !== "max_iterations") process.exitCode = reason === "interrupted" ? 130 : 1;
    }),
).pipe(Command.withDescription("Run a prompt in a loop, one fresh agent session per iteration"));

const status = Command.make(
  "status",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const list = yield* store.list;
      const rows = list.map((i) => ({ ...i, alive: i.status === "running" && isAlive(i.pid) }));
      if (a.json) return yield* Console.log(JSON.stringify(rows, null, 2));
      if (rows.length === 0) return yield* Console.log("No ralph instances.");
      for (const r of rows) {
        const state =
          r.status === "running"
            ? r.alive
              ? "🟢 running"
              : "🔴 dead"
            : `⚪ ${r.status}${r.stopReason === null ? "" : ` (${r.stopReason})`}`;
        yield* Console.log(
          [
            `${r.name}  ${state}  pid ${r.pid}`,
            `  harness ${r.harness} · model ${r.model ?? "(cli default)"}${r.effort === null ? "" : ` · effort ${r.effort}`}`,
            `  dir     ${r.dir}`,
            `  run     ${r.currentIteration}${r.maxIterations > 0 ? `/${r.maxIterations}` : ""} · started ${r.startedAt}`,
            `  log     ${store.logPath(r.name)}`,
          ].join("\n"),
        );
      }
    }),
).pipe(Command.withDescription("List ralph-next instances"));

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    for (const id of harnessIds) {
      const h = harnesses[id];
      const ok = yield* checkBinary(h).pipe(
        Effect.as(true),
        Effect.catchTag("HarnessUnavailable", () => Effect.succeed(false)),
      );
      yield* Console.log(
        `${ok ? "✅" : "❌"} ${id.padEnd(13)} ${h.binary.padEnd(9)} default model ${h.defaultModel ?? "(cli default)"}${ok ? "" : `  — ${h.installHint}`}`,
      );
    }
    yield* Console.log(`state: ${StoreModule.defaultRoot()}`);
  }),
).pipe(Command.withDescription("Check which harness CLIs are installed"));

const root = Command.make("ralph-next").pipe(
  Command.withDescription("Headless agent loops (Ralph Wiggum technique)"),
  Command.withSubcommands([run, status, doctor]),
);

const MainLive = StoreModule.layer().pipe(Layer.provideMerge(NodeServices.layer));

Command.run(root, { version: VERSION }).pipe(Effect.provide(MainLive), NodeRuntime.runMain);
