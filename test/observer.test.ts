import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessEvent, RalphEvent, Summary } from "../src/domain.ts";
import type { Harness, IterationInput } from "../src/harness.ts";
import { interactiveArgs } from "../src/hc.ts";
import { type LoopConfig, runLoop } from "../src/loop.ts";
import { modePolicy, runPolicy } from "../src/modes.ts";
import {
  type ObserverConfig,
  type Summarizer,
  SummarizeError,
  evidenceTail,
  observerHome,
} from "../src/observer.ts";
import { type Plan, beadsState, emptyPlan, readPlan, writePlan } from "../src/plan.ts";
import { type ProjectConfig, defaultsFor } from "../src/project.ts";
import { routes, runPlan, runSummaries } from "../src/server.ts";
import { observerOf, restartArgv } from "../src/cli/shared.ts";
import { Option } from "effect";
import * as StoreModule from "../src/store.ts";
import { Store } from "../src/store.ts";

// ------------------------------------------------------------------ helpers

const storeLayer = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-obs-"));
  return StoreModule.layer(root).pipe(Layer.provideMerge(NodeServices.layer));
};

type Step = (i: IterationInput) => Stream.Stream<HarnessEvent>;

const harness = (steps: ReadonlyArray<Step>) => {
  let n = 0;
  const h: Harness = {
    id: "claude",
    binary: "sh",
    installHint: "",
    defaultModel: "fake",
    defaultEffort: null,
    run: (i) => {
      const step = steps[n++];
      return step === undefined
        ? Stream.fromIterable<HarnessEvent>([{ type: "harness_exit", status: "ok" }])
        : step(i);
    },
  };
  return h;
};

const events =
  (...es: ReadonlyArray<HarnessEvent>): Step =>
  () =>
    Stream.fromIterable(es);

/** Emit some activity, pause (so the observer / plan poller get a turn), then finish. */
const busy =
  (ms: number, before?: (i: IterationInput) => void, after?: (i: IterationInput) => void): Step =>
  (i) =>
    Stream.fromIterable<HarnessEvent>([
      { type: "assistant", text: "Reading the code" },
      { type: "tool_call", name: "Bash", input: "pnpm test" },
      { type: "tool_result", output: "3 passed", isError: false },
    ]).pipe(
      Stream.concat(Stream.fromEffect(Effect.sync(() => before?.(i))).pipe(Stream.drain)),
      Stream.concat(Stream.fromEffect(Effect.sleep(`${ms} millis`)).pipe(Stream.drain)),
      Stream.concat(Stream.fromEffect(Effect.sync(() => after?.(i))).pipe(Stream.drain)),
      Stream.concat(
        Stream.fromIterable<HarnessEvent>([
          { type: "assistant", text: "Done with this step" },
          { type: "harness_exit", status: "ok" },
        ]),
      ),
    );

interface FakeSummarizer {
  readonly summarizer: Summarizer;
  readonly calls: Array<{ kind: string; iteration: number; prompt: string }>;
  maxConcurrent: number;
}

const fakeSummarizer = (
  behave: (call: number, kind: string) => Effect.Effect<string, SummarizeError> = (n, k) =>
    Effect.succeed(`${k} summary ${n}`),
): FakeSummarizer => {
  let running = 0;
  const f: FakeSummarizer = {
    calls: [],
    maxConcurrent: 0,
    summarizer: (req) =>
      Effect.suspend(() => {
        f.calls.push({ kind: req.kind, iteration: req.iteration, prompt: req.prompt });
        running++;
        f.maxConcurrent = Math.max(f.maxConcurrent, running);
        return behave(f.calls.length, req.kind);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running--;
          }),
        ),
      ),
  };
  return f;
};

const observer = (s: FakeSummarizer, over: Partial<ObserverConfig> = {}): ObserverConfig => ({
  summarizer: s.summarizer,
  model: "fake-haiku",
  activityIntervalMs: 0,
  timeoutMs: 2000,
  tickMs: 5,
  ...over,
});

const cfg = (h: Harness, over: Partial<LoopConfig> = {}): LoopConfig => ({
  name: "obs",
  harness: h,
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

const allEvents = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return (yield* store.events(runId, { limit: 100_000 })).map((e) => e.event);
  });

const summariesOf = (
  evs: ReadonlyArray<RalphEvent>,
  type: "iteration_summary" | "activity_summary",
) => evs.flatMap((e) => (e.type === type ? [e.summary as Summary] : []));

const indexOf = (evs: ReadonlyArray<RalphEvent>, pred: (e: RalphEvent) => boolean) =>
  evs.findIndex(pred);

// ------------------------------------------------------------------ observer

describe("observer", () => {
  it.live("persists one iteration summary per iteration before run_finished", () =>
    Effect.gen(function* () {
      const s = fakeSummarizer();
      const h = harness([
        events(
          { type: "assistant", text: "working on T1" },
          { type: "harness_exit", status: "ok" },
        ),
      ]);
      const { runId, reason } = yield* runLoop(cfg(h, { observer: observer(s) }));
      expect(reason).toBe("max_iterations");
      const evs = yield* allEvents(runId);
      const its = summariesOf(evs, "iteration_summary");
      expect(its.map((x) => [x.iteration, x.status, x.outcome])).toEqual([
        [1, "ok", "completed"],
        [2, "ok", "completed"],
      ]);
      expect(its[0]).toMatchObject({ kind: "iteration", model: "fake-haiku", validateOk: null });
      const finished = indexOf(evs, (e) => e.type === "run_finished");
      expect(finished).toBe(evs.length - 1);
      expect(indexOf(evs, (e) => e.type === "iteration_summary")).toBeLessThan(finished);
      expect(evs.find((e) => e.type === "observer_status")).toMatchObject({
        enabled: true,
        model: "fake-haiku",
      });
      // The prompt is bounded, framed as untrusted, and carries runner facts.
      const prompt = s.calls[0]?.prompt ?? "";
      expect(prompt).toContain("UNTRUSTED");
      expect(prompt).toContain("outcome: completed");
      expect(prompt).toContain("agent: working on T1");
      expect(s.maxConcurrent).toBe(1);
      // Activity summaries are off (interval 0): only iteration calls.
      expect(s.calls.every((c) => c.kind === "iteration")).toBe(true);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("summarizes current activity only when there is new evidence, never concurrently", () =>
    Effect.gen(function* () {
      const s = fakeSummarizer((n, k) => Effect.sleep("20 millis").pipe(Effect.as(`${k} ${n}`)));
      // Iteration 1 is busy for a while; iteration 2 is idle (one quick exit).
      const h = harness([busy(300), events({ type: "harness_exit", status: "ok" })]);
      const { runId } = yield* runLoop(
        cfg(h, { observer: observer(s, { activityIntervalMs: 30 }) }),
      );
      const evs = yield* allEvents(runId);
      const acts = summariesOf(evs, "activity_summary");
      // The busy iteration's evidence arrived at its start; the observer summarizes
      // it once and then stays quiet for ~10 intervals while nothing new happens
      // (one more may follow the final burst of evidence at the iteration's end).
      expect(acts.length).toBeGreaterThanOrEqual(1);
      expect(s.calls.filter((c) => c.kind === "activity").length).toBeLessThanOrEqual(2);
      expect(acts[0]).toMatchObject({ kind: "activity", iteration: 1, status: "ok" });
      expect(s.calls.filter((c) => c.kind === "activity" && c.iteration === 2)).toHaveLength(0);
      expect(summariesOf(evs, "iteration_summary")).toHaveLength(2);
      expect(s.maxConcurrent).toBe(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("records failures and timeouts without changing how the run ends", () =>
    Effect.gen(function* () {
      const s = fakeSummarizer((n) =>
        n === 1
          ? Effect.fail(new SummarizeError({ status: "error", message: "model said no" }))
          : Effect.never,
      );
      const h = harness([]);
      const { runId, reason } = yield* runLoop(
        cfg(h, { observer: observer(s, { timeoutMs: 50 }) }),
      );
      expect(reason).toBe("max_iterations");
      const store = yield* Store;
      expect((yield* store.get(runId)).status).toBe("finished");
      const its = summariesOf(yield* allEvents(runId), "iteration_summary");
      expect(its.map((x) => [x.status, x.error])).toEqual([
        ["error", "model said no"],
        ["timeout", "no summary within 0s"],
      ]);
      expect(its.every((x) => x.text === "")).toBe(true);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("an unavailable model is reported truthfully and never called", () =>
    Effect.gen(function* () {
      const s = fakeSummarizer();
      const { runId, reason } = yield* runLoop(
        cfg(harness([]), {
          observer: observer(s, {
            check: Effect.succeed({ available: false, error: "no claude-haiku-5-5 here" }),
          }),
        }),
      );
      expect(reason).toBe("max_iterations");
      const evs = yield* allEvents(runId);
      expect(evs.find((e) => e.type === "observer_status")).toMatchObject({
        available: false,
        error: "no claude-haiku-5-5 here",
      });
      expect(summariesOf(evs, "iteration_summary").map((x) => x.status)).toEqual([
        "unavailable",
        "unavailable",
      ]);
      expect(s.calls).toHaveLength(0);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("a crashing model check or teardown defect disables the observer, not the run", () =>
    Effect.gen(function* () {
      const s = fakeSummarizer(() => Effect.die(new Error("hc terminal cleanup failed")));
      const { runId, reason } = yield* runLoop(
        cfg(harness([]), { maxIterations: 3, observer: observer(s) }),
      );
      expect(reason).toBe("max_iterations");
      const evs = yield* allEvents(runId);
      const its = summariesOf(evs, "iteration_summary");
      expect(its.map((x) => x.status)).toEqual(["error", "unavailable", "unavailable"]);
      // At most one possibly-surviving session: no second attempt.
      expect(s.calls).toHaveLength(1);
      const statuses = evs.filter((e) => e.type === "observer_status");
      expect(statuses.at(-1)).toMatchObject({ available: false });
      expect(JSON.stringify(statuses.at(-1))).toContain("observer disabled for this run");

      const broken = yield* runLoop(
        cfg(harness([]), {
          name: "obs2",
          maxIterations: 1,
          observer: observer(fakeSummarizer(), { check: Effect.die("boom") }),
        }),
      );
      expect(broken.reason).toBe("max_iterations");
      expect(
        (yield* allEvents(broken.runId)).find((e) => e.type === "observer_status"),
      ).toMatchObject({ available: false });
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("a summary interrupted mid-teardown poisons the observer too", () =>
    Effect.gen(function* () {
      const s = fakeSummarizer(() =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.die(new Error("hc kill failed")))),
      );
      const { runId } = yield* runLoop(
        cfg(harness([]), { maxIterations: 2, observer: observer(s, { timeoutMs: 30 }) }),
      );
      const its = summariesOf(yield* allEvents(runId), "iteration_summary");
      expect(its[0]?.status).toBe("error");
      expect(its[1]?.status).toBe("unavailable");
      expect(s.calls).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("on stop: interrupted placeholder for the current iteration, no model call", () =>
    Effect.gen(function* () {
      const summaryStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const s = fakeSummarizer((n) =>
        n === 1
          ? Deferred.succeed(summaryStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed("should not happen"),
      );
      // Iteration 1 completes (its summary hangs), iteration 2 never ends.
      const h = harness([
        events({ type: "harness_exit", status: "ok" }),
        () =>
          Stream.fromEffect(Deferred.succeed(secondStarted, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
      ]);
      const fiber = yield* Effect.forkChild(
        runLoop(cfg(h, { maxIterations: 5, observer: observer(s, { timeoutMs: 60_000 }) })),
      );
      const store = yield* Store;
      // currentIteration is set before git/preparation; wait for the actual
      // harness and summary worker, so interruption tests their active lifetime.
      yield* Deferred.await(secondStarted);
      yield* Deferred.await(summaryStarted);
      yield* Fiber.interrupt(fiber);
      const run = yield* store.get("obs");
      expect(run).toMatchObject({ status: "stopped", stopReason: "interrupted" });
      const evs = yield* allEvents(run.id);
      const its = summariesOf(evs, "iteration_summary");
      expect(its.map((x) => [x.iteration, x.status, x.outcome])).toEqual([
        [1, "interrupted", "completed"],
        [2, "interrupted", "interrupted"],
      ]);
      expect(s.calls.map((c) => c.iteration)).toEqual([1]);
      expect(evs.at(-1)?.type).toBe("run_finished");
    }).pipe(Effect.provide(storeLayer())),
  );

  it("bounds the evidence tail", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(100)}`);
    const tail = evidenceTail(lines);
    expect(tail.length).toBeLessThan(6200);
    expect(tail).toContain("line 499");
    expect(tail).not.toContain("line 0 ");
    expect(tail).toMatch(/earlier events omitted/);
  });

  it("isolated observer config trusts only its scratch folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-obs-home-"));
    const home = observerHome(root);
    const state = JSON.parse(fs.readFileSync(path.join(home.config, ".claude.json"), "utf8"));
    expect(state.hasCompletedOnboarding).toBe(true);
    const trusted = Object.keys(state.projects);
    expect(trusted.length).toBeGreaterThan(0);
    for (const dir of trusted) {
      expect(fs.realpathSync(dir)).toBe(fs.realpathSync(home.work));
      expect(state.projects[dir].hasTrustDialogAccepted).toBe(true);
    }
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home.config, ".claude.json")).mode & 0o777).toBe(0o600);
  });

  it("observer Claude sessions get no tools, no MCP servers and no bypass", () => {
    const args = interactiveArgs(
      "claude",
      {
        prompt: "p",
        model: "claude-haiku-5-5",
        effort: null,
        dir: "/tmp",
        sessionName: "s",
        onRaw: () => Effect.void,
        tools: "none",
      },
      "uuid",
      "/tmp/settings.json",
    );
    const at = args.indexOf("--tools");
    expect(args[at + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--bg");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
  });
});

// ------------------------------------------------------------------- plan

const sh = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" }).toString();

const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-plan-repo-"));
  sh(dir, "git init -q && git config user.email t@t && git config user.name t");
  fs.mkdirSync(path.join(dir, ".ralph"));
  fs.writeFileSync(path.join(dir, ".ralph", "ralph.toml"), "");
  sh(dir, "git add -A && git commit -qm init");
  return dir;
};

const project = (dir: string): ProjectConfig => {
  const d = defaultsFor(dir);
  return { ...d, initialized: true, goal: "ship it", plan: { ...d.plan, backend: "markdown" } };
};

const item = (id: string, over: Partial<Plan["items"][number]> = {}) => ({
  id,
  title: `item ${id}`,
  status: "open" as const,
  priority: 2,
  depends_on: [],
  spec_refs: [],
  acceptance: "",
  notes: [],
  ...over,
});

const setStatus = (dir: string, id: string, status: "in_progress" | "done") => {
  const plan = Effect.runSync(readPlan(dir));
  Effect.runSync(
    writePlan(dir, "IMPLEMENTATION_PLAN.md", {
      ...plan,
      items: plan.items.map((x) => (x.id === id ? { ...x, status } : x)),
    }),
  );
};

describe("plan snapshots", () => {
  it.live("publish start/done transitions during the iteration and keep a final snapshot", () =>
    Effect.gen(function* () {
      const dir = repo();
      Effect.runSync(
        writePlan(dir, "IMPLEMENTATION_PLAN.md", {
          ...emptyPlan("ship it"),
          items: [item("T1", { priority: 1 }), item("T2", { depends_on: ["T1"] })],
        }),
      );
      sh(dir, "git add -A && git commit -qm plan");
      const h = harness([
        busy(
          500,
          (i) => setStatus(i.dir, "T1", "in_progress"),
          (i) => {
            setStatus(i.dir, "T1", "done");
            sh(i.dir, "git add -A && git commit -qm T1");
          },
        ),
      ]);
      const { runId, reason } = yield* runLoop(
        cfg(h, {
          dir,
          maxIterations: 1,
          planPollMs: 20,
          policy: modePolicy({ mode: "build", project: project(dir), scope: null, bead: null }),
        }),
      );
      expect(reason).toBe("max_iterations");
      const evs = yield* allEvents(runId);
      const plans = evs.flatMap((e, i) => (e.type === "plan_updated" ? [{ e, i }] : []));
      const iterFinished = indexOf(evs, (e) => e.type === "iteration_finished");
      // Before the run: T1 open. During iteration 1 (before it finished): T1 in progress.
      expect(plans[0]?.e.plan.items.map((x) => [x.id, x.status, x.ready])).toEqual([
        ["T1", "open", true],
        ["T2", "open", false],
      ]);
      const during = plans.find(
        (p) =>
          p.i < iterFinished &&
          p.e.iteration === 1 &&
          p.e.plan.items.some((x) => x.id === "T1" && x.status === "in_progress"),
      );
      expect(during).toBeDefined();
      expect(during?.e.plan.counts.inProgress).toBe(1);
      const last = plans.at(-1);
      expect(last?.e.final).toBe(true);
      expect(last?.e.plan.goal).toBe("ship it");
      expect(last?.e.plan.items.map((x) => [x.id, x.status, x.ready])).toEqual([
        ["T1", "done", false],
        ["T2", "open", true],
      ]);
      expect(last!.i).toBeLessThan(indexOf(evs, (e) => e.type === "run_finished"));

      // The finished run keeps ITS plan: later repo changes do not show up.
      setStatus(dir, "T2", "done");
      const store = yield* Store;
      const api = yield* runPlan(yield* store.get(runId));
      expect(api).toMatchObject({ final: true, live: false, backend: "markdown", mode: "build" });
      expect(api.items.map((x) => x.status)).toEqual(["done", "open"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.live("run mode has no plan", () =>
    Effect.gen(function* () {
      const { runId } = yield* runLoop(cfg(harness([]), { maxIterations: 1 }));
      const store = yield* Store;
      const api = yield* runPlan(yield* store.get(runId));
      expect(api).toMatchObject({ backend: null, items: [], updatedAt: null, final: true });
    }).pipe(Effect.provide(storeLayer())),
  );
});

// ------------------------------------------------------------------ beads

/** A fake `bd` on PATH: answers list/ready/show from fixtures and logs its argv. */
const fakeBd = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-fake-bd-"));
  const log = path.join(dir, "calls.log");
  const rows = [
    {
      id: "bd-1",
      title: "Claimed",
      status: "in_progress",
      priority: 1,
      issue_type: "task",
      acceptance_criteria: "it works",
      notes: "halfway",
    },
    {
      id: "bd-2",
      title: "Waits on 1",
      status: "open",
      priority: 2,
      issue_type: "task",
      dependencies: [
        { issue_id: "bd-2", depends_on_id: "bd-1", type: "blocks" },
        { issue_id: "bd-2", depends_on_id: "bd-epic", type: "parent-child" },
      ],
    },
    { id: "bd-3", title: "Shipped", status: "closed", priority: 0, issue_type: "task" },
    { id: "bd-4", title: "Later", status: "deferred", priority: 3, issue_type: "task" },
    { id: "bd-epic", title: "Epic", status: "open", priority: 1, issue_type: "epic" },
  ];
  fs.writeFileSync(path.join(dir, "list.json"), JSON.stringify(rows));
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, "show.json"), JSON.stringify([rows[0]]));
  fs.writeFileSync(
    path.join(dir, "bd"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\ncat ${JSON.stringify(dir)}/"$1".json\n`,
    { mode: 0o755 },
  );
  return { dir, log };
};

describe("beads plan view", () => {
  it.live("maps statuses, blocking deps and the label/parent scope", () =>
    Effect.gen(function* () {
      const bd = fakeBd();
      const old = process.env.PATH;
      process.env.PATH = `${bd.dir}:${old}`;
      try {
        const st = yield* beadsState(os.tmpdir(), {
          label: "ralph",
          parent: "bd-epic",
          bead: null,
        });
        expect(st.view.error).toBeNull();
        expect(st.view.scope).toEqual({ label: "ralph", parent: "bd-epic", bead: null });
        expect(st.view.items.map((i) => [i.id, i.status, i.ready, i.depends_on])).toEqual([
          ["bd-3", "done", false, []],
          ["bd-1", "in_progress", true, []],
          ["bd-2", "open", false, ["bd-1"]],
          ["bd-4", "deferred", false, []],
        ]);
        expect(st.view.items.find((i) => i.id === "bd-1")).toMatchObject({
          acceptance: "it works",
          notes: ["halfway"],
          rawStatus: "in_progress",
        });
        expect(st.view.counts).toEqual({
          total: 4,
          open: 2,
          ready: 1,
          inProgress: 1,
          done: 1,
          blocked: 0,
        });
        expect(st.snapshot).toMatchObject({ total: 4, open: 2, actionable: 1 });
        const calls = fs.readFileSync(bd.log, "utf8");
        expect(calls).toContain("list --all --flat -n 0 --label ralph --parent bd-epic --json");
        expect(calls).toContain("ready -n 0 --label ralph --parent bd-epic --json");

        const one = yield* beadsState(os.tmpdir(), { label: null, parent: null, bead: "bd-1" });
        expect(one.view.scope?.bead).toBe("bd-1");
        expect(one.view.items.map((i) => [i.id, i.status, i.ready])).toEqual([
          ["bd-1", "in_progress", true],
        ]);
        expect(fs.readFileSync(bd.log, "utf8")).toContain("show bd-1 --json");
      } finally {
        process.env.PATH = old;
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("a failing bd is an error state, not a crash", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-bad-bd-"));
      fs.writeFileSync(path.join(dir, "bd"), "#!/bin/sh\necho 'dolt down' >&2\nexit 3\n", {
        mode: 0o755,
      });
      const old = process.env.PATH;
      process.env.PATH = `${dir}:${old}`;
      try {
        const st = yield* beadsState(os.tmpdir(), { label: null, parent: null, bead: null });
        expect(st.view.items).toEqual([]);
        expect(st.view.error).toContain("dolt down");
        expect(st.snapshot.error).toContain("dolt down");
      } finally {
        process.env.PATH = old;
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// -------------------------------------------------------------------- API

describe("plan + summaries API", () => {
  it.live("serves a run's plan and summaries behind the usual auth", () => {
    const layer = storeLayer();
    return Effect.scoped(
      Effect.gen(function* () {
        const dir = repo();
        Effect.runSync(
          writePlan(dir, "IMPLEMENTATION_PLAN.md", {
            ...emptyPlan(),
            items: [item("T1")],
          }),
        );
        const s = fakeSummarizer();
        yield* runLoop(
          cfg(harness([busy(10, undefined, (i) => setStatus(i.dir, "T1", "done"))]), {
            name: "api",
            dir,
            maxIterations: 1,
            observer: observer(s),
            policy: modePolicy({ mode: "build", project: project(dir), scope: null, bead: null }),
          }),
        );
        const ctx = yield* Layer.build(layer);
        const { handler, dispose } = HttpRouter.toWebHandler(
          routes({ token: "tok", webRoot: null }).pipe(Layer.provide(Layer.succeedContext(ctx))),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(dispose));
        const call = (p: string) =>
          Effect.promise(async () => {
            const res = await handler(new Request(`http://ralph.local${p}`));
            return { status: res.status, body: JSON.parse(await res.text()) };
          });
        expect((yield* call("/v1/runs/api/plan")).status).toBe(401);
        expect((yield* call("/v1/runs/api/summaries")).status).toBe(401);
        expect((yield* call("/v1/plan?dir=/tmp")).status).toBe(401);

        const plan = yield* call("/v1/runs/api/plan?token=tok");
        expect(plan.status).toBe(200);
        expect(plan.body).toMatchObject({
          mode: "build",
          backend: "markdown",
          final: true,
          live: false,
          error: null,
        });
        expect(plan.body.items[0]).toMatchObject({ id: "T1", status: "done" });

        const sums = yield* call("/v1/runs/api/summaries?token=tok");
        expect(sums.status).toBe(200);
        expect(sums.body.observer).toMatchObject({ enabled: true, model: "fake-haiku" });
        expect(sums.body.iterations).toHaveLength(1);
        expect(sums.body.iterations[0]).toMatchObject({
          kind: "iteration",
          iteration: 1,
          status: "ok",
          outcome: "completed",
        });
        expect(sums.body.current).toBeNull();

        const live = yield* call(`/v1/plan?dir=${encodeURIComponent(dir)}&token=tok`);
        expect(live.status).toBe(200);
        expect(live.body).toMatchObject({ dir, backend: "markdown", live: true, final: false });
        expect((yield* call("/v1/plan?dir=/nonexistent-xyz&token=tok")).status).toBe(404);
        expect(
          (yield* call(`/v1/plan?dir=${encodeURIComponent(os.tmpdir())}&token=tok`)).status,
        ).toBe(404);
        expect((yield* call("/v1/runs/nope/summaries?token=tok")).status).toBe(404);
      }).pipe(Effect.provide(layer)),
    );
  });
});

// --------------------------------------------------------- observer settings

describe("observer settings", () => {
  it.live("a disabled observer is recorded, and restart keeps the original setting", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const off = yield* runLoop(
        cfg(harness([]), { name: "off", maxIterations: 1, observer: false }),
      );
      const offSummaries = yield* runSummaries(yield* store.get(off.runId));
      expect(offSummaries.observer).toEqual({
        enabled: false,
        model: null,
        available: null,
        error: null,
        activityIntervalSeconds: null,
      });
      const offArgv = yield* restartArgv(yield* store.get(off.runId), 4);
      expect(offArgv).toContain("--no-observer");
      expect(offArgv).not.toContain("--observer-interval");
      expect(offArgv.slice(offArgv.indexOf("--max"), offArgv.indexOf("--max") + 2)).toEqual([
        "--max",
        "4",
      ]);

      // Custom cadence, then the observer breaks: restart uses the FIRST (configured)
      // status, not the later "unavailable" health report.
      const custom = yield* runLoop(
        cfg(harness([]), {
          name: "custom",
          maxIterations: 1,
          observer: observer(
            fakeSummarizer(() => Effect.die("teardown failed")),
            {
              activityIntervalMs: 30_000,
            },
          ),
        }),
      );
      const sums = yield* runSummaries(yield* store.get(custom.runId));
      expect(sums.observer).toMatchObject({
        enabled: true,
        available: false,
        activityIntervalSeconds: 30,
      });
      const customArgv = yield* restartArgv(yield* store.get(custom.runId), 1);
      expect(customArgv).not.toContain("--no-observer");
      expect(customArgv[customArgv.indexOf("--observer-interval") + 1]).toBe("30");

      // A run from before the observer existed: no observer flags (default).
      const legacy = yield* runLoop(
        cfg(harness([]), { name: "legacy", maxIterations: 1, observer: false }),
      );
      const sql = yield* Effect.promise(async () => (await import("node:sqlite")).DatabaseSync);
      const db = new sql(store.dbPath);
      db.prepare("DELETE FROM events WHERE run_id = ? AND type = 'observer_status'").run(
        legacy.runId,
      );
      db.close();
      const legacyArgv = yield* restartArgv(yield* store.get(legacy.runId), 1);
      expect(legacyArgv).not.toContain("--no-observer");
      expect(legacyArgv).not.toContain("--observer-interval");
      expect((yield* runSummaries(yield* store.get(legacy.runId))).observer).toBeNull();
    }).pipe(Effect.provide(storeLayer())),
  );

  it("RALPH_OBSERVER=0 wins over --observer-interval", () => {
    const old = process.env.RALPH_OBSERVER;
    try {
      process.env.RALPH_OBSERVER = "0";
      expect(observerOf({ noObserver: false, observerInterval: Option.some(10) })).toBe(false);
      expect(observerOf({ noObserver: false, observerInterval: Option.none() })).toBe(false);
      delete process.env.RALPH_OBSERVER;
      expect(observerOf({ noObserver: false, observerInterval: Option.none() })).toBeUndefined();
      expect(observerOf({ noObserver: true, observerInterval: Option.some(10) })).toBe(false);
      const on = observerOf({ noObserver: false, observerInterval: Option.some(10) });
      expect(on === false || on === undefined ? null : on.activityIntervalMs).toBe(10_000);
    } finally {
      if (old === undefined) delete process.env.RALPH_OBSERVER;
      else process.env.RALPH_OBSERVER = old;
    }
  });
});
