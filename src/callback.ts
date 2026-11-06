/**
 * Completion callbacks: when a run ends, POST a JSON summary to the run's
 * `callback_url` (n8n's `$execution.resumeUrl`, ntfy, a Beadsmith hook, …).
 *
 * With `RALPH_CALLBACK_SECRET` set, the request carries
 * `X-Ralph-Timestamp: <unix seconds>` and
 * `X-Ralph-Signature: sha256=<hex HMAC of "<timestamp>.<body>">`.
 * `RALPH_CALLBACK_SECRET_FILE` names a file holding the secret instead
 * (what scheduled units use, so the secret never lands in a unit file).
 */
import { Duration, Effect, Schedule } from "effect";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import type { Instance, StopReason } from "./domain.ts";
import { exitCodeFor } from "./exitCodes.ts";
import { type Report, buildReport } from "./report.ts";

export interface CallbackPayload {
  readonly event: "run_finished";
  readonly run: Instance;
  readonly reason: StopReason;
  /** Same as the CLI's exit code: 0 done, 3 needs a human, 1 failed, 130 interrupted. */
  readonly exitCode: number;
  readonly needsHuman: boolean;
  readonly report: Omit<Report, "run"> | null;
}

export const isCallbackUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const callbackSecret = (): string | undefined => {
  const file = process.env.RALPH_CALLBACK_SECRET_FILE;
  if (file !== undefined && file !== "") {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      return undefined;
    }
  }
  return process.env.RALPH_CALLBACK_SECRET;
};

export const sign = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

export const payloadFor = (run: Instance, reason: StopReason) =>
  buildReport(run.id).pipe(
    Effect.map(({ run: _run, ...report }) => report),
    Effect.orElseSucceed(() => null),
    Effect.map((report): CallbackPayload => ({
      event: "run_finished",
      run,
      reason,
      exitCode: exitCodeFor(reason),
      needsHuman: exitCodeFor(reason) !== 0 || (report?.needsHuman.length ?? 0) > 0,
      report,
    })),
  );

/** POST the payload (3 attempts, 10s each). Returns a one-line result for the log. */
export const deliver = (url: string, payload: CallbackPayload) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "ralph-callback/1",
    };
    const secret = callbackSecret();
    if (secret !== undefined && secret !== "") {
      const ts = String(Math.floor(Date.now() / 1000));
      headers["x-ralph-timestamp"] = ts;
      headers["x-ralph-signature"] = sign(secret, ts, body);
    }
    const status = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { method: "POST", headers, body, signal }),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    }).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.flatMap((res) =>
        res.ok ? Effect.succeed(res.status) : Effect.fail(`HTTP ${res.status}`),
      ),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 2 }),
      Effect.map((s) => `callback delivered (HTTP ${s})`),
      Effect.catch((e) => Effect.succeed(`callback failed: ${String(e)}`)),
    );
    return status;
  });
