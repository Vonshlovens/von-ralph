/** Operator actions on a run, shared by the CLI and `ralph serve`. */
import { Effect, Option, Schedule } from "effect";
import { type Instance, StateError } from "./domain.ts";
import { Store, isAlive } from "./store.ts";

export interface StopResult {
  readonly state: "not_running" | "already_gone" | "stopping" | "stopped" | "killed";
  readonly message: string;
}

/** Queue a note for the next iteration's prompt; returns the steer id. */
export const steerRun = (r: Instance, text: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (r.status !== "running") {
      return yield* new StateError({ path: r.name, reason: `run ${r.id} is ${r.status}` });
    }
    return yield* store.addSteer(r.id, "note", text);
  });

/** Stop now (SIGTERM, then SIGKILL after 20s) or gracefully after the current iteration. */
export const stopRun = (r: Instance, graceful: boolean) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const result = (state: StopResult["state"], message: string): StopResult => ({
      state,
      message,
    });
    if (r.status !== "running") {
      return result("not_running", `${r.name} is not running (${r.status})`);
    }
    if (!isAlive(r.pid)) {
      yield* store.update(r.id, { status: "failed", stopReason: "crashed" });
      return result(
        "already_gone",
        `${r.name}: process ${r.pid} was already gone (marked crashed)`,
      );
    }
    if (graceful) {
      yield* store.addSteer(r.id, "stop", "stop requested by operator");
      return result("stopping", `🧭 ${r.name} will stop after the current iteration`);
    }
    process.kill(r.pid, "SIGTERM");
    // The runner stops its agent terminal and records `stopped`; give it time.
    const done = yield* store.get(r.id).pipe(
      Effect.flatMap((cur) =>
        cur.status === "running" && isAlive(r.pid)
          ? Effect.fail(new StateError({ path: r.id, reason: "still running" }))
          : Effect.succeed(cur),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
      Effect.option,
    );
    if (Option.isNone(done)) {
      if (isAlive(r.pid)) process.kill(r.pid, "SIGKILL");
      yield* store.update(r.id, { status: "failed", stopReason: "crashed" });
      return result("killed", `⚠️  ${r.name} did not stop within 20s; killed (pid ${r.pid})`);
    }
    return result("stopped", `🛑 ${r.name} stopped`);
  });
