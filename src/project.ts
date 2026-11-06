/**
 * Per-project Ralph setup: `.ralph/ralph.toml` (harness, plan backend, validate
 * commands, limits) and the prompt templates under `.ralph/prompts/`.
 *
 * Precedence everywhere: CLI flag > ralph.toml > built-in default.
 */
import { Effect, Schema } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { HarnessId, type PlanBackendId, StateError } from "./domain.ts";

const PlanBackendSetting = Schema.Literals(["auto", "beads", "markdown"]);
export type PlanBackendSetting = typeof PlanBackendSetting.Type;

const str = Schema.optionalKey(Schema.String);
const num = Schema.optionalKey(Schema.Number);

/** ralph.toml as written (snake_case, everything optional). */
const ConfigFile = Schema.Struct({
  harness: Schema.optionalKey(HarnessId),
  model: str,
  effort: str,
  project: Schema.optionalKey(
    Schema.Struct({ goal: str, source: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  plan: Schema.optionalKey(
    Schema.Struct({
      backend: Schema.optionalKey(PlanBackendSetting),
      file: str,
      label: str,
      parent: str,
    }),
  ),
  validate: Schema.optionalKey(
    Schema.Struct({
      commands: Schema.optionalKey(Schema.Array(Schema.String)),
      timeout_minutes: num,
    }),
  ),
  limits: Schema.optionalKey(
    Schema.Struct({
      plan_iterations: num,
      build_iterations: num,
      reverse_iterations: num,
      no_progress_iterations: num,
      max_validate_failures: num,
      iteration_timeout_minutes: num,
    }),
  ),
  git: Schema.optionalKey(Schema.Struct({ push: Schema.optionalKey(Schema.Boolean) })),
});

export interface ProjectConfig {
  readonly dir: string;
  /** Whether `.ralph/ralph.toml` exists. */
  readonly initialized: boolean;
  readonly harness: HarnessId | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly goal: string | null;
  readonly source: ReadonlyArray<string>;
  readonly plan: {
    readonly backend: PlanBackendSetting;
    readonly file: string;
    readonly label: string | null;
    readonly parent: string | null;
  };
  readonly validate: { readonly commands: ReadonlyArray<string>; readonly timeoutMinutes: number };
  readonly limits: {
    readonly planIterations: number;
    readonly buildIterations: number;
    readonly reverseIterations: number;
    readonly noProgressIterations: number;
    readonly maxValidateFailures: number;
    readonly iterationTimeoutMinutes: number;
  };
  readonly git: { readonly push: boolean };
}

export const ralphDir = (dir: string) => path.join(dir, ".ralph");
export const configPath = (dir: string) => path.join(ralphDir(dir), "ralph.toml");
export const promptPath = (dir: string, name: PromptName) =>
  path.join(ralphDir(dir), "prompts", `${name}.md`);
export const planJsonPath = (dir: string) => path.join(ralphDir(dir), "plan.json");

export type PromptName = "plan" | "build" | "reverse" | "spec";

const nonEmpty = (s: string | undefined): string | null =>
  s === undefined || s.trim() === "" ? null : s;

export const defaultsFor = (dir: string): ProjectConfig => ({
  dir,
  initialized: false,
  harness: null,
  model: null,
  effort: null,
  goal: null,
  source: [],
  plan: { backend: "auto", file: "IMPLEMENTATION_PLAN.md", label: null, parent: null },
  validate: { commands: [], timeoutMinutes: 20 },
  limits: {
    planIterations: 2,
    buildIterations: 20,
    reverseIterations: 3,
    noProgressIterations: 3,
    maxValidateFailures: 3,
    iterationTimeoutMinutes: 120,
  },
  git: { push: false },
});

const decodeConfig = Schema.decodeUnknownEffect(ConfigFile);

/** Load `<dir>/.ralph/ralph.toml`, or defaults when the project is not initialized. */
export const loadProject = (dir: string): Effect.Effect<ProjectConfig, StateError> =>
  Effect.gen(function* () {
    const file = configPath(dir);
    const d = defaultsFor(dir);
    if (!fs.existsSync(file)) return d;
    const raw = yield* Effect.try({
      try: () => parseToml(fs.readFileSync(file, "utf8")),
      catch: (e) => new StateError({ path: file, reason: `invalid TOML: ${String(e)}` }),
    });
    const c = yield* decodeConfig(raw).pipe(
      Effect.mapError((e) => new StateError({ path: file, reason: e.message })),
    );
    const l = c.limits ?? {};
    return {
      dir,
      initialized: true,
      harness: c.harness ?? null,
      model: nonEmpty(c.model),
      effort: nonEmpty(c.effort),
      goal: nonEmpty(c.project?.goal),
      source: c.project?.source ?? d.source,
      plan: {
        backend: c.plan?.backend ?? d.plan.backend,
        file: nonEmpty(c.plan?.file) ?? d.plan.file,
        label: nonEmpty(c.plan?.label),
        parent: nonEmpty(c.plan?.parent),
      },
      validate: {
        commands: c.validate?.commands ?? [],
        timeoutMinutes: c.validate?.timeout_minutes ?? d.validate.timeoutMinutes,
      },
      limits: {
        planIterations: l.plan_iterations ?? d.limits.planIterations,
        buildIterations: l.build_iterations ?? d.limits.buildIterations,
        reverseIterations: l.reverse_iterations ?? d.limits.reverseIterations,
        noProgressIterations: l.no_progress_iterations ?? d.limits.noProgressIterations,
        maxValidateFailures: l.max_validate_failures ?? d.limits.maxValidateFailures,
        iterationTimeoutMinutes: l.iteration_timeout_minutes ?? d.limits.iterationTimeoutMinutes,
      },
      git: { push: c.git?.push ?? false },
    } satisfies ProjectConfig;
  });

/** `auto` → beads when the repo has a `.beads/` directory, else markdown. */
export const resolveBackend = (cfg: ProjectConfig): PlanBackendId =>
  cfg.plan.backend === "auto"
    ? fs.existsSync(path.join(cfg.dir, ".beads"))
      ? "beads"
      : "markdown"
    : cfg.plan.backend;

// ------------------------------------------------------------- detection

const exists = (dir: string, f: string) => fs.existsSync(path.join(dir, f));

/** Best guess at a project's validate commands (written into ralph.toml / AGENTS.md by `init`). */
export const detectValidate = (dir: string): ReadonlyArray<string> => {
  const cmds: Array<string> = [];
  if (exists(dir, "package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts =
        (
          JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
            scripts?: Record<string, string>;
          }
        ).scripts ?? {};
    } catch {
      // unreadable package.json: no script detection
    }
    const pm = exists(dir, "pnpm-lock.yaml")
      ? "pnpm"
      : exists(dir, "bun.lock") || exists(dir, "bun.lockb")
        ? "bun run"
        : exists(dir, "yarn.lock")
          ? "yarn"
          : "npm run";
    for (const s of ["check", "typecheck", "lint", "build", "test"]) {
      if (scripts[s] !== undefined) cmds.push(`${pm} ${s}`);
    }
  }
  if (exists(dir, "Cargo.toml")) cmds.push("cargo build", "cargo test");
  if (exists(dir, "go.mod")) cmds.push("go build ./...", "go test ./...");
  if (exists(dir, "pyproject.toml")) {
    const uv = exists(dir, "uv.lock") ? "uv run " : "";
    cmds.push(`${uv}pytest`);
  }
  if (cmds.length === 0 && exists(dir, "Makefile")) {
    const mk = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
    if (/^test:/m.test(mk)) cmds.push("make test");
  }
  return cmds;
};

/** Likely source directories, for the prompts' "the source is in …" line. */
export const detectSource = (dir: string): ReadonlyArray<string> => {
  const found = ["src", "lib", "app", "cmd", "internal", "pkg", "crates", "packages"].filter((d) =>
    exists(dir, d),
  );
  return found.length > 0 ? found : ["."];
};
