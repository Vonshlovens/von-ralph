/**
 * Process modes: how `plan`, `build`, and `reverse` differ from a plain `run`.
 * Each is a `ModePolicy` for the generic loop: it renders the prompt every
 * iteration (so prompt edits and signs apply immediately), and reviews every
 * completed iteration — runner-side validation, plan snapshots, scope checks,
 * stop conditions, and feedback for the next prompt.
 */
import { Effect } from "effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PlanBackendId,
  type RunMode,
  StateError,
  type StopReason,
  type ValidateResult,
} from "./domain.ts";
import * as Git from "./git.ts";
import type { ModePolicy, Review, ReviewInput } from "./loop.ts";
import {
  type BeadsFilter,
  type PlanSnapshot,
  beadsFilter,
  beadsSnapshot,
  filterFlags,
  markdownSnapshot,
  renderFromSidecar,
} from "./plan.ts";
import { shell } from "./proc.ts";
import {
  type ProjectConfig,
  type PromptName,
  detectSource,
  promptPath,
  resolveBackend,
} from "./project.ts";
import * as T from "./templates.ts";

/** Absolute path of the CLI shim, for prompts (`$R task …`). */
export const RALPH_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/ralph-next",
);

export const SENTINEL = /<promise>\s*COMPLETE\s*<\/promise>/i;

const builtin: Record<PromptName, string> = {
  plan: T.PLAN_PROMPT,
  build: T.BUILD_PROMPT,
  reverse: T.REVERSE_PROMPT,
  spec: T.SPEC_PROMPT,
};

/** The project's template if it has one, else the built-in default. */
export const loadTemplate = (dir: string, name: PromptName): string => {
  const file = promptPath(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : builtin[name];
};

export const defaultTemplate = (name: PromptName) => builtin[name];

const code = (s: string) => `\`${s}\``;

export const planInstructions = (
  backend: PlanBackendId,
  project: ProjectConfig,
  filter: BeadsFilter,
): string => {
  if (backend === "markdown") {
    const file = project.plan.file;
    return `This project uses Ralph's markdown plan. The source of truth is \`.ralph/plan.json\`;
\`${file}\` is generated from it for humans, so never edit \`${file}\` by hand. Read
\`${file}\` to see the plan, and change it with the task CLI (it validates the plan and
regenerates the markdown):

    R=${RALPH_BIN}
    $R task list [--ready] [--json]   items; "ready" = open with all dependencies done
    $R task show <id>
    $R task add "<title>" -p <0-4> [--after T1,T2] [--spec specs/x.md] [--accept "<criteria>"]
    $R task edit <id> [--title "…"] [-p N] [--after …] [--spec …] [--accept "…"]
    $R task start <id>                mark in progress
    $R task done <id> --note "<what was done>"
    $R task block <id> --note "<question for the human>"
    $R task reopen <id>  |  $R task rm <id>
    $R task note <id> "<text>"
    $R task learn "<text>"            a project learning, listed at the end of the plan

Priority 0 is the highest. Ids are T1, T2, …`;
  }
  const flags = filterFlags(filter).join(" ");
  const f = flags === "" ? "" : ` ${flags}`;
  const createFlags = [
    ...(filter.label === null ? [] : [`--labels ${filter.label}`]),
    ...(filter.parent === null ? [] : [`--parent ${filter.parent}`]),
  ].join(" ");
  const scopeNote =
    filter.bead !== null
      ? `\n\n**This run works on bead ${filter.bead} only** (\`bd show ${filter.bead} --json\`). Claim it, finish it, close it. File anything else you find as new beads instead of doing it.`
      : flags === ""
        ? ""
        : `\n\nThis loop only considers beads matching \`${flags}\`; give new beads the same ${createFlags === "" ? "filter" : `\`${createFlags}\``}.`;
  return `This project tracks work in Beads (\`bd\`): the Beads database is the plan. Do not keep
markdown TODO lists.

    bd ready --json${f}            ready work (no open blockers), highest priority first
    bd list --json${f}             everything open
    bd show <id> --json
    bd create "<title>" -t task -p <0-4> -d "<description>" --acceptance "<criteria>" [--deps <id>,…]${createFlags === "" ? "" : ` ${createFlags}`} --json
    bd update <id> --claim         claim an item before you work on it
    bd close <id> --reason "<what was done>"
    bd note <id> "<text>"          findings, questions
    bd dep add <id> <depends-on-id>
    bd update <id> -p <0-4>  |  bd update <id> --status blocked

Priority 0 is the highest.${scopeNote}`;
};

export interface ModeOptions {
  readonly mode: Exclude<RunMode, "run">;
  readonly project: ProjectConfig;
  readonly scope: string | null;
  readonly bead: string | null;
}

export const promptVars = (o: ModeOptions, backend: PlanBackendId): Record<string, string> => {
  const p = o.project;
  const source = (p.source.length > 0 ? p.source : detectSource(p.dir))
    .map((s) => code(s === "." ? "./" : `${s.replace(/\/$/, "")}/`))
    .join(", ");
  const validate =
    p.validate.commands.length > 0
      ? `run ${p.validate.commands.map(code).join(", then ")}`
      : "run the validation commands listed in @AGENTS.md";
  const commit = p.git.push
    ? 'Commit and push: `git add -A && git commit -m "<what and why>" && git push`.'
    : 'Commit: `git add -A && git commit -m "<what and why>"`. Do not push.';
  const scope =
    o.bead !== null ? ` (only bead ${o.bead})` : o.scope === null ? "" : ` (scope: ${o.scope})`;
  return {
    goal: p.goal ?? "Satisfy the specifications in `specs/`.",
    source,
    scope,
    plan_file: p.plan.file,
    plan_instructions: planInstructions(backend, p, beadsFilter(p, o.bead)),
    plan_commit:
      backend === "beads"
        ? "Beads stores the plan; there is nothing to commit."
        : `If you changed the plan, commit only the plan: \`git add .ralph/plan.json ${p.plan.file} && git commit -m "plan: <summary>"\`.`,
    validate,
    commit,
    ralph: RALPH_BIN,
    topic: o.scope === null ? "" : ` for: ${o.scope}`,
  };
};

// ------------------------------------------------------------------ review

const specsSnapshot = (dir: string): Effect.Effect<PlanSnapshot> =>
  Effect.sync(() => {
    const root = path.join(dir, "specs");
    const files: Array<string> = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else files.push(f);
      }
    };
    walk(root);
    files.sort();
    const h = createHash("sha1");
    for (const f of files) h.update(f).update(fs.readFileSync(f));
    const specs = files.filter((f) => f.endsWith(".md") && path.basename(f) !== "README.md");
    return {
      backend: "markdown" as const,
      total: specs.length,
      open: 0,
      actionable: 0,
      digest: h.digest("hex"),
      error: null,
    };
  });

const tail = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(s.length - n)}`);

/** Run the project's validate commands in order, stopping at the first failure. */
export const runValidate = (dir: string, commands: ReadonlyArray<string>, timeoutMinutes: number) =>
  Effect.gen(function* () {
    const results: Array<ValidateResult> = [];
    for (const command of commands) {
      const r = yield* shell(command, {
        cwd: dir,
        timeoutMs: timeoutMinutes * 60_000,
        combine: true,
        maxChars: 200_000,
      });
      results.push({
        command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        output: tail(r.stdout.trimEnd(), 4000),
      });
      if (r.exitCode !== 0) break;
    }
    return { ok: results.every((r) => r.exitCode === 0), results };
  });

const validateFeedback = (results: ReadonlyArray<ValidateResult>) => {
  const bad = results.find((r) => r.exitCode !== 0);
  if (bad === undefined) return [];
  const how = bad.exitCode === null ? "timed out" : `exited ${bad.exitCode}`;
  return [
    `Runner validation FAILED after the previous iteration: \`${bad.command}\` ${how}. Fix this before anything else (it may be the previous item's fault). Output tail:\n\n\`\`\`\n${tail(bad.output, 3000)}\n\`\`\``,
  ];
};

const allowedFor = (mode: ModeOptions["mode"], planFile: string) => (file: string) =>
  file.startsWith(".ralph/") ||
  (mode === "plan" && (file === planFile || file.startsWith(".beads/"))) ||
  (mode === "reverse" && file.startsWith("specs/"));

const statusEvent = (snap: PlanSnapshot, backend: PlanBackendId | "specs", changed: boolean) => ({
  type: "plan_status" as const,
  backend,
  total: snap.total,
  open: snap.open,
  actionable: snap.actionable,
  changed,
  ...(snap.error === null ? {} : { error: snap.error }),
});

/**
 * Build the policy for a process mode. Holds per-run counters (no-progress,
 * validate failures) and the last plan digest in its closure.
 */
export const modePolicy = (o: ModeOptions): ModePolicy => {
  const p = o.project;
  const dir = p.dir;
  const backend = resolveBackend(p);
  const filter = beadsFilter(p, o.bead);
  const snapshot =
    o.mode === "reverse"
      ? specsSnapshot(dir)
      : backend === "beads"
        ? beadsSnapshot(dir, filter)
        : renderFromSidecar(dir, p.plan.file).pipe(
            Effect.ignore,
            Effect.andThen(markdownSnapshot(dir)),
          );
  const label: PlanBackendId | "specs" = o.mode === "reverse" ? "specs" : backend;
  let lastDigest: string | null = null;
  let before: { head: string | null; dirty: ReadonlyMap<string, string> } = {
    head: null,
    dirty: new Map(),
  };
  let noProgress = 0;
  let validateFailures = 0;

  const preflight: ModePolicy["preflight"] = (emit) =>
    Effect.gen(function* () {
      const snap = yield* snapshot;
      lastDigest = snap.digest;
      yield* emit(statusEvent(snap, label, false));
      if (o.mode !== "build" || snap.error !== null) return null;
      if (snap.open === 0) {
        yield* emit({
          type: "notice",
          text:
            snap.total === 0
              ? "the plan is empty: run `ralph-next plan` first"
              : "every plan item is already done",
        });
        return "plan_complete" as StopReason;
      }
      if (snap.actionable === 0) {
        yield* emit({
          type: "notice",
          text: `${snap.open} open items, none ready (blocked or waiting)`,
        });
        return "plan_exhausted" as StopReason;
      }
      return null;
    });

  const begin: ModePolicy["begin"] = () =>
    Effect.gen(function* () {
      before = { head: yield* Git.head(dir), dirty: yield* Git.dirty(dir) };
    });

  const prompt: ModePolicy["prompt"] = () =>
    Effect.sync(() => T.render(loadTemplate(dir, o.mode), promptVars(o, backend)));

  const review = (input: ReviewInput) =>
    Effect.gen(function* () {
      const feedback: Array<string> = [];
      let validateOk: boolean | null = null;

      if (o.mode === "build" && p.validate.commands.length > 0) {
        const v = yield* runValidate(dir, p.validate.commands, p.validate.timeoutMinutes);
        validateOk = v.ok;
        yield* input.emit({ type: "validate", ok: v.ok, results: v.results });
        validateFailures = v.ok ? 0 : validateFailures + 1;
        feedback.push(...validateFeedback(v.results));
      }

      const snap = yield* snapshot;
      const changed = snap.digest !== lastDigest;
      lastDigest = snap.digest;
      yield* input.emit(statusEvent(snap, label, changed));
      if (snap.error !== null) {
        feedback.push(
          `The plan could not be read after the previous iteration: ${snap.error}. Fix it first.`,
        );
      }

      const done = (stop: StopReason | null): Review => ({
        stop,
        feedback,
        validateOk,
        planOpen: o.mode === "reverse" ? null : snap.open,
      });

      if (o.mode === "plan" || o.mode === "reverse") {
        const files = yield* Git.touched(dir, before, input.headAfter);
        const outside = files.filter((f) => !allowedFor(o.mode, p.plan.file)(f));
        if (outside.length > 0) {
          const diffPath = path.join(input.runDir, `scope-violation-${input.iteration}.diff`);
          const diff = yield* Git.diffOf(dir, before.head, outside);
          yield* Effect.sync(() => fs.writeFileSync(diffPath, diff));
          yield* input.emit({ type: "scope_violation", files: outside, diffPath });
          return done("scope_violation");
        }
        return done(changed || snap.error !== null ? null : "plan_converged");
      }

      // build
      const committed =
        before.head !== null && input.headAfter !== null && before.head !== input.headAfter;
      noProgress = committed || changed ? 0 : noProgress + 1;
      if (noProgress > 0) {
        feedback.push(
          "The previous iteration made no commit and did not change the plan. Finish and commit one item, or update the plan to say why it cannot be done.",
        );
      }
      if (
        input.lastAssistant !== null &&
        SENTINEL.test(input.lastAssistant) &&
        snap.open > 0 &&
        snap.error === null
      ) {
        feedback.push(
          `The previous iteration declared COMPLETE, but the plan still has ${snap.open} open items. Close finished items, or work on the next one.`,
        );
      }
      if (validateFailures >= p.limits.maxValidateFailures) return done("validate_failed");
      if (noProgress >= p.limits.noProgressIterations) return done("no_progress");
      if (validateOk !== false && snap.error === null) {
        if (snap.open === 0) return done("plan_complete");
        if (snap.actionable === 0) return done("plan_exhausted");
      }
      return done(null);
    });

  return { id: o.mode, preflight, begin, prompt, review };
};

/** The plain `run` mode: a fixed prompt; stops early only on the COMPLETE sentinel. */
export const runPolicy = (prompt: string): ModePolicy => ({
  id: "run",
  preflight: () => Effect.succeed(null),
  begin: () => Effect.void,
  prompt: () => Effect.succeed(prompt),
  review: (i) =>
    Effect.succeed({
      stop: i.lastAssistant !== null && SENTINEL.test(i.lastAssistant) ? "complete" : null,
      feedback: [],
      validateOk: null,
      planOpen: null,
    }),
});

export const ensureInitialized = (p: ProjectConfig, mode: string) =>
  p.initialized
    ? Effect.void
    : Effect.fail(
        new StateError({
          path: p.dir,
          reason: `not a ralph project (no .ralph/ralph.toml). Run \`ralph-next init -d ${p.dir}\` before \`${mode}\`.`,
        }),
      );
