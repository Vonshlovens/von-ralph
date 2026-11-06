/**
 * `ralph-next report <name>`: a read-only summary of what a run did — commits,
 * files, validation, plan delta, cost, and anything that needs a human.
 */
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type { IterationRecord, RalphEvent } from "../domain.ts";
import * as Git from "../git.ts";
import { Store } from "../store.ts";
import { nameArg } from "./shared.ts";

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

const mins = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

export const report = Command.make(
  "report",
  { name: nameArg, json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  (a) =>
    Effect.gen(function* () {
      const r = yield* buildReport(a.name);
      if (a.json) return yield* Console.log(JSON.stringify(r, null, 2));
      const outcomes = Object.entries(r.outcomes)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      const lines = [
        `# ${r.run.name} — ${r.run.mode} (${r.run.status}${r.stopReason === null ? "" : `: ${r.stopReason}`})`,
        "",
        `run ${r.run.id} · ${r.run.harness}${r.run.model === null ? "" : `/${r.run.model}`} · ${r.run.dir}`,
        `${r.iterations} iterations (${outcomes || "none"}) in ${mins(r.durationMs)} · tokens in ${r.tokens.input} out ${r.tokens.output}${r.costUsd > 0 ? ` · $${r.costUsd.toFixed(2)}` : ""}`,
        "",
      ];
      if (r.plan !== null) {
        lines.push(
          `## Plan (${r.plan.backend})`,
          "",
          `open ${r.plan.before.open}/${r.plan.before.total} → ${r.plan.after.open}/${r.plan.after.total} (${r.plan.after.ready} ready)`,
          "",
        );
      }
      if (r.validate.runs > 0) {
        const l = r.validate.last;
        lines.push(
          "## Validation",
          "",
          `${r.validate.runs} runs, ${r.validate.failures} failed; last: ${l === null ? "-" : l.ok ? "passed" : "FAILED"}`,
          ...(l !== null && !l.ok
            ? l.results
                .filter((x) => x.exitCode !== 0)
                .map(
                  (x) =>
                    `\n\`${x.command}\` → ${x.exitCode ?? "timeout"}\n\n\`\`\`\n${x.output.slice(-1500)}\n\`\`\``,
                )
            : []),
          "",
        );
      }
      lines.push(
        `## Commits (${r.commits.length})`,
        "",
        ...(r.commits.length > 0 ? r.commits.map((c) => `- ${c}`) : ["(none)"]),
        "",
      );
      if (r.diffStat !== "") lines.push("```", r.diffStat, "```", "");
      if (r.needsHuman.length > 0)
        lines.push("## Needs a human", "", ...r.needsHuman.map((n) => `- ${n}`), "");
      if (r.lastWords !== null) lines.push("## Last message", "", r.lastWords.slice(0, 1500), "");
      lines.push(`log: ${r.logPath}`);
      yield* Console.log(lines.join("\n"));
    }),
).pipe(
  Command.withDescription(
    "Summarize a run: commits, files, validation, plan delta, cost, open questions",
  ),
);
