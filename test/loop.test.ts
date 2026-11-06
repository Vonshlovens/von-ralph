import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessEvent } from "../src/domain.ts";
import type { Harness } from "../src/harness.ts";
import { type LoopConfig, runLoop } from "../src/loop.ts";
import * as StoreModule from "../src/store.ts";
import { Store } from "../src/store.ts";

/** A harness that replays scripted events per iteration; `sh` stands in as its binary. */
const fakeHarness = (
  script: ReadonlyArray<ReadonlyArray<HarnessEvent>>,
): Harness & { calls: Array<string> } => {
  const calls: Array<string> = [];
  return {
    id: "claude",
    binary: "sh",
    installHint: "",
    defaultModel: "fake",
    defaultEffort: null,
    calls,
    run: (i) => {
      calls.push(i.sessionName);
      const events = script[calls.length - 1] ?? [{ type: "harness_exit", status: "ok" }];
      return Stream.fromEffect(i.onRaw(JSON.stringify({ fake: calls.length }))).pipe(
        Stream.drain,
        Stream.concat(Stream.fromIterable(events)),
      );
    },
  };
};

const withTempStore = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-test-"));
  return { root, layer: StoreModule.layer(root).pipe(Layer.provideMerge(NodeServices.layer)) };
};

const cfg = (harness: Harness, over: Partial<LoopConfig> = {}): LoopConfig => ({
  name: "t",
  harness,
  model: "fake",
  effort: null,
  dir: os.tmpdir(),
  prompt: "p",
  maxIterations: 3,
  marathon: false,
  rateLimitSleepSeconds: 0,
  pauseBetween: "0 millis",
  maxConsecutiveFailures: 3,
  echo: false,
  beadId: null,
  ...over,
});

describe("runLoop", () => {
  it.effect("runs max iterations with fresh sessions and records state", () => {
    const { root, layer } = withTempStore();
    const h = fakeHarness([
      [
        { type: "session", sessionId: "s1" },
        { type: "assistant", text: "one" },
        { type: "usage", inputTokens: 5, outputTokens: 2 },
        { type: "harness_exit", status: "ok" },
      ],
      [
        { type: "assistant", text: "two" },
        { type: "harness_exit", status: "ok" },
      ],
    ]);
    return Effect.gen(function* () {
      const reason = yield* runLoop(cfg(h));
      expect(reason).toBe("max_iterations");
      expect(h.calls).toEqual(["t-1", "t-2", "t-3"]);
      const store = yield* Store;
      const inst = yield* store.readInstance("t");
      expect(inst.status).toBe("finished");
      expect(inst.currentIteration).toBe(3);
      const it1 = JSON.parse(
        fs.readFileSync(path.join(root, "instances/t/iterations/1.json"), "utf8"),
      );
      expect(it1).toMatchObject({
        outcome: "completed",
        sessionId: "s1",
        inputTokens: 5,
        outputTokens: 2,
        lastAssistant: "one",
      });
      const events = fs
        .readFileSync(path.join(root, "instances/t/events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(events[0].type).toBe("run_started");
      expect(events.at(-1)).toMatchObject({
        type: "run_finished",
        reason: "max_iterations",
        iterations: 3,
      });
      expect(fs.readFileSync(path.join(root, "instances/t/raw/2.jsonl"), "utf8")).toContain(
        '"fake":2',
      );
      expect(fs.readFileSync(path.join(root, "instances/t/log"), "utf8")).toContain("💬 one");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops on blocked and on auth failure without looping", () => {
    const { layer } = withTempStore();
    const blocked = fakeHarness([
      [
        { type: "needs_input", reason: "x" },
        { type: "harness_exit", status: "blocked" },
      ],
    ]);
    const auth = fakeHarness([
      [
        { type: "error", kind: "auth", message: "Please run /login" },
        { type: "harness_exit", status: "blocked" },
      ],
    ]);
    return Effect.gen(function* () {
      expect(yield* runLoop(cfg(blocked, { name: "b" }))).toBe("blocked");
      expect(blocked.calls).toHaveLength(1);
      expect(yield* runLoop(cfg(auth, { name: "a" }))).toBe("auth_failed");
      expect(auth.calls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rate limit stops unless marathon, which sleeps and continues", () => {
    const { layer } = withTempStore();
    const rl = (): Array<HarnessEvent> => [
      { type: "error", kind: "rate_limit", message: "429" },
      { type: "harness_exit", status: "failed" },
    ];
    const plain = fakeHarness([rl()]);
    const marathon = fakeHarness([rl(), [{ type: "harness_exit", status: "ok" }]]);
    return Effect.gen(function* () {
      expect(yield* runLoop(cfg(plain, { name: "r1" }))).toBe("rate_limited");
      expect(yield* runLoop(cfg(marathon, { name: "r2", marathon: true, maxIterations: 2 }))).toBe(
        "max_iterations",
      );
      expect(marathon.calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives up after consecutive harness failures", () => {
    const { layer } = withTempStore();
    const fail: Array<HarnessEvent> = [
      { type: "harness_exit", status: "failed", detail: "exit 1" },
    ];
    const h = fakeHarness([fail, fail, fail, fail]);
    return Effect.gen(function* () {
      expect(yield* runLoop(cfg(h, { maxIterations: 10 }))).toBe("harness_failed");
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to reuse the name of a live running instance", () => {
    const { layer } = withTempStore();
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.create({
        version: 1,
        name: "dup",
        pid: process.pid,
        harness: "claude",
        model: "m",
        effort: null,
        dir: "/",
        prompt: "p",
        maxIterations: 0,
        marathon: false,
        status: "running",
        currentIteration: 0,
        stopReason: null,
        startedAt: "",
        updatedAt: "",
        beadId: null,
      });
      const err = yield* runLoop(cfg(fakeHarness([]), { name: "dup" })).pipe(Effect.flip);
      expect(err._tag).toBe("StateError");
    }).pipe(Effect.provide(layer));
  });
});
