/**
 * The Ralph loop: run the same prompt in a fresh agent context per iteration,
 * record everything, and stop on a clear, recorded reason.
 */
import { Cause, Console, Duration, Effect, Option, Ref, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import * as nodePath from "node:path";
import {
  type HarnessEvent,
  HarnessFailed,
  type Instance,
  type IterationOutcome,
  type IterationRecord,
  type LoopEvent,
  type RalphEvent,
  type RunMode,
  type StateError,
  type StopReason,
  clip,
} from "./domain.ts";
import { head as gitHead } from "./git.ts";
import { type Harness, checkBinary, claude, codex, copilot, opencode } from "./harness.ts";
import {
  type Observer,
  type ObserverConfig,
  noObserver,
  observerEnvDisabled,
  realObserver,
  startObserver,
} from "./observer.ts";
import { type PlanReader, keepLastGood, viewDigest } from "./plan.ts";
import type { PlanView } from "./domain.ts";
import { deliver, payloadFor } from "./callback.ts";
import { Store, formatLogLine, newRunId } from "./store.ts";

type Emit = (e: LoopEvent) => Effect.Effect<void, StateError>;

export interface ReviewInput {
  readonly iteration: number;
  readonly headBefore: string | null;
  readonly headAfter: string | null;
  readonly lastAssistant: string | null;
  /** Where the runner may write artifacts for this run (diffs, reports). */
  readonly runDir: string;
  readonly emit: Emit;
}

export interface Review {
  /** End the run now, for this reason. */
  readonly stop: StopReason | null;
  /** Prepended to the next iteration's prompt ("runner feedback"). */
  readonly feedback: ReadonlyArray<string>;
  readonly validateOk: boolean | null;
  readonly planOpen: number | null;
}

/**
 * What makes a mode (run / plan / build / reverse) different. The loop calls
 * `preflight` once, then per iteration `begin` → `prompt` → harness → `review`
 * (review only after a `completed` iteration).
 */
export interface ModePolicy {
  readonly id: RunMode;
  readonly preflight: (
    emit: Emit,
  ) => Effect.Effect<StopReason | null, StateError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly begin: (
    iteration: number,
  ) => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner>;
  readonly prompt: (iteration: number) => Effect.Effect<string, StateError>;
  readonly review: (
    input: ReviewInput,
  ) => Effect.Effect<Review, StateError, ChildProcessSpawner.ChildProcessSpawner>;
  /**
   * The run's plan (plan / build modes). The loop publishes it as `plan_updated`
   * after preflight and review, polls it while an iteration runs, and persists
   * a final snapshot before `run_finished`.
   */
  readonly plan?: PlanReader | undefined;
}

/** The plain `run` mode (also exported from modes.ts with the sentinel check). */
const fixedPrompt = (prompt: string): ModePolicy => ({
  id: "run",
  preflight: () => Effect.succeed(null),
  begin: () => Effect.void,
  prompt: () => Effect.succeed(prompt),
  review: () => Effect.succeed({ stop: null, feedback: [], validateOk: null, planOpen: null }),
});

export interface LoopConfig {
  readonly name: string;
  readonly harness: Harness;
  /** null = let the harness CLI use its configured default */
  readonly model: string | null;
  readonly effort: string | null;
  readonly dir: string;
  /** The prompt (run mode) or a description of it (process modes); stored on the run. */
  readonly prompt: string;
  /** Mode behavior; default: send `prompt` unchanged every iteration. */
  readonly policy?: ModePolicy | undefined;
  readonly scope?: string | null | undefined;
  /** 0 = unlimited */
  readonly maxIterations: number;
  readonly marathon: boolean;
  readonly rateLimitSleepSeconds: number;
  readonly pauseBetween: Duration.Input;
  readonly maxConsecutiveFailures: number;
  /** 0 = no per-iteration timeout */
  readonly iterationTimeoutSeconds: number;
  /** Print the human-readable log to stdout as well. */
  readonly echo: boolean;
  readonly beadId: string | null;
  /** POST a summary here when the run ends. */
  readonly callbackUrl?: string | null | undefined;
  /**
   * Background summaries. Default (undefined): Claude Haiku 5.5 for the real
   * harnesses (unless RALPH_OBSERVER=0), off for anything else (test fakes).
   */
  readonly observer?: ObserverConfig | false | undefined;
  /** How often to re-read the plan while an iteration runs; 0 = only between iterations. */
  readonly planPollMs?: number | undefined;
}

/** The real harness adapters (test fakes are other objects). */
const REAL_HARNESSES: ReadonlyArray<Harness> = [claude, codex, opencode, copilot];

const observerFor = (cfg: LoopConfig): ObserverConfig | false => {
  if (cfg.observer !== undefined) return cfg.observer;
  if (observerEnvDisabled()) return false;
  return REAL_HARNESSES.includes(cfg.harness) ? realObserver() : false;
};

export const defaults = {
  rateLimitSleepSeconds: 1800,
  pauseBetween: "2 seconds",
  maxConsecutiveFailures: 3,
  iterationTimeoutSeconds: 2 * 60 * 60,
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

const now = () => new Date().toISOString();

/**
 * One iteration's prompt: the base prompt, then runner feedback from the
 * previous iteration, then operator steering notes. Exported for tests.
 */
export const composePrompt = (
  base: string,
  notes: ReadonlyArray<string>,
  feedback: ReadonlyArray<string> = [],
): string => {
  let out = base;
  if (feedback.length > 0) {
    out += `\n\n## Runner feedback from the previous iteration\n\n${feedback.join("\n\n")}`;
  }
  if (notes.length > 0) {
    out += `\n\n## Operator notes for this iteration\n\nThe human supervising this loop added:\n\n${notes
      .map((n) => `- ${n}`)
      .join("\n")}`;
  }
  return out;
};

const statusFor = (reason: StopReason): Instance["status"] => {
  switch (reason) {
    case "interrupted":
    case "operator_stop":
      return "stopped";
    case "max_iterations":
    case "complete":
    case "plan_complete":
    case "plan_exhausted":
    case "plan_converged":
    case "no_progress":
      return "finished";
    default:
      return "failed";
  }
};

export const runLoop = (cfg: LoopConfig) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* checkBinary(cfg.harness);
    const dir = nodePath.resolve(cfg.dir);
    const runId = newRunId();
    const policy = cfg.policy ?? fixedPrompt(cfg.prompt);

    yield* store.create({
      id: runId,
      name: cfg.name,
      pid: process.pid,
      harness: cfg.harness.id,
      model: cfg.model,
      effort: cfg.effort,
      dir,
      prompt: cfg.prompt,
      maxIterations: cfg.maxIterations,
      marathon: cfg.marathon,
      iterationTimeoutSeconds: cfg.iterationTimeoutSeconds,
      status: "running",
      currentIteration: 0,
      stopReason: null,
      startedAt: now(),
      updatedAt: now(),
      beadId: cfg.beadId,
      mode: policy.id,
      scope: cfg.scope ?? null,
      callbackUrl: cfg.callbackUrl ?? null,
    });

    let observer: Observer = noObserver;
    const emit = (iteration: number, e: LoopEvent) =>
      Effect.gen(function* () {
        const ev = { ...e, ts: now(), run: runId, instance: cfg.name, iteration } as RalphEvent;
        yield* store.appendEvent(ev);
        observer.record(ev);
        if (cfg.echo) {
          const line = formatLogLine(ev);
          if (line !== undefined) yield* Console.log(line);
        }
      });

    // ---- plan: persisted whenever it changes, so a finished run keeps its own plan
    const planSource = policy.plan;
    let planView: PlanView | null = null;
    let planKey: string | null = null;
    const publishPlan = (n: number, view: PlanView | undefined, final = false) =>
      Effect.suspend(() => {
        if (view === undefined) return Effect.void;
        const merged = keepLastGood(planView, view);
        const key = viewDigest(merged);
        if (!final && key === planKey) return Effect.void;
        planView = merged;
        planKey = key;
        observer.setPlan(merged);
        return emit(n, { type: "plan_updated", plan: merged, ...(final ? { final: true } : {}) });
      }).pipe(Effect.ignore);
    const publishLatest = (n: number) => publishPlan(n, planSource?.latest()?.view);
    const pollMs = cfg.planPollMs ?? (planSource?.backend === "beads" ? 5000 : 2000);
    /** Re-read the plan while the agent works (start / done transitions show up live). */
    const pollPlan = (
      n: number,
    ): Effect.Effect<never, never, ChildProcessSpawner.ChildProcessSpawner> =>
      planSource === undefined || pollMs <= 0
        ? Effect.never
        : Effect.forever(
            Effect.sleep(Duration.millis(pollMs)).pipe(
              Effect.andThen(planSource.read),
              Effect.flatMap((st) => publishPlan(n, st.view)),
            ),
          );

    const runIteration = (n: number, prompt: string) =>
      Effect.gen(function* () {
        const startedAt = now();
        const t0 = Date.now();
        const headBefore = yield* gitHead(dir);
        yield* policy.begin(n);
        yield* emit(n, { type: "iteration_started", prompt: clip(prompt, 500) });
        observer.iterationStarted(n);
        const tally = newTally();
        const drive = cfg.harness
          .run({
            prompt,
            model: cfg.model,
            effort: cfg.effort,
            dir,
            sessionName: `${cfg.name}-${n}`,
            onRaw: (line) => store.appendRaw(runId, n, line).pipe(Effect.ignore),
          })
          .pipe(
            Stream.catchTag("HarnessFailed", (e: HarnessFailed) =>
              Stream.fromIterable<HarnessEvent>([
                { type: "error", kind: "unknown", message: e.message },
                { type: "harness_exit", status: "failed", detail: e.reason },
              ]),
            ),
            Stream.runForEach((e) =>
              Effect.gen(function* () {
                tallyEvent(tally, e);
                yield* emit(n, e);
              }),
            ),
          );
        let recorded = false;
        const record = (
          outcome: IterationOutcome,
          review: Review | null,
          headAfterKnown?: string | null,
          stopping = false,
        ) =>
          Effect.gen(function* () {
            recorded = true;
            const durationMs = Date.now() - t0;
            const rec: IterationRecord = {
              iteration: n,
              outcome,
              startedAt,
              finishedAt: now(),
              durationMs,
              sessionId: tally.sessionId,
              attachId: tally.attachId,
              headBefore,
              headAfter: headAfterKnown === undefined ? yield* gitHead(dir) : headAfterKnown,
              inputTokens: tally.inputTokens,
              outputTokens: tally.outputTokens,
              costUsd:
                tally.costTotal ?? (tally.costIncremental > 0 ? tally.costIncremental : null),
              lastAssistant: tally.lastAssistant === null ? null : clip(tally.lastAssistant, 4000),
              error: tally.lastError,
              validateOk: review?.validateOk ?? null,
              planOpen: review?.planOpen ?? null,
            };
            yield* store.writeIteration(runId, rec);
            yield* emit(n, { type: "iteration_finished", outcome, durationMs });
            // Summaries never feed back into the loop. On a stop the observer
            // records an `interrupted` placeholder instead of calling the model.
            observer.iterationFinished(
              {
                iteration: n,
                outcome,
                durationMs,
                validateOk: rec.validateOk,
                committed:
                  rec.headBefore === null || rec.headAfter === null
                    ? null
                    : rec.headBefore !== rec.headAfter,
                error: rec.error,
              },
              stopping,
            );
          });
        // A timeout interrupts only the inner stream (running the harness finalizers:
        // stop the iteration's hc terminal). An outside stop interrupts
        // the whole iteration, which is recorded as `interrupted`.
        const bounded =
          cfg.iterationTimeoutSeconds > 0
            ? drive.pipe(
                Effect.timeoutOption(Duration.seconds(cfg.iterationTimeoutSeconds)),
                Effect.map(Option.isNone),
              )
            : drive.pipe(Effect.as(false));
        const body = Effect.gen(function* () {
          const timedOut = yield* Effect.raceFirst(bounded, pollPlan(n));
          if (timedOut) {
            tally.lastError = `iteration timed out after ${cfg.iterationTimeoutSeconds}s`;
            yield* emit(n, { type: "error", kind: "unknown", message: tally.lastError });
          }
          const outcome: IterationOutcome = timedOut ? "timed_out" : outcomeOf(tally);
          const headAfter = yield* gitHead(dir);
          // Runner-side review (validation, plan checks) only for iterations that finished.
          const review =
            outcome === "completed"
              ? yield* policy.review({
                  iteration: n,
                  headBefore,
                  headAfter,
                  lastAssistant: tally.lastAssistant,
                  runDir: store.runDir(runId),
                  emit: (e) => emit(n, e),
                })
              : null;
          yield* publishLatest(n);
          yield* record(outcome, review, headAfter);
          return { outcome, review };
        });
        return yield* body.pipe(
          Effect.onInterrupt(() =>
            recorded
              ? Effect.void
              : record("interrupted", null, undefined, true).pipe(Effect.ignore),
          ),
        );
      });

    const iterations = yield* Ref.make(0);

    const loop = Effect.gen(function* () {
      yield* emit(0, {
        type: "run_started",
        mode: policy.id,
        harness: cfg.harness.id,
        model: cfg.model,
        dir,
        maxIterations: cfg.maxIterations,
      });
      const observing = observerFor(cfg);
      // Always record the setting (also "off"), so the UI and restart know it.
      if (observing === false)
        yield* emit(0, {
          type: "observer_status",
          enabled: false,
          model: null,
          available: null,
          error: null,
          activityIntervalSeconds: null,
        }).pipe(Effect.ignore);
      else
        // The observer must never fail the run: a broken start just means no summaries.
        observer = yield* startObserver(observing, { name: cfg.name, mode: policy.id }, emit).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : emit(0, {
                  type: "observer_status",
                  enabled: true,
                  model: observing.model,
                  available: false,
                  error: `observer failed to start: ${clip(Cause.pretty(cause), 300)}`,
                  activityIntervalSeconds: Math.round(observing.activityIntervalMs / 1000),
                }).pipe(Effect.ignore, Effect.as(noObserver)),
          ),
        );
      const early = yield* policy.preflight((e) => emit(0, e));
      yield* publishLatest(0);
      if (early !== null) return early;
      let consecutiveFailures = 0;
      let feedback: ReadonlyArray<string> = [];
      for (let n = 1; ; n++) {
        if (cfg.maxIterations > 0 && n > cfg.maxIterations) return "max_iterations" as StopReason;
        // Steering is consumed only at iteration boundaries.
        const steers = yield* store.takeSteers(runId, n);
        for (const st of steers) {
          yield* emit(n, { type: "steer_received", id: st.id, kind: st.kind, text: st.text });
        }
        if (steers.some((st) => st.kind === "stop")) return "operator_stop" as StopReason;
        const prompt = composePrompt(
          yield* policy.prompt(n),
          steers.filter((st) => st.kind === "note").map((st) => st.text),
          feedback,
        );
        yield* store.update(runId, { currentIteration: n });
        const { outcome, review } = yield* runIteration(n, prompt);
        yield* Ref.set(iterations, n);
        feedback = review?.feedback ?? [];
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
          case "timed_out":
            consecutiveFailures++;
            if (consecutiveFailures >= cfg.maxConsecutiveFailures)
              return "harness_failed" as StopReason;
            break;
          case "completed":
            consecutiveFailures = 0;
            break;
        }
        if (review?.stop != null) return review.stop;
        yield* Effect.sleep(cfg.pauseBetween);
      }
    });

    const finish = (reason: StopReason, how: "drain" | "interrupt" = "drain") =>
      Effect.gen(function* () {
        const n = yield* Ref.get(iterations);
        // The run's final plan, persisted before run_finished. A stop does not wait on bd.
        if (planSource !== undefined) {
          const last =
            how === "drain"
              ? yield* planSource.read.pipe(
                  Effect.timeoutOption("15 seconds"),
                  Effect.map((o) => (Option.isSome(o) ? o.value.view : (planView ?? undefined))),
                )
              : (planView ?? undefined);
          yield* publishPlan(n, last, true);
        }
        // Every queued iteration summary is persisted before run_finished closes the stream.
        yield* observer.close(how);
        yield* store.update(runId, { status: statusFor(reason), stopReason: reason });
        yield* emit(n, { type: "run_finished", reason, iterations: n });
        if (cfg.callbackUrl != null) {
          const run = yield* store.get(runId);
          const result = yield* deliver(cfg.callbackUrl, yield* payloadFor(run, reason));
          yield* emit(n, { type: "notice", text: result });
        }
      }).pipe(Effect.ignore);

    return yield* loop.pipe(
      Effect.tap(finish),
      Effect.onInterrupt(() => finish("interrupted", "interrupt")),
      Effect.tapError(() => finish("harness_failed")),
      Effect.tapDefect(() => finish("harness_failed")),
      Effect.map((reason) => ({ runId, reason })),
    );
  }).pipe(Effect.scoped);
