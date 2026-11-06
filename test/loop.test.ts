import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessEvent } from "../src/domain.ts";
import type { Harness, IterationInput } from "../src/harness.ts";
import { type LoopConfig, composePrompt, runLoop } from "../src/loop.ts";
import * as StoreModule from "../src/store.ts";
import { Store } from "../src/store.ts";

type Step = ReadonlyArray<HarnessEvent> | ((i: IterationInput) => Stream.Stream<HarnessEvent>);

/** A harness that replays scripted events per iteration; `sh` stands in as its binary. */
const fakeHarness = (script: ReadonlyArray<Step>) => {
  const calls: Array<IterationInput> = [];
  const h: Harness = {
    id: "claude",
    binary: "sh",
    installHint: "",
    defaultModel: "fake",
    defaultEffort: null,
    run: (i) => {
      calls.push(i);
      const step: Step = script[calls.length - 1] ?? [{ type: "harness_exit", status: "ok" }];
      const events = typeof step === "function" ? step(i) : Stream.fromIterable(step);
      return Stream.fromEffect(i.onRaw(JSON.stringify({ fake: calls.length }))).pipe(
        Stream.drain,
        Stream.concat(events),
      );
    },
  };
  return { h, calls };
};

const tempLayer = () => {
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
  iterationTimeoutSeconds: 0,
  echo: false,
  beadId: null,
  ...over,
});

const ok: ReadonlyArray<HarnessEvent> = [{ type: "harness_exit", status: "ok" }];

describe("runLoop", () => {
  it.effect("runs max iterations with fresh sessions and records state in sqlite", () => {
    const { root, layer } = tempLayer();
    const { h, calls } = fakeHarness([
      [
        { type: "session", sessionId: "s1", attachId: "abc" },
        { type: "assistant", text: "one" },
        { type: "usage", inputTokens: 5, outputTokens: 2 },
        { type: "harness_exit", status: "ok" },
      ],
      [{ type: "assistant", text: "two" }, ...ok],
    ]);
    return Effect.gen(function* () {
      const { runId, reason } = yield* runLoop(cfg(h));
      expect(reason).toBe("max_iterations");
      expect(calls.map((c) => c.sessionName)).toEqual(["t-1", "t-2", "t-3"]);
      const store = yield* Store;
      const run = yield* store.get("t");
      expect(run).toMatchObject({
        id: runId,
        status: "finished",
        currentIteration: 3,
        marathon: false,
      });
      const its = yield* store.iterations(runId);
      expect(its).toHaveLength(3);
      expect(its[0]).toMatchObject({
        outcome: "completed",
        sessionId: "s1",
        attachId: "abc",
        inputTokens: 5,
        outputTokens: 2,
        lastAssistant: "one",
      });
      const events = yield* store.events(runId);
      expect(events[0]?.event.type).toBe("run_started");
      expect(events.at(-1)?.event).toMatchObject({
        type: "run_finished",
        reason: "max_iterations",
        iterations: 3,
      });
      expect(fs.readFileSync(path.join(root, "runs", runId, "raw/2.jsonl"), "utf8")).toContain(
        '"fake":2',
      );
      expect(fs.readFileSync(store.logPath(runId), "utf8")).toContain("💬 one");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops on blocked and on auth failure without looping", () => {
    const { layer } = tempLayer();
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
      expect((yield* runLoop(cfg(blocked.h, { name: "b" }))).reason).toBe("blocked");
      expect(blocked.calls).toHaveLength(1);
      expect((yield* runLoop(cfg(auth.h, { name: "a" }))).reason).toBe("auth_failed");
      expect(auth.calls).toHaveLength(1);
      const store = yield* Store;
      expect((yield* store.get("a")).status).toBe("failed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rate limit stops unless marathon, which sleeps and continues", () => {
    const { layer } = tempLayer();
    const rl = (): Array<HarnessEvent> => [
      { type: "error", kind: "rate_limit", message: "429" },
      { type: "harness_exit", status: "failed" },
    ];
    const plain = fakeHarness([rl()]);
    const marathon = fakeHarness([rl(), ok]);
    return Effect.gen(function* () {
      expect((yield* runLoop(cfg(plain.h, { name: "r1" }))).reason).toBe("rate_limited");
      const r2 = yield* runLoop(cfg(marathon.h, { name: "r2", marathon: true, maxIterations: 2 }));
      expect(r2.reason).toBe("max_iterations");
      expect(marathon.calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives up after consecutive harness failures", () => {
    const { layer } = tempLayer();
    const fail: Array<HarnessEvent> = [
      { type: "harness_exit", status: "failed", detail: "exit 1" },
    ];
    const { h, calls } = fakeHarness([fail, fail, fail, fail]);
    return Effect.gen(function* () {
      expect((yield* runLoop(cfg(h, { maxIterations: 10 }))).reason).toBe("harness_failed");
      expect(calls).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("times out a hung iteration and interrupts the harness", () => {
    const { layer } = tempLayer();
    let finalized = false;
    const hang: Step = () =>
      Stream.never.pipe(
        Stream.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      );
    const { h } = fakeHarness([hang]);
    return Effect.gen(function* () {
      const { runId, reason } = yield* runLoop(
        cfg(h, { iterationTimeoutSeconds: 1, maxIterations: 1 }),
      );
      expect(reason).toBe("max_iterations");
      expect(finalized).toBe(true);
      const store = yield* Store;
      expect((yield* store.iterations(runId))[0]).toMatchObject({ outcome: "timed_out" });
      const finished = (yield* store.events(runId)).filter(
        (e) => e.event.type === "iteration_finished",
      );
      expect(finished).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("steering: notes reach the next prompt, stop ends the run gracefully", () => {
    const { layer } = tempLayer();
    return Effect.gen(function* () {
      const store = yield* Store;
      // Steers are queued while an iteration runs, so the next iteration sees them.
      const queueDuring =
        (kind: "note" | "stop", text: string): Step =>
        () =>
          Stream.fromEffect(
            store.get("s").pipe(
              Effect.flatMap((run) => store.addSteer(run.id, kind, text)),
              Effect.orDie,
            ),
          ).pipe(Stream.drain, Stream.concat(Stream.fromIterable(ok)));
      const { h, calls } = fakeHarness([
        queueDuring("note", "focus on tests"),
        queueDuring("stop", "enough"),
        ok,
      ]);
      const { runId, reason } = yield* runLoop(cfg(h, { name: "s", maxIterations: 5 }));
      expect(reason).toBe("operator_stop");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toBe("p");
      expect(calls[1]?.prompt).toBe(composePrompt("p", ["focus on tests"]));
      expect(calls[1]?.prompt).toContain("- focus on tests");
      expect((yield* store.get(runId)).status).toBe("stopped");
      const types = (yield* store.events(runId)).map((e) => e.event.type);
      expect(types.filter((t) => t === "steer_received")).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to reuse the name of a live ralph, and supersedes a dead one", () => {
    const { layer } = tempLayer();
    const base = {
      name: "dup",
      harness: "claude" as const,
      model: "m",
      effort: null,
      dir: "/",
      prompt: "p",
      maxIterations: 0,
      marathon: false,
      iterationTimeoutSeconds: 0,
      status: "running" as const,
      currentIteration: 0,
      stopReason: null,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      beadId: null,
      mode: "run" as const,
      scope: null,
      callbackUrl: null,
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.create({ ...base, id: "rlive", pid: process.pid });
      const err = yield* runLoop(cfg(fakeHarness([]).h, { name: "dup" })).pipe(Effect.flip);
      expect(err._tag).toBe("StateError");
      // A "running" row whose process is gone is marked crashed when the name is reused.
      yield* store.update("rlive", { pid: 999_999_999 });
      const { reason } = yield* runLoop(cfg(fakeHarness([]).h, { name: "dup", maxIterations: 1 }));
      expect(reason).toBe("max_iterations");
      expect(yield* store.get("rlive")).toMatchObject({ status: "failed", stopReason: "crashed" });
    }).pipe(Effect.provide(layer));
  });
});
