/**
 * `ralph report <name>`: a read-only summary of what a run did — commits,
 * files, validation, plan delta, cost, and anything that needs a human.
 */
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { buildReport } from "../report.ts";
import { nameArg } from "./shared.ts";

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
