import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addSign } from "../src/cli/process.ts";
import type { HarnessEvent } from "../src/domain.ts";
import type { Harness, IterationInput } from "../src/harness.ts";
import { type LoopConfig, runLoop } from "../src/loop.ts";
import { modePolicy, runPolicy } from "../src/modes.ts";
import {
  type Plan,
  emptyPlan,
  nextId,
  planProblems,
  readPlan,
  readyItems,
  renderPlan,
  writePlan,
} from "../src/plan.ts";
import { type ProjectConfig, defaultsFor, detectValidate, loadProject } from "../src/project.ts";
import * as StoreModule from "../src/store.ts";
import { Store } from "../src/store.ts";

type Step = (i: IterationInput) => void;

/** A harness whose iterations run scripted side effects in the repo, then exit ok. */
const scripted = (steps: ReadonlyArray<Step>, last: string | null = null) => {
  const calls: Array<IterationInput> = [];
  const h: Harness = {
    id: "codex",
    binary: "sh",
    installHint: "",
    defaultModel: null,
    defaultEffort: null,
    run: (i) => {
      calls.push(i);
      const step = steps[calls.length - 1];
      return Stream.fromEffect(Effect.sync(() => step?.(i))).pipe(
        Stream.drain,
        Stream.concat(
          Stream.fromIterable<HarnessEvent>([
            ...(last === null ? [] : [{ type: "assistant" as const, text: last }]),
            { type: "harness_exit", status: "ok" },
          ]),
        ),
      );
    },
  };
  return { h, calls };
};

const sh = (dir: string, cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" }).toString();

const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-repo-"));
  sh(dir, "git init -q && git config user.email t@t && git config user.name t");
  fs.mkdirSync(path.join(dir, ".ralph"));
  fs.writeFileSync(path.join(dir, ".ralph", "ralph.toml"), 'harness = "codex"\n');
  fs.mkdirSync(path.join(dir, "specs"));
  fs.writeFileSync(path.join(dir, "specs", "README.md"), "# Specs\n");
  sh(dir, "git add -A && git commit -qm init");
  return dir;
};

const project = (dir: string, over: Partial<ProjectConfig> = {}): ProjectConfig => {
  const d = defaultsFor(dir);
  return {
    ...d,
    initialized: true,
    plan: { ...d.plan, backend: "markdown" },
    ...over,
    limits: { ...d.limits, ...over.limits },
    validate: { ...d.validate, ...over.validate },
  };
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

const seedPlan = (dir: string, items: Plan["items"]) => {
  Effect.runSync(writePlan(dir, "IMPLEMENTATION_PLAN.md", { ...emptyPlan(), items }));
  sh(dir, "git add -A && git commit -qm plan");
};

/** Mark an item done in plan.json (as `ralph task done` would) and commit. */
const finish = (id: string) => (i: IterationInput) => {
  const plan = Effect.runSync(readPlan(i.dir));
  Effect.runSync(
    writePlan(i.dir, "IMPLEMENTATION_PLAN.md", {
      ...plan,
      items: plan.items.map((x) => (x.id === id ? { ...x, status: "done" as const } : x)),
    }),
  );
  fs.writeFileSync(path.join(i.dir, `${id}.txt`), id);
  sh(i.dir, `git add -A && git commit -qm "do ${id}"`);
};

const layer = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-state-"));
  return StoreModule.layer(root).pipe(Layer.provideMerge(NodeServices.layer));
};

const loopCfg = (h: Harness, dir: string, over: Partial<LoopConfig> = {}): LoopConfig => ({
  name: "m",
  harness: h,
  model: null,
  effort: null,
  dir,
  prompt: "[mode]",
  maxIterations: 10,
  marathon: false,
  rateLimitSleepSeconds: 0,
  pauseBetween: "0 millis",
  maxConsecutiveFailures: 3,
  iterationTimeoutSeconds: 0,
  echo: false,
  beadId: null,
  ...over,
});

describe("markdown plan", () => {
  it("validates, orders ready work, renders, and numbers ids", () => {
    const plan: Plan = {
      ...emptyPlan("ship it"),
      items: [
        item("T1", { status: "done" }),
        item("T2", { priority: 1, depends_on: ["T1"] }),
        item("T3", { priority: 0, depends_on: ["T2"] }),
        item("T4", { status: "blocked", notes: ["which db?"] }),
      ],
    };
    expect(planProblems(plan)).toEqual([]);
    expect(readyItems(plan).map((i) => i.id)).toEqual(["T2"]);
    expect(nextId(plan)).toBe("T5");
    const md = renderPlan(plan);
    expect(md).toContain("**Goal:** ship it");
    expect(md).toContain("## Ready");
    expect(md).toContain("**T2** (P1)");
    expect(md).toContain("## Blocked (needs a human)");
    expect(md).toContain("Note: which db?");
    expect(md).toContain("- [x] **T1**");
    expect(
      planProblems({ ...plan, items: [item("A", { depends_on: ["A", "Z"] }), item("A")] }),
    ).toEqual(expect.arrayContaining(["duplicate item id 'A'", "A: depends on itself"]));
  });

  it("fills defaults when an agent writes minimal JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-plan-"));
    fs.mkdirSync(path.join(dir, ".ralph"));
    fs.writeFileSync(
      path.join(dir, ".ralph", "plan.json"),
      JSON.stringify({ items: [{ id: "T1", title: "x" }] }),
    );
    const plan = Effect.runSync(readPlan(dir));
    expect(plan.items[0]).toMatchObject({ status: "open", priority: 2, depends_on: [] });
  });
});

describe("signs", () => {
  it("appends a sign with one more 9 after the last sign", () => {
    const t = "intro\n\n## Signs\n\n99999. a\n9999999. b\n    continued\n\n## After\n";
    const { text, nines } = addSign(t, "never skip tests");
    expect(nines).toBe("99999999");
    expect(text).toContain("    continued\n99999999. never skip tests\n\n## After");
    expect(addSign("no signs here\n", "x").text).toBe("no signs here\n\n## Signs\n\n99999. x\n");
  });
});

describe("project config", () => {
  it("reads ralph.toml with defaults and detects validate commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-proj-"));
    fs.mkdirSync(path.join(dir, ".ralph"));
    fs.writeFileSync(
      path.join(dir, ".ralph", "ralph.toml"),
      'harness = "codex"\n[plan]\nbackend = "markdown"\n[validate]\ncommands = ["true"]\n[limits]\nbuild_iterations = 7\n',
    );
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { check: "tsc", test: "vitest" } }),
    );
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    const p = Effect.runSync(loadProject(dir));
    expect(p).toMatchObject({
      initialized: true,
      harness: "codex",
      plan: { backend: "markdown", file: "IMPLEMENTATION_PLAN.md" },
      validate: { commands: ["true"], timeoutMinutes: 20 },
      limits: { buildIterations: 7, planIterations: 2 },
    });
    expect(detectValidate(dir)).toEqual(["pnpm check", "pnpm test"]);
    fs.writeFileSync(path.join(dir, ".ralph", "ralph.toml"), 'harness = "nope"\n');
    expect(Effect.runSyncExit(loadProject(dir))._tag).toBe("Failure");
  });
});

describe("process modes", () => {
  it.effect("build: one item per iteration, validates, stops when the plan is done", () => {
    const dir = repo();
    seedPlan(dir, [item("T1"), item("T2", { depends_on: ["T1"] })]);
    const { h, calls } = scripted([finish("T1"), finish("T2")]);
    const p = project(dir, { validate: { commands: ["true"], timeoutMinutes: 1 } });
    return Effect.gen(function* () {
      const { runId, reason } = yield* runLoop(
        loopCfg(h, dir, {
          policy: modePolicy({ mode: "build", project: p, scope: null, bead: null }),
        }),
      );
      expect(reason).toBe("plan_complete");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toContain("Ralph: build iteration");
      expect(calls[0]?.prompt).toContain("task done <id>");
      const store = yield* Store;
      const its = yield* store.iterations(runId);
      expect(its.map((i) => [i.validateOk, i.planOpen])).toEqual([
        [true, 1],
        [true, 0],
      ]);
      expect((yield* store.get(runId)).mode).toBe("build");
      const types = (yield* store.events(runId)).map((e) => e.event.type);
      expect(types.filter((t) => t === "validate")).toHaveLength(2);
    }).pipe(Effect.provide(layer()));
  });

  it.effect("build: failing validation is fed back and eventually stops the run", () => {
    const dir = repo();
    seedPlan(dir, [item("T1"), item("T2"), item("T3")]);
    const { h, calls } = scripted([finish("T1"), finish("T2"), finish("T3")]);
    const p = project(dir, {
      validate: { commands: ["echo boom-output; exit 3"], timeoutMinutes: 1 },
      limits: { ...defaultsFor(dir).limits, maxValidateFailures: 2 },
    });
    return Effect.gen(function* () {
      const { reason } = yield* runLoop(
        loopCfg(h, dir, {
          policy: modePolicy({ mode: "build", project: p, scope: null, bead: null }),
        }),
      );
      expect(reason).toBe("validate_failed");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.prompt).toContain("Runner validation FAILED");
      expect(calls[1]?.prompt).toContain("boom-output");
    }).pipe(Effect.provide(layer()));
  });

  it.effect("build: stops after N iterations without progress; empty plan never starts", () => {
    const dir = repo();
    seedPlan(dir, [item("T1")]);
    const idle = scripted([]);
    const p = project(dir, { limits: { ...defaultsFor(dir).limits, noProgressIterations: 2 } });
    const empty = repo();
    seedPlan(empty, []);
    const never = scripted([]);
    return Effect.gen(function* () {
      const r1 = yield* runLoop(
        loopCfg(idle.h, dir, {
          policy: modePolicy({ mode: "build", project: p, scope: null, bead: null }),
        }),
      );
      expect(r1.reason).toBe("no_progress");
      expect(idle.calls).toHaveLength(2);
      expect(idle.calls[1]?.prompt).toContain("made no commit");
      const r2 = yield* runLoop(
        loopCfg(never.h, empty, {
          name: "e",
          policy: modePolicy({ mode: "build", project: project(empty), scope: null, bead: null }),
        }),
      );
      expect(r2.reason).toBe("plan_complete");
      expect(never.calls).toHaveLength(0);
    }).pipe(Effect.provide(layer()));
  });

  it.effect("plan: converges when an iteration leaves the plan unchanged", () => {
    const dir = repo();
    seedPlan(dir, []);
    const addItem = (i: IterationInput) => {
      const plan = Effect.runSync(readPlan(i.dir));
      Effect.runSync(
        writePlan(i.dir, "IMPLEMENTATION_PLAN.md", { ...plan, items: [...plan.items, item("T1")] }),
      );
    };
    const { h, calls } = scripted([addItem]);
    return Effect.gen(function* () {
      const { reason } = yield* runLoop(
        loopCfg(h, dir, {
          policy: modePolicy({ mode: "plan", project: project(dir), scope: "auth", bead: null }),
        }),
      );
      expect(reason).toBe("plan_converged");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toContain("Plan only");
      expect(calls[0]?.prompt).toContain("(scope: auth)");
      expect(fs.readFileSync(path.join(dir, "IMPLEMENTATION_PLAN.md"), "utf8")).toContain("**T1**");
    }).pipe(Effect.provide(layer()));
  });

  it.effect("plan: changing source files is a scope violation, with the diff kept", () => {
    const dir = repo();
    seedPlan(dir, []);
    fs.writeFileSync(path.join(dir, "app.ts"), "old\n");
    sh(dir, "git add -A && git commit -qm app");
    const { h } = scripted([(i) => fs.writeFileSync(path.join(i.dir, "app.ts"), "new\n")]);
    return Effect.gen(function* () {
      const { runId, reason } = yield* runLoop(
        loopCfg(h, dir, {
          policy: modePolicy({ mode: "plan", project: project(dir), scope: null, bead: null }),
        }),
      );
      expect(reason).toBe("scope_violation");
      const store = yield* Store;
      const ev = (yield* store.events(runId)).find((e) => e.event.type === "scope_violation");
      expect(ev?.event).toMatchObject({ files: ["app.ts"] });
      const diff = fs.readFileSync(
        path.join(store.runDir(runId), "scope-violation-1.diff"),
        "utf8",
      );
      expect(diff).toContain("+new");
      expect((yield* store.get(runId)).status).toBe("failed");
    }).pipe(Effect.provide(layer()));
  });

  it.effect("reverse: writes specs until they stop changing", () => {
    const dir = repo();
    const { h, calls } = scripted([
      (i) => fs.writeFileSync(path.join(i.dir, "specs", "01-cli.md"), "# CLI\n"),
    ]);
    return Effect.gen(function* () {
      const { reason } = yield* runLoop(
        loopCfg(h, dir, {
          policy: modePolicy({ mode: "reverse", project: project(dir), scope: null, bead: null }),
        }),
      );
      expect(reason).toBe("plan_converged");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toContain("reverse-engineering iteration");
    }).pipe(Effect.provide(layer()));
  });

  it.effect("run: the COMPLETE sentinel ends the loop", () => {
    const dir = repo();
    const { h, calls } = scripted([], "all done <promise>COMPLETE</promise>");
    return Effect.gen(function* () {
      const { reason } = yield* runLoop(loopCfg(h, dir, { policy: runPolicy("go") }));
      expect(reason).toBe("complete");
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(layer()));
  });
});
