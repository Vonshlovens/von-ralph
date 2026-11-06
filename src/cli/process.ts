/**
 * The Ralph process as commands: init → spec / reverse → plan → build, plus
 * `sign` for tuning. See docs/ralph-v2-design.md §2.
 */
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type HarnessId, StateError, harnessIds } from "../domain.ts";
import { checkBinary } from "../harness.ts";
import { defaults, runLoop } from "../loop.ts";
import {
  defaultTemplate,
  ensureInitialized,
  loadTemplate,
  modePolicy,
  promptVars,
} from "../modes.ts";
import { emptyPlan, writePlan } from "../plan.ts";
import { capture } from "../proc.ts";
import {
  configPath,
  detectSource,
  detectValidate,
  loadProject,
  planJsonPath,
  promptPath,
  resolveBackend,
} from "../project.ts";
import { harnesses } from "../registry.ts";
import { Store } from "../store.ts";
import * as T from "../templates.ts";
import { exitCodeFor, runArgv, safeName, spawnDetached } from "./shared.ts";

const dirFlag = Flag.String("dir").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Project directory (default: cwd)"),
  Flag.optional,
);

const resolveDir = (d: Option.Option<string>) =>
  path.resolve(Option.getOrElse(d, () => process.cwd()));

// ------------------------------------------------------------------- init

const writeNew = (file: string, text: string, force: boolean) => {
  const existed = fs.existsSync(file);
  if (existed && !force) return "kept";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return existed ? "overwrote" : "created";
};

export const init = Command.make(
  "init",
  {
    dir: dirFlag,
    backend: Flag.Literals("backend", ["auto", "beads", "markdown"] as const).pipe(
      Flag.withDescription("Plan backend: auto (beads if .beads/ exists), beads, markdown"),
      Flag.withDefault("auto" as const),
    ),
    harness: Flag.Literals("harness", harnessIds).pipe(
      Flag.withAlias("H"),
      Flag.withDescription("Default harness for this project"),
      Flag.withDefault("claude" as HarnessId),
    ),
    goal: Flag.String("goal").pipe(
      Flag.withDescription("One-line project goal for the prompts"),
      Flag.optional,
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Overwrite .ralph/ files (never AGENTS.md, specs, or the plan)"),
      Flag.withDefault(false),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const dir = resolveDir(a.dir);
      if (!fs.existsSync(dir)) {
        return yield* new StateError({ path: dir, reason: "directory does not exist" });
      }
      const validate = detectValidate(dir);
      const source = detectSource(dir);
      const goal = Option.getOrNull(a.goal);
      const lines: Array<string> = [];
      const note = (status: string, file: string) =>
        lines.push(`  ${status.padEnd(9)} ${path.relative(dir, file) || file}`);

      note(
        writeNew(
          configPath(dir),
          T.ralphToml({ harness: a.harness, backend: a.backend, goal, source, validate }),
          a.force,
        ),
        configPath(dir),
      );
      for (const name of ["plan", "build", "reverse", "spec"] as const) {
        note(
          writeNew(promptPath(dir, name), defaultTemplate(name), a.force),
          promptPath(dir, name),
        );
      }
      const agents = path.join(dir, "AGENTS.md");
      note(writeNew(agents, T.agentsMd(validate), false), agents);
      const claudeMd = path.join(dir, "CLAUDE.md");
      // Claude Code reads CLAUDE.md, not AGENTS.md: import it.
      note(writeNew(claudeMd, "@AGENTS.md\n", false), claudeMd);
      const specs = path.join(dir, "specs", "README.md");
      note(writeNew(specs, T.SPECS_README, false), specs);

      const project = yield* loadProject(dir);
      const backend = resolveBackend(project);
      if (backend === "markdown") {
        if (!fs.existsSync(planJsonPath(dir))) {
          yield* writePlan(dir, project.plan.file, emptyPlan(goal));
          note("created", planJsonPath(dir));
          note("created", path.join(dir, project.plan.file));
        } else note("kept", planJsonPath(dir));
      }

      const warnings: Array<string> = [];
      if (!fs.existsSync(path.join(dir, ".git"))) {
        warnings.push("not a git repository: ralph relies on git for progress and scope checks");
      }
      if (backend === "beads" && !fs.existsSync(path.join(dir, ".beads"))) {
        warnings.push("backend is beads but there is no .beads/ here: run `bd init` first");
      }
      if (validate.length === 0) {
        warnings.push(
          "no validate commands detected: set [validate].commands in .ralph/ralph.toml",
        );
      }

      yield* Console.log(
        [
          `Initialized ralph in ${dir} (plan backend: ${backend}${a.backend === "auto" ? ", auto" : ""})`,
          ...lines,
          ...(validate.length > 0 ? [`  validate: ${validate.join(" && ")}`] : []),
          ...warnings.map((w) => `⚠️  ${w}`),
          "",
          "Next:",
          "  1. Fill in AGENTS.md (build / run / validate) and check .ralph/ralph.toml.",
          '  2. ralph-next spec "<topic>"   write specs with an interactive agent (you own them)',
          "     ralph-next reverse          or derive specs from existing code (brownfield)",
          "  3. ralph-next plan             gap analysis → plan; review it before building",
          "  4. ralph-next build --detach   one plan item per iteration; ralph-next watch <name>",
          '  5. ralph-next sign "<rule>"    add a guardrail when you see the loop misbehave',
        ].join("\n"),
      );
    }),
).pipe(
  Command.withDescription("Scaffold .ralph/ (config, prompts), AGENTS.md, specs/ and the plan"),
);

// -------------------------------------------------------------- loop modes

type LoopMode = "plan" | "build" | "reverse";

const describe: Record<LoopMode, string> = {
  plan: "Planning loop: gap analysis of specs vs code → plan (no code changes); stops when the plan stops changing",
  build:
    "Build loop: one plan item per iteration, runner-side validation, stops when the plan is done",
  reverse: "Reverse-engineering loop: write specs/ from existing code (brownfield)",
};

const modeCommand = (mode: LoopMode) =>
  Command.make(
    mode,
    {
      dir: dirFlag,
      name: Flag.String("name").pipe(
        Flag.withAlias("n"),
        Flag.withDescription(`Ralph name (default: ${mode}-<dir name>)`),
        Flag.optional,
      ),
      harness: Flag.Literals("harness", harnessIds).pipe(
        Flag.withAlias("H"),
        Flag.withDescription("Agent harness (default: ralph.toml, else claude)"),
        Flag.optional,
      ),
      model: Flag.String("model").pipe(Flag.withAlias("m"), Flag.optional),
      effort: Flag.String("effort").pipe(Flag.withAlias("e"), Flag.optional),
      max: Flag.Int("max").pipe(
        Flag.withAlias("N"),
        Flag.withDescription(`Max iterations (default: [limits].${mode}_iterations)`),
        Flag.optional,
      ),
      timeout: Flag.Int("timeout").pipe(
        Flag.withDescription("Per-iteration timeout in minutes, 0 = none"),
        Flag.optional,
      ),
      scope: Flag.String("scope").pipe(
        Flag.withDescription("Limit the work to this area (free text, e.g. a feature or branch)"),
        Flag.optional,
      ),
      bead: Flag.String("bead").pipe(
        Flag.withDescription("Beads backend: work on this one bead only (build)"),
        Flag.optional,
      ),
      marathon: Flag.Boolean("marathon").pipe(
        Flag.withDescription("On rate limit, sleep 30 min and continue"),
        Flag.withDefault(false),
      ),
      detach: Flag.Boolean("detach").pipe(
        Flag.withDescription("Run in the background; prints the run id"),
        Flag.withDefault(false),
      ),
      quiet: Flag.Boolean("quiet").pipe(Flag.withAlias("q"), Flag.withDefault(false)),
    },
    (a) =>
      Effect.gen(function* () {
        const dir = resolveDir(a.dir);
        const project = yield* loadProject(dir);
        yield* ensureInitialized(project, mode);
        const harnessId = Option.getOrElse(a.harness, () => project.harness ?? "claude");
        const harness = harnesses[harnessId];
        yield* checkBinary(harness);
        const backend = resolveBackend(project);
        if (backend === "beads" && mode !== "reverse") {
          const bd = yield* capture("sh", ["-c", "command -v bd"], { cwd: dir });
          if (bd.exitCode !== 0) {
            return yield* new StateError({
              path: dir,
              reason: "plan backend is beads but `bd` is not on PATH",
            });
          }
        }
        const limit = {
          plan: project.limits.planIterations,
          build: project.limits.buildIterations,
          reverse: project.limits.reverseIterations,
        }[mode];
        const scope = Option.getOrNull(a.scope);
        const bead = Option.getOrNull(a.bead);
        const spec = {
          mode,
          name: Option.getOrElse(a.name, () => safeName(`${mode}-${path.basename(dir)}`)),
          prompt: [
            `[${mode}] ${fs.existsSync(promptPath(dir, mode)) ? `.ralph/prompts/${mode}.md` : "built-in prompt"}`,
            `plan: ${mode === "reverse" ? "specs/" : backend}`,
            ...(scope === null ? [] : [`scope: ${scope}`]),
            ...(bead === null ? [] : [`bead: ${bead}`]),
          ].join(" · "),
          dir,
          harness: harnessId,
          model: Option.getOrElse(a.model, () => project.model ?? harness.defaultModel),
          effort: Option.getOrElse(a.effort, () => project.effort ?? harness.defaultEffort) ?? null,
          maxIterations: Option.getOrElse(a.max, () => limit),
          marathon: a.marathon,
          iterationTimeoutSeconds:
            Option.getOrElse(a.timeout, () => project.limits.iterationTimeoutMinutes) * 60,
          beadId: bead,
          scope,
        };
        if (a.detach) return yield* spawnDetached(runArgv(spec), spec.name, dir);
        const { reason } = yield* runLoop({
          ...spec,
          harness,
          policy: modePolicy({ mode, project, scope, bead }),
          rateLimitSleepSeconds: defaults.rateLimitSleepSeconds,
          pauseBetween: defaults.pauseBetween,
          maxConsecutiveFailures: defaults.maxConsecutiveFailures,
          echo: !a.quiet,
        });
        if (mode === "plan" && !a.quiet) {
          // The plan is the cheapest place to catch a bad direction: show it.
          yield* Console.log(`\n${"─".repeat(72)}\nPlan for review (${backend}):\n`);
          if (backend === "markdown") {
            const file = path.join(dir, project.plan.file);
            yield* Console.log(
              fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(no plan file)",
            );
          } else {
            const out = yield* capture("bd", ["list", "--flat", ...beadsListFlags(project)], {
              cwd: dir,
            });
            yield* Console.log(out.stdout.trim() === "" ? out.stderr : out.stdout);
          }
        }
        process.exitCode = exitCodeFor(reason);
      }),
  ).pipe(Command.withDescription(describe[mode]));

const beadsListFlags = (p: { plan: { label: string | null; parent: string | null } }) => [
  ...(p.plan.label === null ? [] : ["--label", p.plan.label]),
  ...(p.plan.parent === null ? [] : ["--parent", p.plan.parent]),
];

export const plan = modeCommand("plan");
export const build = modeCommand("build");
export const reverse = modeCommand("reverse");

// ------------------------------------------------------------------- spec

export const spec = Command.make(
  "spec",
  {
    topic: Argument.String("topic").pipe(
      Argument.withDescription("What to specify (optional)"),
      Argument.optional,
    ),
    dir: dirFlag,
    harness: Flag.Literals("harness", ["claude", "codex"] as const).pipe(
      Flag.withAlias("H"),
      Flag.withDescription("Interactive agent: claude (default) or codex"),
      Flag.withDefault("claude" as const),
    ),
    model: Flag.String("model").pipe(Flag.withAlias("m"), Flag.optional),
  },
  (a) =>
    Effect.gen(function* () {
      const dir = resolveDir(a.dir);
      const project = yield* loadProject(dir);
      const topic = Option.getOrNull(a.topic);
      const system = T.render(
        loadTemplate(dir, "spec"),
        promptVars({ mode: "plan", project, scope: topic, bead: null }, resolveBackend(project)),
      );
      const kickoff =
        topic === null
          ? "Let's write the specs for this project. Read what exists first, then interview me."
          : `Let's write the specs for: ${topic}. Read what exists first, then interview me.`;
      const model = Option.getOrElse(a.model, () => project.model);
      yield* checkBinary(harnesses[a.harness]);
      // A normal foreground interactive session: the human owns this step.
      const args =
        a.harness === "claude"
          ? [
              ...(model === null ? [] : ["--model", model]),
              "--append-system-prompt",
              system,
              kickoff,
            ]
          : [...(model === null ? [] : ["-m", model]), `${system}\n\n${kickoff}`];
      const r = yield* Effect.sync(() =>
        spawnSync(a.harness, args, { cwd: dir, stdio: "inherit" }),
      );
      if (r.status !== 0) process.exitCode = r.status ?? 1;
    }),
).pipe(
  Command.withDescription(
    "Interactive spec session (Claude Code or Codex): interview → specs/*.md. Not a loop.",
  ),
);

// ------------------------------------------------------------------- sign

/** Append a numbered guardrail ("sign") to a prompt template. Exported for tests. */
export const addSign = (template: string, text: string): { text: string; nines: string } => {
  const lines = template.split("\n");
  let last = -1;
  let most = 4;
  lines.forEach((l, i) => {
    const m = /^(9+)\.\s/.exec(l);
    if (m?.[1] !== undefined) {
      last = i;
      most = Math.max(most, m[1].length);
    }
  });
  const nines = "9".repeat(most + 1);
  const entry = `${nines}. ${text.trim().replace(/\n+/g, " ")}`;
  if (last === -1) {
    const body = template.replace(/\s*$/, "");
    return { text: `${body}\n\n## Signs\n\n${entry}\n`, nines };
  }
  // Insert after the last sign and its indented continuation lines.
  let end = last + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end++;
  lines.splice(end, 0, entry);
  return { text: lines.join("\n"), nines };
};

export const sign = Command.make(
  "sign",
  {
    text: Argument.String("text").pipe(Argument.withDescription("The guardrail to add")),
    name: Flag.String("name").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("Ralph whose project to sign (default: --dir / cwd)"),
      Flag.optional,
    ),
    dir: dirFlag,
    prompt: Flag.Literals("prompt", ["build", "plan", "reverse"] as const).pipe(
      Flag.withDescription("Which prompt gets the sign"),
      Flag.withDefault("build" as const),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const run = Option.isSome(a.name) ? yield* store.get(a.name.value) : null;
      const dir = run !== null ? run.dir : resolveDir(a.dir);
      const project = yield* loadProject(dir);
      yield* ensureInitialized(project, "sign");
      const file = promptPath(dir, a.prompt);
      const current = loadTemplate(dir, a.prompt);
      const { text, nines } = addSign(current, a.text);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      const live = run !== null && run.status === "running";
      yield* Console.log(
        `🪧 added sign ${nines}. to ${path.relative(process.cwd(), file) || file}${
          live ? `; ${run.name} picks it up at its next iteration` : ""
        }`,
      );
    }),
).pipe(
  Command.withDescription(
    "Add a guardrail to .ralph/prompts/<prompt>.md (applies from the next iteration)",
  ),
);
