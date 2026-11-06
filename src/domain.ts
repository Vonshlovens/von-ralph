/**
 * Ralph domain: harness ids, normalized events, persisted records, errors.
 *
 * Every harness adapter turns its native stream into `HarnessEvent`s. The loop
 * wraps them into `RalphEvent`s (adding instance/iteration/timestamp) and
 * appends them to `events.jsonl`. Raw harness output is always kept beside
 * them, so a parser gap is an observability gap, never lost data.
 */
import { Data, Schema } from "effect";

export const HarnessId = Schema.Literals(["claude", "claude-print", "codex", "opencode", "gh"]);
export type HarnessId = typeof HarnessId.Type;
export const harnessIds: ReadonlyArray<HarnessId> = HarnessId.literals;

export type ErrorKind = "auth" | "rate_limit" | "context" | "api" | "unknown";

/** What a harness adapter emits while an iteration runs. */
export type HarnessEvent =
  | { readonly type: "session"; readonly sessionId: string; readonly attachId?: string | undefined }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call"; readonly name: string; readonly input: string }
  | { readonly type: "tool_result"; readonly output: string; readonly isError: boolean }
  | {
      readonly type: "usage";
      readonly inputTokens?: number | undefined;
      readonly outputTokens?: number | undefined;
      /** Incremental cost of this step (summed). */
      readonly costUsd?: number | undefined;
      /** Cumulative cost so far in this session (last value wins). */
      readonly totalCostUsd?: number | undefined;
    }
  | { readonly type: "error"; readonly kind: ErrorKind; readonly message: string }
  | { readonly type: "needs_input"; readonly reason: string }
  | { readonly type: "turn_end"; readonly durationMs?: number | undefined }
  /** Last event of every harness run: how the underlying process/session ended. */
  | {
      readonly type: "harness_exit";
      readonly status: "ok" | "failed" | "blocked" | "stopped";
      readonly detail?: string | undefined;
    };

/** Loop-level events, plus everything a harness emits. */
export type LoopEvent =
  | HarnessEvent
  | {
      readonly type: "run_started";
      readonly harness: HarnessId;
      readonly model: string | null;
      readonly dir: string;
      readonly maxIterations: number;
    }
  | { readonly type: "iteration_started"; readonly prompt: string }
  | {
      readonly type: "iteration_finished";
      readonly outcome: IterationOutcome;
      readonly durationMs: number;
    }
  | { readonly type: "rate_limit_sleep"; readonly seconds: number }
  | { readonly type: "run_finished"; readonly reason: StopReason; readonly iterations: number };

export type RalphEvent = LoopEvent & {
  readonly ts: string;
  readonly instance: string;
  readonly iteration: number;
};

export const IterationOutcome = Schema.Literals([
  "completed",
  "failed",
  "blocked",
  "rate_limited",
  "auth_failed",
  "interrupted",
]);
export type IterationOutcome = typeof IterationOutcome.Type;

export const StopReason = Schema.Literals([
  "max_iterations",
  "blocked",
  "rate_limited",
  "auth_failed",
  "harness_failed",
  "interrupted",
]);
export type StopReason = typeof StopReason.Type;

export const InstanceStatus = Schema.Literals(["running", "finished", "failed", "stopped"]);
export type InstanceStatus = typeof InstanceStatus.Type;

/** `~/.ralph/v2/instances/<name>/instance.json` */
export const Instance = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  pid: Schema.Number,
  harness: HarnessId,
  /** null = the harness CLI's own configured default */
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  dir: Schema.String,
  prompt: Schema.String,
  maxIterations: Schema.Number,
  marathon: Schema.Boolean,
  status: InstanceStatus,
  currentIteration: Schema.Number,
  stopReason: Schema.NullOr(StopReason),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  beadId: Schema.NullOr(Schema.String),
});
export type Instance = typeof Instance.Type;

/** `~/.ralph/v2/instances/<name>/iterations/<n>.json` */
export const IterationRecord = Schema.Struct({
  iteration: Schema.Number,
  outcome: IterationOutcome,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  durationMs: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  attachId: Schema.NullOr(Schema.String),
  headBefore: Schema.NullOr(Schema.String),
  headAfter: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  lastAssistant: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type IterationRecord = typeof IterationRecord.Type;

// ---------------------------------------------------------------- errors

export class HarnessUnavailable extends Data.TaggedError("HarnessUnavailable")<{
  readonly harness: HarnessId;
  readonly binary: string;
  readonly hint: string;
}> {
  override get message() {
    return `harness '${this.harness}' requires '${this.binary}' on PATH. ${this.hint}`;
  }
}

export class HarnessFailed extends Data.TaggedError("HarnessFailed")<{
  readonly harness: HarnessId;
  readonly reason: string;
}> {
  override get message() {
    return `${this.harness}: ${this.reason}`;
  }
}

export class StateError extends Data.TaggedError("StateError")<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message() {
    return `state ${this.path}: ${this.reason}`;
  }
}

/** Clip long text for logs and events (raw output is kept separately). */
export const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;

/** Best-effort error classification shared by every harness parser. */
export const classifyError = (message: string): ErrorKind => {
  const m = message.toLowerCase();
  if (/hit your limit|rate.?limit|usage limit|429|too many requests|quota/.test(m))
    return "rate_limit";
  if (/\/login|unauthori[sz]ed|authentication|401|403|invalid api key|not logged in/.test(m))
    return "auth";
  if (/prompt is too long|context (limit|window|length)|exceed context/.test(m)) return "context";
  return "unknown";
};
