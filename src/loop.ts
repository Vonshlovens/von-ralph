/**
 * The Ralph loop: run the same prompt in a fresh agent context per iteration,
 * record everything, and stop on a clear, recorded reason.
 */
import { Console, Duration, Effect, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as nodePath from "node:path";
import {
  type HarnessEvent,
  HarnessFailed,
  type Instance,
  type IterationOutcome,
  type IterationRecord,
  type LoopEvent,
  type RalphEvent,
  type StopReason,
  clip,
} from "./domain.ts";
import { type Harness, checkBinary } from "./harness.ts";
import { Store, formatLogLine } from "./store.ts";

export interface LoopConfig {
  readonly name: string;
  readonly harness: Harness;
  /** null = let the harness CLI use its configured default */
  readonly model: string | null;
  readonly effort: string | null;
  readonly dir: string;
  readonly prompt: string;
  /** 0 = unlimited */
  readonly maxIterations: number;
  readonly marathon: boolean;
  readonly rateLimitSleepSeconds: number;
  readonly pauseBetween: Duration.Input;
  readonly maxConsecutiveFailures: number;
  /** Print the human-readable log to stdout as well. */
  readonly echo: boolean;
  readonly beadId: string | null;
}

export const defaults = {
  rateLimitSleepSeconds: 1800,
  pauseBetween: "2 seconds",
  maxConsecutiveFailures: 3,
} as const;

interface Tally {
  sessionId: string | null;
  attachId: string | null;
  inputTokens: number;
  outputTokens: number;
  costIncremental: number;
  costTotal: number | null;
  lastAssistant: string | null;
  sawBlocked: boolean;
  errorKinds: Set<string>;
  lastError: string | null;
  exitStatus: "ok" | "failed" | "blocked" | "stopped" | null;
}

const newTally = (): Tally => ({
  sessionId: null,
  attachId: null,
  inputTokens: 0,
  outputTokens: 0,
  costIncremental: 0,
  costTotal: null,
  lastAssistant: null,
  sawBlocked: false,
  errorKinds: new Set(),
  lastError: null,
  exitStatus: null,
});

const tallyEvent = (t: Tally, e: HarnessEvent): void => {
  switch (e.type) {
    case "session":
      t.sessionId = e.sessionId;
      t.attachId = e.attachId ?? t.attachId;
      break;
    case "assistant":
      t.lastAssistant = e.text;
      break;
    case "usage":
      t.inputTokens += e.inputTokens ?? 0;
      t.outputTokens += e.outputTokens ?? 0;
      t.costIncremental += e.costUsd ?? 0;
      if (e.totalCostUsd !== undefined) t.costTotal = e.totalCostUsd;
      break;
    case "error":
      t.errorKinds.add(e.kind);
      t.lastError = e.message;
      break;
    case "needs_input":
      t.sawBlocked = true;
      break;
    case "harness_exit":
      t.exitStatus = e.status;
      if (e.status === "blocked") t.sawBlocked = true;
      if (e.detail !== undefined && e.status !== "ok") t.lastError ??= e.detail;
      break;
  }
};

/** Decide an iteration's outcome from what the harness reported. Exported for tests. */
export const outcomeOf = (
  t: Pick<Tally, "sawBlocked" | "errorKinds" | "exitStatus">,
): IterationOutcome => {
  if (t.errorKinds.has("auth")) return "auth_failed";
  if (t.errorKinds.has("rate_limit")) return "rate_limited";
  if (t.sawBlocked) return "blocked";
  if (t.exitStatus === "failed" || t.exitStatus === null) return "failed";
  if (t.exitStatus === "stopped") return "interrupted";
  return "completed";
};

const gitHead = (dir: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const out = yield* spawner.string(
      ChildProcess.make("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    const sha = out.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }).pipe(Effect.orElseSucceed(() => null));

const now = () => new Date().toISOString();

export const runLoop = (cfg: LoopConfig) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* checkBinary(cfg.harness);
    const dir = nodePath.resolve(cfg.dir);

    let instance: Instance = {
      version: 1,
      name: cfg.name,
      pid: process.pid,
      harness: cfg.harness.id,
      model: cfg.model,
      effort: cfg.effort,
      dir,
      prompt: cfg.prompt,
      maxIterations: cfg.maxIterations,
      marathon: cfg.marathon,
      status: "running",
      currentIteration: 0,
      stopReason: null,
      startedAt: now(),
      updatedAt: now(),
      beadId: cfg.beadId,
    };
    yield* store.create(instance);
    const update = (patch: Partial<Instance>) =>
      Effect.suspend(() => {
        instance = { ...instance, ...patch, updatedAt: now() };
        return store.writeInstance(instance);
      });

    const emit = (iteration: number, e: LoopEvent) =>
      Effect.gen(function* () {
        const ev = { ...e, ts: now(), instance: cfg.name, iteration } as RalphEvent;
        yield* store.appendEvent(ev);
        if (cfg.echo) {
          const line = formatLogLine(ev);
          if (line !== undefined) yield* Console.log(line);
        }
      });

    const runIteration = (n: number) =>
      Effect.gen(function* () {
        const startedAt = now();
        const t0 = Date.now();
        const headBefore = yield* gitHead(dir);
        yield* emit(n, { type: "iteration_started", prompt: clip(cfg.prompt, 500) });
        const tally = newTally();
        yield* cfg.harness
          .run({
            prompt: cfg.prompt,
            model: cfg.model,
            effort: cfg.effort,
            dir,
            sessionName: `${cfg.name}-${n}`,
            onRaw: (line) => store.appendRaw(cfg.name, n, line).pipe(Effect.ignore),
          })
          .pipe(
            Stream.catchTag("HarnessFailed", (e: HarnessFailed) =>
              Stream.make<ReadonlyArray<HarnessEvent>>(
                { type: "error", kind: "unknown", message: e.message },
                { type: "harness_exit", status: "failed", detail: e.reason },
              ),
            ),
            Stream.runForEach((e) =>
              Effect.gen(function* () {
                tallyEvent(tally, e);
                yield* emit(n, e);
              }),
            ),
          );
        const outcome = outcomeOf(tally);
        const durationMs = Date.now() - t0;
        const record: IterationRecord = {
          iteration: n,
          outcome,
          startedAt,
          finishedAt: now(),
          durationMs,
          sessionId: tally.sessionId,
          attachId: tally.attachId,
          headBefore,
          headAfter: yield* gitHead(dir),
          inputTokens: tally.inputTokens,
          outputTokens: tally.outputTokens,
          costUsd: tally.costTotal ?? (tally.costIncremental > 0 ? tally.costIncremental : null),
          lastAssistant: tally.lastAssistant === null ? null : clip(tally.lastAssistant, 4000),
          error: tally.lastError,
        };
        yield* store.writeIteration(cfg.name, record);
        yield* emit(n, { type: "iteration_finished", outcome, durationMs });
        return outcome;
      });

    const iterations = yield* Ref.make(0);

    const loop = Effect.gen(function* () {
      yield* emit(0, {
        type: "run_started",
        harness: cfg.harness.id,
        model: cfg.model,
        dir,
        maxIterations: cfg.maxIterations,
      });
      let consecutiveFailures = 0;
      for (let n = 1; ; n++) {
        if (cfg.maxIterations > 0 && n > cfg.maxIterations) return "max_iterations" as StopReason;
        yield* update({ currentIteration: n });
        const outcome = yield* runIteration(n);
        yield* Ref.set(iterations, n);
        switch (outcome) {
          case "blocked":
            return "blocked" as StopReason;
          case "auth_failed":
            return "auth_failed" as StopReason;
          case "interrupted":
            return "interrupted" as StopReason;
          case "rate_limited":
            if (!cfg.marathon) return "rate_limited" as StopReason;
            yield* emit(n, { type: "rate_limit_sleep", seconds: cfg.rateLimitSleepSeconds });
            yield* Effect.sleep(Duration.seconds(cfg.rateLimitSleepSeconds));
            consecutiveFailures = 0;
            continue;
          case "failed":
            consecutiveFailures++;
            if (consecutiveFailures >= cfg.maxConsecutiveFailures)
              return "harness_failed" as StopReason;
            break;
          case "completed":
            consecutiveFailures = 0;
            break;
        }
        yield* Effect.sleep(cfg.pauseBetween);
      }
    });

    const finish = (reason: StopReason) =>
      Effect.gen(function* () {
        const n = yield* Ref.get(iterations);
        const status =
          reason === "interrupted"
            ? "stopped"
            : reason === "max_iterations"
              ? "finished"
              : "failed";
        yield* update({ status, stopReason: reason });
        yield* emit(n, { type: "run_finished", reason, iterations: n });
      }).pipe(Effect.ignore);

    return yield* loop.pipe(
      Effect.tap(finish),
      Effect.onInterrupt(() => finish("interrupted")),
      Effect.tapError(() => finish("harness_failed")),
    );
  });
