import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessEvent } from "../src/domain.ts";
import type { Harness } from "../src/harness.ts";
import { type LoopConfig, runLoop } from "../src/loop.ts";
import { runPolicy } from "../src/modes.ts";
import * as Schedules from "../src/schedule.ts";
import { cronToCalendar, quoteArg } from "../src/schedule.ts";
import { routes, startArgv } from "../src/server.ts";
import * as StoreModule from "../src/store.ts";

const harness = (text: string): Harness => ({
  id: "claude",
  binary: "sh",
  installHint: "",
  defaultModel: "fake",
  defaultEffort: null,
  run: () =>
    Stream.fromIterable<HarnessEvent>([
      { type: "session", sessionId: "s1" },
      { type: "assistant", text },
      { type: "harness_exit", status: "ok" },
    ]),
});

const cfg = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  name: "srv",
  harness: harness("done <promise>COMPLETE</promise>"),
  model: "fake",
  effort: null,
  dir: os.tmpdir(),
  prompt: "p",
  maxIterations: 2,
  marathon: false,
  rateLimitSleepSeconds: 0,
  pauseBetween: "0 millis",
  maxConsecutiveFailures: 3,
  iterationTimeoutSeconds: 0,
  echo: false,
  beadId: null,
  policy: runPolicy("p"),
  ...over,
});

const storeLayer = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-serve-"));
  return StoreModule.layer(root).pipe(Layer.provideMerge(NodeServices.layer));
};

/** A local HTTP sink that records POSTs. */
const sink = () => {
  const got: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  return {
    got,
    url: Effect.promise(
      () =>
        new Promise<string>((ok) =>
          server.listen(0, "127.0.0.1", () =>
            ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`),
          ),
        ),
    ),
    close: () => server.close(),
  };
};

describe("completion callbacks", () => {
  const s = sink();
  afterAll(() => s.close());

  it.effect("POSTs a signed summary when the run ends", () =>
    Effect.gen(function* () {
      const url = yield* s.url;
      process.env.RALPH_CALLBACK_SECRET = "shh";
      const { runId, reason } = yield* runLoop(cfg({ callbackUrl: url })).pipe(
        Effect.ensuring(Effect.sync(() => delete process.env.RALPH_CALLBACK_SECRET)),
      );
      expect(reason).toBe("complete");
      expect(s.got).toHaveLength(1);
      const { headers, body } = s.got[0] ?? { headers: {}, body: "" };
      const payload = JSON.parse(body);
      expect(payload).toMatchObject({
        event: "run_finished",
        reason: "complete",
        exitCode: 0,
        needsHuman: false,
        run: { id: runId, name: "srv", status: "finished", callbackUrl: url },
        report: { iterations: 1 },
      });
      const ts = String(headers["x-ralph-timestamp"]);
      const expected = `sha256=${createHmac("sha256", "shh").update(`${ts}.${body}`).digest("hex")}`;
      expect(headers["x-ralph-signature"]).toBe(expected);
      const store = yield* StoreModule.Store;
      const notices = (yield* store.events(runId)).filter((e) => e.event.type === "notice");
      expect(JSON.stringify(notices.at(-1)?.event)).toContain("callback delivered (HTTP 204)");
    }).pipe(Effect.provide(storeLayer())),
  );
});

describe("ralph serve API", () => {
  const withApi = (token: string | null) => {
    const layer = storeLayer();
    return Effect.gen(function* () {
      yield* runLoop(cfg());
      const ctx = yield* Layer.build(layer);
      const { handler, dispose } = HttpRouter.toWebHandler(
        routes({ token, webRoot: null }).pipe(Layer.provide(Layer.succeedContext(ctx))),
        { disableLogger: true },
      );
      const call = (p: string, init?: RequestInit) =>
        Effect.promise(async () => {
          const res = await handler(new Request(`http://ralph.local${p}`, init));
          return { status: res.status, text: await res.text() };
        });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      return call;
    }).pipe(Effect.provide(layer));
  };

  it.effect("lists, shows, reports, pages and streams events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const call = yield* withApi(null);
        const health = yield* call("/v1/health");
        expect(JSON.parse(health.text)).toMatchObject({ ok: true });
        const runs = JSON.parse((yield* call("/v1/runs")).text).runs;
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ name: "srv", status: "finished", alive: false });
        const one = JSON.parse((yield* call("/v1/runs/srv")).text);
        expect(one.iterations).toHaveLength(1);
        const rep = JSON.parse((yield* call("/v1/runs/srv/report")).text);
        expect(rep).toMatchObject({ stopReason: "complete", iterations: 1 });
        const ev = JSON.parse((yield* call("/v1/runs/srv/events?after=1&limit=2")).text).events;
        expect(ev.map((e: { id: number }) => e.id)).toEqual([2, 3]);
        const sse = yield* call("/v1/runs/srv/stream");
        expect(sse.text).toContain("event: run_started");
        expect(sse.text).toContain("event: run_finished");
        expect(sse.text.trim().endsWith('data: {"reason":"run_finished"}')).toBe(true);
        const resumed = yield* call("/v1/runs/srv/stream?after=1000");
        expect(resumed.text).toBe('event: end\ndata: {"reason":"finished"}\n\n');
        const log = yield* call("/v1/runs/srv/log?lines=1");
        expect(log.text).toContain("stopped after 1 runs (complete)");
      }),
    ),
  );

  it.effect("validates input and maps errors to status codes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const call = yield* withApi(null);
        const post = (p: string, body: unknown) =>
          call(p, { method: "POST", body: JSON.stringify(body) });
        expect((yield* call("/v1/runs/nope")).status).toBe(404);
        expect((yield* post("/v1/runs/srv/steer", { text: "hi" })).status).toBe(409);
        expect((yield* post("/v1/runs", { mode: "run", dir: os.tmpdir() })).status).toBe(400);
        expect((yield* post("/v1/runs", { mode: "nope", dir: "/" })).status).toBe(400);
        const bad = yield* post("/v1/runs", {
          mode: "build",
          dir: os.tmpdir(),
          callbackUrl: "ftp://x",
        });
        expect(JSON.parse(bad.text).error).toContain("callbackUrl");
        expect((yield* call("/v1/runs", { method: "POST", body: "{" })).status).toBe(400);
        const stop = JSON.parse((yield* post("/v1/runs/srv/stop", {})).text);
        expect(stop.state).toBe("not_running");
      }),
    ),
  );

  it.effect("requires the bearer token (header or ?token=) except for health", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const call = yield* withApi("s3cret");
        expect((yield* call("/v1/health")).status).toBe(200);
        expect((yield* call("/v1/runs")).status).toBe(401);
        expect(
          (yield* call("/v1/runs", { headers: { authorization: "Bearer s3cret" } })).status,
        ).toBe(200);
        expect((yield* call("/v1/runs?token=s3cret")).status).toBe(200);
        expect((yield* call("/v1/runs?token=wrong")).status).toBe(401);
      }),
    ),
  );

  it("builds CLI argv for a start request", () => {
    expect(
      startArgv({ mode: "build", dir: "/r", max: 5, scope: "auth", callbackUrl: "http://n/x" }),
    ).toEqual({
      name: "build-r",
      dir: "/r",
      argv: [
        "build",
        "--name",
        "build-r",
        "--dir",
        "/r",
        "--max",
        "5",
        "--scope",
        "auth",
        "--callback",
        "http://n/x",
        "--quiet",
      ],
    });
    const run = startArgv({ mode: "run", dir: "/r", prompt: "go", name: "x", harness: "codex" });
    expect(run.argv).toEqual([
      "run",
      "--name",
      "x",
      "--dir",
      "/r",
      "--harness",
      "codex",
      "--quiet",
      "go",
    ]);
  });
});

describe("schedules", () => {
  it("converts cron to OnCalendar", () => {
    expect(cronToCalendar("0 2 * * *")).toBe("*-*-* 02:00:00");
    expect(cronToCalendar("*/15 * * * *")).toBe("*-*-* *:00/15:00");
    expect(cronToCalendar("30 9 * * 1-5")).toBe("Mon,Tue,Wed,Thu,Fri *-*-* 09:30:00");
    expect(cronToCalendar("0 9 * * sun,6")).toBe("Sat,Sun *-*-* 09:00:00");
    expect(cronToCalendar("0 0 1 */3 *")).toBe("*-01/3-01 00:00:00");
    expect(cronToCalendar("0 8-18/2 * * *")).toBe("*-*-* 08,10,12,14,16,18:00:00");
    expect(cronToCalendar("@daily")).toBe("daily");
    expect(() => cronToCalendar("0 0 1 * 1")).toThrow(/ANDs/);
    expect(() => cronToCalendar("0 25 * * *")).toThrow(/out of range/);
    expect(() => cronToCalendar("* * *")).toThrow(/5 fields/);
  });

  it("quotes ExecStart arguments for systemd", () => {
    expect(quoteArg("/usr/bin/node")).toBe("/usr/bin/node");
    expect(quoteArg('fix the $HOME 100% "now"')).toBe('"fix the $$HOME 100%% \\"now\\""');
    expect(quoteArg("")).toBe('""');
  });

  it.effect("writes a oneshot service + timer with absolute dir and run name", () => {
    const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-sched-"));
    const prev = process.env.XDG_CONFIG_HOME;
    return Effect.gen(function* () {
      process.env.XDG_CONFIG_HOME = cfgHome;
      const opts = {
        name: "nightly",
        cron: "0 2 * * *",
        at: null,
        args: ["run", "-d", "~/repo", "-N", "3", "fix the lint"],
        persistent: true,
        replace: false,
        dryRun: true,
      };
      const meta = yield* Schedules.add(opts);
      expect(meta.args).toEqual([
        "run",
        "--name",
        "nightly",
        "-d",
        path.join(os.homedir(), "repo"),
        "-N",
        "3",
        "--quiet",
        "fix the lint",
      ]);
      const dir = path.join(cfgHome, "systemd", "user");
      const service = fs.readFileSync(path.join(dir, "ralph-sched-nightly.service"), "utf8");
      const timer = fs.readFileSync(path.join(dir, "ralph-sched-nightly.timer"), "utf8");
      expect(service).toContain("Type=oneshot");
      expect(service).toMatch(/ExecStart=\S+node\S* \S+bin\.ts run --name nightly/);
      expect(service).toContain('"fix the lint"');
      expect(service).toContain(`# ralph-schedule: ${JSON.stringify(meta)}`);
      expect(timer).toContain("OnCalendar=*-*-* 02:00:00");
      expect(timer).toContain("Persistent=true");
      expect(Schedules.names()).toEqual(["nightly"]);
      const dup = yield* Schedules.add(opts).pipe(Effect.flip);
      expect(dup.reason).toContain("--replace");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
          else process.env.XDG_CONFIG_HOME = prev;
        }),
      ),
    );
  });

  it.effect("rejects detached, mode-less and ambiguous schedules", () =>
    Effect.gen(function* () {
      const base = {
        name: "x",
        cron: "@daily",
        at: null,
        persistent: false,
        replace: true,
        dryRun: true,
      };
      const err = (o: Partial<Schedules.AddOptions>) =>
        Schedules.add({ ...base, args: ["build"], ...o }).pipe(
          Effect.flip,
          Effect.map((e) => e.reason),
        );
      expect(yield* err({ args: ["build", "--detach"] })).toContain("foreground");
      expect(yield* err({ args: ["status"] })).toContain("ralph command");
      expect(yield* err({ at: "daily" })).toContain("exactly one");
      expect(yield* err({ name: "bad name" })).toContain("name must");
    }),
  );
});
