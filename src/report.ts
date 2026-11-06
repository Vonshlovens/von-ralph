/**
 * A run's summary — commits, files, validation, plan delta, cost, and
 * anything that needs a human. Used by `ralph report`, `ralph serve`, and
 * completion callbacks.
 */
import { Effect } from "effect";
import type { IterationRecord, RalphEvent } from "./domain.ts";
import * as Git from "./git.ts";
import { readPlan } from "./plan.ts";
import { loadProject, resolveBackend } from "./project.ts";
import { Store } from "./store.ts";

type Ev<T extends RalphEvent["type"]> = Extract<RalphEvent, { type: T }>;

export const buildReport = (nameOrId: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const run = yield* store.get(nameOrId);
    const its = yield* store.iterations(run.id);
    const events: Array<RalphEvent> = [];
    let after = 0;
    while (true) {
      const page = yield* store.events(run.id, { afterId: after, limit: 5000 });
      if (page.length === 0) break;
      for (const e of page) events.push(e.event);
      after = page.at(-1)?.id ?? after;
    }
    const of = <T extends RalphEvent["type"]>(t: T) =>
      events.filter((e): e is Ev<T> => e.type === t);

    const first = its.find((i) => i.headBefore !== null);
    const last = [...its].reverse().find((i) => i.headAfter !== null);
    const from = first?.headBefore ?? null;
    const to = last?.headAfter ?? null;
    const commits = from !== null && to !== null ? yield* Git.log(run.dir, from, to) : [];
    const diffStat =
      from !== null && to !== null && from !== to ? yield* Git.diffStat(run.dir, from, to) : "";

    const plans = of("plan_status");
    const validates = of("validate");
    const lastValidate = validates.at(-1);
    const finished = of("run_finished").at(-1);
    const sum = (f: (i: IterationRecord) => number) => its.reduce((s, i) => s + f(i), 0);
    const startedMs = Date.parse(run.startedAt);
    const endMs =
      its.length > 0
        ? Date.parse(its.at(-1)?.finishedAt ?? run.updatedAt)
        : Date.parse(run.updatedAt);

    const needsHuman: Array<string> = [];
    for (const e of of("needs_input")) needsHuman.push(`iteration ${e.iteration}: ${e.reason}`);
    for (const e of of("scope_violation"))
      needsHuman.push(
        `iteration ${e.iteration} changed files outside its scope: ${e.files.join(", ")} (diff ${e.diffPath ?? "-"})`,
      );
    if (lastValidate !== undefined && !lastValidate.ok)
      needsHuman.push("the last validation failed");
    if (run.stopReason === "plan_exhausted")
      needsHuman.push("open plan items remain but none are ready (blocked or waiting)");
    // Blocked items carry the question for the human (markdown plan; Beads: `bd blocked`).
    if (run.mode === "plan" || run.mode === "build") {
      const project = yield* loadProject(run.dir).pipe(Effect.option);
      if (project._tag === "Some" && resolveBackend(project.value) === "markdown") {
        const plan = yield* readPlan(run.dir).pipe(Effect.option);
        if (plan._tag === "Some") {
          for (const it of plan.value.items.filter((i) => i.status === "blocked")) {
            needsHuman.push(
              `${it.id} blocked: ${it.title}${it.notes.length > 0 ? ` — ${it.notes.at(-1)}` : ""}`,
            );
          }
        }
      } else if (project._tag === "Some") {
        needsHuman.push("see `bd blocked` for beads waiting on a human");
      }
    }
    if (run.stopReason === "no_progress") needsHuman.push("the loop stopped making progress");
    if (
      run.stopReason === "auth_failed" ||
      run.stopReason === "rate_limited" ||
      run.stopReason === "blocked"
    )
      needsHuman.push(`stopped: ${run.stopReason}`);

    return {
      run,
      stopReason: run.stopReason,
      iterations: its.length,
      durationMs: Math.max(0, endMs - startedMs),
      outcomes: Object.fromEntries(
        [...new Set(its.map((i) => i.outcome))].map((o) => [
          o,
          its.filter((i) => i.outcome === o).length,
        ]),
      ),
      tokens: { input: sum((i) => i.inputTokens), output: sum((i) => i.outputTokens) },
      costUsd: sum((i) => i.costUsd ?? 0),
      commits,
      diffStat,
      plan:
        plans.length === 0
          ? null
          : {
              backend: plans[0]?.backend,
              before: { open: plans[0]?.open, total: plans[0]?.total },
              after: {
                open: plans.at(-1)?.open,
                total: plans.at(-1)?.total,
                ready: plans.at(-1)?.actionable,
              },
            },
      validate: {
        runs: validates.length,
        failures: validates.filter((v) => !v.ok).length,
        last: lastValidate ?? null,
      },
      needsHuman,
      lastWords: its.at(-1)?.lastAssistant ?? null,
      finishedAt: finished?.ts ?? null,
      logPath: store.logPath(run.id),
    };
  });

export type Report = Effect.Success<ReturnType<typeof buildReport>>;
