/** `ralph serve` and `ralph schedule …`. */
import { NodeHttpServer } from "@effect/platform-node";
import { Console, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StateError } from "../domain.ts";
import * as Schedules from "../schedule.ts";
import { app } from "../server.ts";

export const DEFAULT_PORT = 7420;
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/build");

const isLoopback = (host: string) =>
  host === "127.0.0.1" || host === "::1" || host === "localhost" || host.startsWith("127.");

/** RALPH_SERVE_TOKEN, else the contents of RALPH_SERVE_TOKEN_FILE. */
const envToken = () => {
  const file = process.env.RALPH_SERVE_TOKEN_FILE;
  if (process.env.RALPH_SERVE_TOKEN !== undefined) return process.env.RALPH_SERVE_TOKEN;
  if (file === undefined || file === "") return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

export const serve = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(
      Flag.withAlias("p"),
      Flag.withDescription(`Port (default ${DEFAULT_PORT})`),
      Flag.withDefault(DEFAULT_PORT),
    ),
    host: Flag.String("host").pipe(
      Flag.withDescription("Bind address (default 127.0.0.1; anything else needs a token)"),
      Flag.withDefault("127.0.0.1"),
    ),
    token: Flag.String("token").pipe(
      Flag.withDescription(
        "Bearer token for /v1 (default: $RALPH_SERVE_TOKEN or $RALPH_SERVE_TOKEN_FILE)",
      ),
      Flag.optional,
    ),
    noWeb: Flag.Boolean("no-web").pipe(
      Flag.withDescription("Do not serve the web UI"),
      Flag.withDefault(false),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const token = Option.getOrElse(a.token, envToken) || null;
      if (token === null && !isLoopback(a.host)) {
        return yield* new StateError({
          path: a.host,
          reason: "binding beyond loopback needs --token or RALPH_SERVE_TOKEN",
        });
      }
      const webRoot = a.noWeb ? null : WEB_ROOT;
      yield* Console.log(
        `ralph serve on http://${a.host.includes(":") ? `[${a.host}]` : a.host}:${a.port}${token === null ? "" : " (token required)"}`,
      );
      return yield* Layer.launch(
        HttpRouter.serve(app({ token, webRoot }), { disableLogger: true }).pipe(
          Layer.provide(NodeHttpServer.layer(createServer, { port: a.port, host: a.host })),
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "HTTP API + SSE (and the web UI) over ralph's state: start, watch, steer, stop runs",
  ),
);

// ------------------------------------------------------------------ schedule

const fmtTime = (iso: string | null) =>
  iso === null ? "-" : new Date(iso).toLocaleString(undefined, { hour12: false });

const scheduleAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("Schedule name (also the run name)"),
    ),
    cron: Flag.String("cron").pipe(
      Flag.withDescription('Cron expression, e.g. "0 2 * * *" or @daily'),
      Flag.optional,
    ),
    at: Flag.String("at").pipe(
      Flag.withDescription('systemd OnCalendar expression, e.g. "Mon..Fri 09:00"'),
      Flag.optional,
    ),
    persistent: Flag.Boolean("persistent").pipe(
      Flag.withDescription("Catch up on a run missed while the machine was off"),
      Flag.withDefault(false),
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription("Overwrite an existing schedule of that name"),
      Flag.withDefault(false),
    ),
    args: Argument.String("ralph-args").pipe(
      Argument.withDescription("After --: the ralph command to run, e.g. -- build -d ~/repo -N 5"),
      Argument.variadic(),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const meta = yield* Schedules.add({
        name: a.name,
        cron: Option.getOrNull(a.cron),
        at: Option.getOrNull(a.at),
        args: a.args,
        persistent: a.persistent,
        replace: a.replace,
      });
      const i = yield* Schedules.info(meta.name);
      yield* Console.log(
        `⏰ ${meta.name}: ${meta.calendar} → ralph ${meta.args.join(" ")}\n   next run ${fmtTime(i.nextRun)} · unit ${Schedules.UNIT_PREFIX}${meta.name}.timer`,
      );
    }),
).pipe(Command.withDescription("Schedule a ralph command as a systemd user timer"));

const scheduleList = Command.make(
  "list",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  (a) =>
    Effect.gen(function* () {
      const all = yield* Schedules.list();
      if (a.json) return yield* Console.log(JSON.stringify(all, null, 2));
      if (all.length === 0) return yield* Console.log("No schedules.");
      for (const s of all) {
        const state = s.running ? "🟢 running" : s.enabled ? "⏰ enabled" : "⏸️  paused";
        const last =
          s.lastRun === null
            ? "never ran"
            : `last ${fmtTime(s.lastRun)} (${s.lastResult ?? "?"}${s.lastExitCode === null ? "" : `, exit ${s.lastExitCode}`})`;
        yield* Console.log(
          `${s.name}  ${state}  ${s.cron ?? s.calendar}\n  ralph ${s.args.join(" ")}\n  next ${fmtTime(s.nextRun)} · ${last}`,
        );
      }
    }),
).pipe(Command.withDescription("List schedules with next/last run"));

const nameOnly = (
  verb: string,
  f: (name: string) => Effect.Effect<void, StateError>,
  done: string,
) =>
  Command.make(verb, { name: Argument.String("name") }, (a) =>
    f(a.name).pipe(Effect.andThen(Console.log(`${done} ${a.name}`))),
  );

export const schedule = Command.make("schedule").pipe(
  Command.withDescription(
    "Recurring runs via systemd user timers (add, list, run, pause, resume, rm)",
  ),
  Command.withSubcommands([
    scheduleAdd,
    scheduleList,
    nameOnly("run", Schedules.runNow, "▶️  started").pipe(
      Command.withDescription("Start a schedule's run now (see `ralph status`)"),
    ),
    nameOnly("pause", (n) => Schedules.setEnabled(n, false), "⏸️  paused").pipe(
      Command.withDescription("Disable the timer (keeps the schedule)"),
    ),
    nameOnly("resume", (n) => Schedules.setEnabled(n, true), "⏰ resumed").pipe(
      Command.withDescription("Re-enable a paused timer"),
    ),
    nameOnly("rm", Schedules.remove, "🗑️  removed").pipe(
      Command.withDescription("Remove the timer and service"),
    ),
  ]),
);
