/**
 * `ralph serve`: the local HTTP API (+ SSE) over the same SQLite state the
 * CLI and TUI use. Starting a run re-execs the CLI detached, exactly like
 * `--detach`, so a run never depends on the server staying up.
 *
 *   GET  /v1/health
 *   GET  /v1/runs[?all=1]                 latest run per name (or every run)
 *   POST /v1/runs                         start a run (StartRequest) → 201 {run}
 *   GET  /v1/runs/:id                     run + iterations (id = run id or name)
 *   GET  /v1/runs/:id/report              commits, validation, plan delta, needs-a-human
 *   GET  /v1/runs/:id/plan                the run's plan as its runner last read it (final once ended)
 *   GET  /v1/runs/:id/summaries           observer summaries: current activity + per iteration
 *   GET  /v1/plan?dir=<abs dir>           a project's plan right now (no run needed)
 *   GET  /v1/runs/:id/events[?after&limit]
 *   GET  /v1/runs/:id/stream[?after]      SSE of normalized events; ends at run_finished
 *   GET  /v1/runs/:id/log[?lines]         text/plain
 *   GET  /v1/runs/:id/wait[?timeout=s]    long-poll until the run ends
 *   POST /v1/runs/:id/steer {text}
 *   POST /v1/runs/:id/stop {graceful?}
 *   POST /v1/runs/:id/restart {max?}
 *   GET  /v1/stream                       SSE `runs` snapshots whenever the list changes
 *   GET  /v1/schedules                    systemd schedules (`ralph schedule`)
 *   POST /v1/schedules/:name/run          start a schedule now
 *
 * With a token (`--token` / RALPH_SERVE_TOKEN) every /v1 route except health
 * needs `Authorization: Bearer <token>` (or `?token=` for EventSource).
 */
import { type Context, Data, Effect, Layer, Schema, Semaphore, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCallbackUrl } from "./callback.ts";
import { autoName, launchDetached, restartArgv, safeName } from "./cli/shared.ts";
import { steerRun, stopRun } from "./control.ts";
import {
  HarnessId,
  type Instance,
  type PlanView,
  RunMode,
  StateError,
  type Summary,
} from "./domain.ts";
import { checkBinary } from "./harness.ts";
import { harnesses } from "./registry.ts";
import { type PlanReader, beadsFilter, countsOf, planReader } from "./plan.ts";
import { loadProject, resolveBackend } from "./project.ts";
import { buildReport } from "./report.ts";
import * as Schedules from "./schedule.ts";
import { NAME_RE, Store, isAlive } from "./store.ts";

export const VERSION = "0.6.0";

export interface ServeOptions {
  readonly token: string | null;
  /** Built web UI (SvelteKit static output) served at `/`, if present. */
  readonly webRoot: string | null;
}

// ------------------------------------------------------------------ schemas

const Opt = <S extends Schema.Top>(s: S) => Schema.optional(Schema.NullOr(s));

export const StartRequest = Schema.Struct({
  mode: RunMode,
  dir: Schema.String,
  /** Required for `run` mode; ignored by process modes (they use .ralph/prompts). */
  prompt: Opt(Schema.String),
  name: Opt(Schema.String),
  harness: Opt(HarnessId),
  model: Opt(Schema.String),
  effort: Opt(Schema.String),
  max: Opt(Schema.Int),
  /** Minutes per iteration, 0 = none. */
  timeout: Opt(Schema.Int),
  marathon: Opt(Schema.Boolean),
  bead: Opt(Schema.String),
  scope: Opt(Schema.String),
  callbackUrl: Opt(Schema.String),
  /** false = no background observer summaries. */
  observer: Opt(Schema.Boolean),
  /** Seconds between current-activity summaries; 0 = end-of-iteration only. */
  observerInterval: Opt(Schema.Int),
});
export type StartRequest = typeof StartRequest.Type;

const SteerBody = Schema.Struct({ text: Schema.String });
const StopBody = Schema.Struct({ graceful: Opt(Schema.Boolean) });
const RestartBody = Schema.Struct({ max: Opt(Schema.Int) });

class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {}

// ------------------------------------------------------------------ helpers

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/** CLI argv for a start request (the CLI applies ralph.toml defaults itself). */
export const startArgv = (
  req: StartRequest,
): { argv: Array<string>; name: string; dir: string } => {
  const dir = path.resolve(expandHome(req.dir));
  const name =
    req.name ?? (req.mode === "run" ? autoName() : safeName(`${req.mode}-${path.basename(dir)}`));
  const opt = (flag: string, v: string | number | null | undefined) =>
    v === null || v === undefined ? [] : [flag, String(v)];
  const argv = [
    req.mode,
    "--name",
    name,
    "--dir",
    dir,
    ...opt("--harness", req.harness),
    ...opt("--model", req.model),
    ...opt("--effort", req.effort),
    ...opt("--max", req.max),
    ...opt("--timeout", req.timeout),
    ...(req.marathon === true ? ["--marathon"] : []),
    ...opt("--bead", req.bead),
    ...(req.mode === "run" ? [] : opt("--scope", req.scope)),
    ...opt("--callback", req.callbackUrl),
    ...(req.observer === false ? ["--no-observer"] : []),
    ...opt("--observer-interval", req.observerInterval),
    "--quiet",
    ...(req.mode === "run" ? [req.prompt ?? ""] : []),
  ];
  return { argv, name, dir };
};

const validateStart = (req: StartRequest) => {
  const dir = path.resolve(expandHome(req.dir));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `dir does not exist: ${dir}`;
  if (req.mode === "run" && (req.prompt ?? "").trim() === "") return "run mode needs a prompt";
  if (req.name != null && !NAME_RE.test(req.name)) return "name must match [A-Za-z0-9._-]{1,100}";
  if (req.callbackUrl != null && !isCallbackUrl(req.callbackUrl))
    return "callbackUrl must be an http(s) URL";
  return null;
};

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const searchParams = (req: HttpServerRequest.HttpServerRequest) =>
  new URL(req.url, "http://ralph.local").searchParams;

const intParam = (req: HttpServerRequest.HttpServerRequest, key: string, fallback: number) => {
  const v = Number.parseInt(searchParams(req).get(key) ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
};

const body = <S extends Schema.Top>(schema: S) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* req.text.pipe(Effect.orElseSucceed(() => ""));
    const raw = yield* Effect.try({
      try: () => (text.trim() === "" ? {} : JSON.parse(text)),
      catch: () => new BadRequest({ message: "body is not valid JSON" }),
    });
    return yield* Schema.decodeUnknownEffect(schema as never)(raw).pipe(
      Effect.mapError((e) => new BadRequest({ message: String(e) })),
    ) as Effect.Effect<S["Type"], BadRequest>;
  });

const runId = HttpRouter.params.pipe(Effect.map((p) => p.id ?? ""));

const summary = (r: Instance) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const its = yield* store.iterations(r.id);
    return {
      ...r,
      alive: r.status === "running" && isAlive(r.pid),
      lastOutcome: its.at(-1)?.outcome ?? null,
      costUsd: its.reduce((s, i) => s + (i.costUsd ?? 0), 0),
      inputTokens: its.reduce((s, i) => s + i.inputTokens, 0),
      outputTokens: its.reduce((s, i) => s + i.outputTokens, 0),
    };
  });

const listRuns = (all: boolean) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return yield* Effect.forEach(yield* store.list({ all }), summary);
  });

const enc = new TextEncoder();
const sseFrame = (event: string, data: unknown, id?: number) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const sseResponse = <E>(frames: Stream.Stream<string, E>) =>
  HttpServerResponse.stream(frames.pipe(Stream.map((s) => enc.encode(s))) as never, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache", "x-accel-buffering": "no", connection: "keep-alive" },
  });

const HEARTBEAT_MS = 15_000;

/** Normalized events of one run, from `after`, until run_finished (or the runner is gone). */
interface RunStreamState {
  readonly after: number;
  readonly done: boolean;
  readonly quietSince: number;
}

export const runEventFrames = (id: string, after: number) =>
  Stream.unfold<RunStreamState, string, StateError, Store>(
    { after, done: false, quietSince: Date.now() },
    (s) =>
      Effect.gen(function* () {
        if (s.done) return undefined;
        const store = yield* Store;
        const page = yield* store.events(id, { afterId: s.after, limit: 500 });
        if (page.length > 0) {
          const finished = page.some((e) => e.event.type === "run_finished");
          const frames = page.map((e) => sseFrame(e.event.type, e.event, e.id)).join("");
          const next = { after: page.at(-1)?.id ?? s.after, done: false, quietSince: Date.now() };
          return [
            finished ? `${frames}${sseFrame("end", { reason: "run_finished" })}` : frames,
            { ...next, done: finished },
          ] as const;
        }
        const run = yield* store.get(id);
        if (run.status !== "running" || !isAlive(run.pid)) {
          return [sseFrame("end", { reason: run.status }), { ...s, done: true }] as const;
        }
        yield* Effect.sleep("500 millis");
        if (Date.now() - s.quietSince >= HEARTBEAT_MS) {
          return [": ping\n\n", { ...s, quietSince: Date.now() }] as const;
        }
        return ["", s] as const;
      }),
  ).pipe(Stream.filter((f) => f !== ""));

/** `runs` snapshots (latest per name) whenever anything about them changes. */
interface RunsStreamState {
  readonly last: string;
  readonly quietSince: number;
  readonly first: boolean;
}

const runsFrames = Stream.unfold<RunsStreamState, string, StateError, Store>(
  { last: "", quietSince: Date.now(), first: true },
  (s) =>
    Effect.gen(function* () {
      if (!s.first) yield* Effect.sleep("1 second");
      const runs = yield* listRuns(false);
      const key = JSON.stringify(runs);
      if (key !== s.last) {
        return [
          sseFrame("runs", runs),
          { last: key, quietSince: Date.now(), first: false },
        ] as const;
      }
      if (Date.now() - s.quietSince >= HEARTBEAT_MS) {
        return [": ping\n\n", { ...s, quietSince: Date.now(), first: false }] as const;
      }
      return ["", { ...s, first: false }] as const;
    }),
).pipe(Stream.filter((f) => f !== ""));

// -------------------------------------------------------------- plan + summaries

/**
 * A run's plan: only ever the runner's persisted snapshot. A finished run
 * returns its own final snapshot, never a fresh read of today's repo.
 */
export const runPlan = (r: Instance) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const last = (yield* store.eventsOfType(r.id, ["plan_updated"], { limit: 1, newest: true }))[0];
    const live = r.status === "running" && isAlive(r.pid);
    const base = { runId: r.id, mode: r.mode, live, final: r.status !== "running" };
    if (last === undefined || last.event.type !== "plan_updated") {
      return {
        ...base,
        backend: null,
        scope: null,
        goal: null,
        items: [],
        learnings: [],
        counts: countsOf([]),
        updatedAt: null,
        iteration: 0,
        error: null,
      };
    }
    // The first read is the plan as the run found it, so the UI can show what this run moved.
    const first = (yield* store.eventsOfType(r.id, ["plan_updated"], { limit: 1 }))[0];
    const baseline =
      first !== undefined && first.event.type === "plan_updated"
        ? {
            iteration: first.event.iteration,
            updatedAt: first.event.plan.updatedAt,
            counts: first.event.plan.counts,
            done: first.event.plan.items.filter((i) => i.status === "done").map((i) => i.id),
            ids: first.event.plan.items.map((i) => i.id),
          }
        : null;
    return { ...base, ...last.event.plan, iteration: last.event.iteration, baseline };
  });

export const runSummaries = (r: Instance) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const summaryOf = (e: { readonly event: unknown }) =>
      (e.event as { readonly summary: Summary }).summary;
    const its = yield* store.eventsOfType(r.id, ["iteration_summary"], { limit: 10_000 });
    const byIteration = new Map<number, Summary>();
    for (const e of its) byIteration.set(summaryOf(e).iteration, summaryOf(e));
    const activity = (yield* store.eventsOfType(r.id, ["activity_summary"], {
      limit: 50,
      newest: true,
    })).map(summaryOf);
    const status = (yield* store.eventsOfType(r.id, ["observer_status"], {
      limit: 1,
      newest: true,
    }))[0]?.event;
    return {
      runId: r.id,
      observer:
        status?.type === "observer_status"
          ? {
              enabled: status.enabled,
              model: status.model,
              available: status.available,
              error: status.error,
              activityIntervalSeconds: status.activityIntervalSeconds ?? null,
            }
          : null,
      current: activity.at(-1) ?? null,
      activity,
      iterations: [...byIteration.values()].sort((a, b) => a.iteration - b.iteration),
    };
  });

const PLAN_CACHE_MS = 5000;

/** `GET /v1/plan?dir=`: one reader per project, single-flight, cached for 5s. */
export const projectPlans = () => {
  const entries = new Map<
    string,
    {
      readonly key: string;
      readonly reader: PlanReader;
      readonly lock: Semaphore.Semaphore;
      last: { readonly at: number; readonly view: PlanView } | null;
    }
  >();
  return (dir: string) =>
    Effect.gen(function* () {
      const project = yield* loadProject(dir);
      if (!project.initialized) {
        return yield* new StateError({
          path: dir,
          reason: "no such ralph project (no .ralph/ralph.toml)",
        });
      }
      const backend = resolveBackend(project);
      const filter = beadsFilter(project, null);
      const key = JSON.stringify({ backend, filter, goal: project.goal });
      let entry = entries.get(dir);
      if (entry === undefined || entry.key !== key) {
        entry = {
          key,
          reader: planReader({ dir, backend, filter, goal: project.goal, timeoutMs: 20_000 }),
          lock: Semaphore.makeUnsafe(1),
          last: null,
        };
        entries.set(dir, entry);
      }
      const e = entry;
      const view = yield* e.lock.withPermits(1)(
        Effect.suspend(() =>
          e.last !== null && Date.now() - e.last.at < PLAN_CACHE_MS
            ? Effect.succeed(e.last.view)
            : e.reader.read.pipe(
                Effect.map((st) => {
                  e.last = { at: Date.now(), view: st.view };
                  return st.view;
                }),
              ),
        ),
      );
      return { dir, ...view, live: true, final: false };
    });
};

// ------------------------------------------------------------------ routes

/** Services handlers use; captured once when the routes are built. */
type AppServices = Store | ChildProcessSpawner.ChildProcessSpawner;

type Handler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  AppServices | HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
>;

/** Auth + uniform error responses around every API handler. */
const guard = (opts: ServeOptions, h: Handler, open = false): Handler =>
  Effect.gen(function* () {
    if (opts.token !== null && !open) {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const header = req.headers.authorization ?? "";
      const given = header.startsWith("Bearer ")
        ? header.slice(7)
        : (searchParams(req).get("token") ?? "");
      if (given !== opts.token) return json({ error: "unauthorized" }, 401);
    }
    return yield* h;
  }).pipe(
    Effect.catchTags({
      BadRequest: (e: BadRequest) => Effect.succeed(json({ error: e.message }, 400)),
      StateError: (e: StateError) =>
        Effect.succeed(json({ error: e.message }, e.reason.startsWith("no such") ? 404 : 409)),
      HarnessUnavailable: (e: { message: string }) =>
        Effect.succeed(json({ error: e.message }, 400)),
    } as never),
    Effect.catchCause((cause) =>
      Effect.succeed(json({ error: "internal error", detail: String(cause) }, 500)),
    ),
  ) as Handler;

export const routes = (opts: ServeOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const services: Context.Context<AppServices> = yield* Effect.context<AppServices>();
      const projectPlan = projectPlans();
      const add = (method: "GET" | "POST", p: `/${string}`, h: Handler, open = false) =>
        router.add(method, p, guard(opts, h, open).pipe(Effect.provideContext(services)));

      yield* add(
        "GET",
        "/v1/health",
        Effect.succeed(json({ ok: true, version: VERSION, state: store.dbPath })),
        true,
      );

      yield* add(
        "GET",
        "/v1/runs",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const all = ["1", "true"].includes(searchParams(req).get("all") ?? "");
          return json({ runs: yield* listRuns(all) });
        }),
      );

      yield* add(
        "POST",
        "/v1/runs",
        Effect.gen(function* () {
          const req = yield* body(StartRequest);
          const problem = validateStart(req);
          if (problem !== null) return yield* new BadRequest({ message: problem });
          if (req.harness != null) yield* checkBinary(harnesses[req.harness]);
          const { argv, name, dir } = startArgv(req);
          const run = yield* launchDetached(argv, name, dir);
          return json({ run: yield* summary(run) }, 201);
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id",
        Effect.gen(function* () {
          const r = yield* store.get(yield* runId);
          return json({
            run: yield* summary(r),
            iterations: yield* store.iterations(r.id),
            logPath: store.logPath(r.id),
          });
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/report",
        Effect.gen(function* () {
          return json(yield* buildReport(yield* runId));
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/plan",
        Effect.gen(function* () {
          return json(yield* runPlan(yield* store.get(yield* runId)));
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/summaries",
        Effect.gen(function* () {
          return json(yield* runSummaries(yield* store.get(yield* runId)));
        }),
      );

      yield* add(
        "GET",
        "/v1/plan",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const raw = searchParams(req).get("dir") ?? "";
          if (raw.trim() === "") return yield* new BadRequest({ message: "dir is required" });
          const dir = path.resolve(expandHome(raw));
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
            return yield* new StateError({ path: dir, reason: "no such directory" });
          return json(yield* projectPlan(dir));
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/events",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const r = yield* store.get(yield* runId);
          const events = yield* store.events(r.id, {
            afterId: intParam(req, "after", 0),
            limit: Math.min(5000, Math.max(1, intParam(req, "limit", 1000))),
          });
          return json({ events });
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/stream",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const r = yield* store.get(yield* runId);
          const last = Number.parseInt(req.headers["last-event-id"] ?? "", 10);
          const after = Number.isFinite(last) ? last : intParam(req, "after", 0);
          return sseResponse(
            runEventFrames(r.id, after).pipe(
              Stream.provideService(Store, store),
              Stream.catch((e) => Stream.make(sseFrame("error", { error: String(e) }))),
            ),
          );
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/log",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const r = yield* store.get(yield* runId);
          const file = store.logPath(r.id);
          const lines = intParam(req, "lines", 200);
          const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          const out = text.split("\n").filter((l) => l !== "");
          return HttpServerResponse.text(`${out.slice(-Math.max(1, lines)).join("\n")}\n`);
        }),
      );

      yield* add(
        "GET",
        "/v1/runs/:id/wait",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const id = (yield* store.get(yield* runId)).id;
          const timeoutS = Math.min(3600, Math.max(1, intParam(req, "timeout", 300)));
          const deadline = Date.now() + timeoutS * 1000;
          while (true) {
            const r = yield* store.get(id);
            const ended = r.status !== "running" || !isAlive(r.pid);
            if (ended || Date.now() >= deadline) {
              return json({ done: ended, run: yield* summary(r) });
            }
            yield* Effect.sleep("1 second");
          }
        }),
      );

      yield* add(
        "POST",
        "/v1/runs/:id/steer",
        Effect.gen(function* () {
          const { text } = yield* body(SteerBody);
          if (text.trim() === "") return yield* new BadRequest({ message: "text is empty" });
          const r = yield* store.get(yield* runId);
          return json({ steerId: yield* steerRun(r, text) }, 201);
        }),
      );

      yield* add(
        "POST",
        "/v1/runs/:id/stop",
        Effect.gen(function* () {
          const { graceful } = yield* body(StopBody);
          const r = yield* store.get(yield* runId);
          return json(yield* stopRun(r, graceful === true));
        }),
      );

      yield* add(
        "POST",
        "/v1/runs/:id/restart",
        Effect.gen(function* () {
          const { max } = yield* body(RestartBody);
          const r = yield* store.get(yield* runId);
          if (r.status === "running" && isAlive(r.pid)) {
            return yield* new StateError({
              path: r.name,
              reason: `still running (pid ${r.pid}); stop it first`,
            });
          }
          yield* checkBinary(harnesses[r.harness]);
          const argv = yield* restartArgv(r, max ?? r.maxIterations);
          const run = yield* launchDetached(argv, r.name, r.dir);
          return json({ run: yield* summary(run) }, 201);
        }),
      );

      yield* add(
        "GET",
        "/v1/stream",
        Effect.sync(() =>
          sseResponse(
            runsFrames.pipe(
              Stream.provideService(Store, store),
              Stream.catch((e) => Stream.make(sseFrame("error", { error: String(e) }))),
            ),
          ),
        ),
      );

      yield* add(
        "GET",
        "/v1/schedules",
        Effect.gen(function* () {
          return json({ schedules: yield* Schedules.list() });
        }),
      );

      yield* add(
        "POST",
        "/v1/schedules/:name/run",
        Effect.gen(function* () {
          const name = (yield* HttpRouter.params).name ?? "";
          yield* Schedules.runNow(name);
          return json({ started: name }, 202);
        }),
      );
    }),
  );

/** The whole app: API routes plus the static web UI (SPA fallback) when built. */
export const app = (opts: ServeOptions) => {
  const api = routes(opts);
  if (opts.webRoot === null || !fs.existsSync(path.join(opts.webRoot, "index.html"))) {
    return Layer.mergeAll(
      api,
      HttpRouter.add(
        "GET",
        "/",
        HttpServerResponse.text(
          "ralph serve is running. The web UI is not built: run `pnpm --dir web build`.\nAPI: /v1/health, /v1/runs, /v1/stream\n",
        ),
      ),
    );
  }
  return Layer.mergeAll(api, HttpStaticServer.layer({ root: opts.webRoot, spa: true }));
};
