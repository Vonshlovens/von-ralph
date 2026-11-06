/**
 * Plan backends. Both are first-class:
 *
 * - **markdown**: `.ralph/plan.json` is the machine-readable source of truth;
 *   `IMPLEMENTATION_PLAN.md` is generated from it for humans. Agents edit it
 *   through `ralph task …` (validates and re-renders), or the JSON directly
 *   (the runner validates and re-renders after every iteration).
 * - **beads**: the Beads database is the plan (`bd ready` is the queue).
 *
 * Either way the runner takes a `PlanSnapshot` before and after iterations to
 * decide whether the plan is complete, stuck, or unchanged.
 */
import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type PlanBackendId, StateError } from "./domain.ts";
import { capture } from "./proc.ts";
import { type ProjectConfig, planJsonPath } from "./project.ts";

// ---------------------------------------------------------------- markdown

export const ItemStatus = Schema.Literals(["open", "in_progress", "done", "blocked"]);
export type ItemStatus = typeof ItemStatus.Type;

const PlanItemFile = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.optionalKey(ItemStatus),
  priority: Schema.optionalKey(Schema.Number),
  depends_on: Schema.optionalKey(Schema.Array(Schema.String)),
  spec_refs: Schema.optionalKey(Schema.Array(Schema.String)),
  acceptance: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});

const PlanFile = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  goal: Schema.optionalKey(Schema.String),
  items: Schema.Array(PlanItemFile),
  learnings: Schema.optionalKey(Schema.Array(Schema.String)),
});

export interface PlanItem {
  readonly id: string;
  readonly title: string;
  readonly status: ItemStatus;
  /** 0 (highest) … 4 */
  readonly priority: number;
  readonly depends_on: ReadonlyArray<string>;
  readonly spec_refs: ReadonlyArray<string>;
  readonly acceptance: string;
  readonly notes: ReadonlyArray<string>;
}

export interface Plan {
  readonly version: 1;
  readonly goal?: string | undefined;
  readonly items: ReadonlyArray<PlanItem>;
  readonly learnings: ReadonlyArray<string>;
}

export const emptyPlan = (goal?: string | null): Plan => ({
  version: 1,
  ...(goal === null || goal === undefined ? {} : { goal }),
  items: [],
  learnings: [],
});

const decodePlan = Schema.decodeUnknownEffect(PlanFile);

/** Structural problems the schema can't express. */
export const planProblems = (plan: Plan): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const ids = new Set<string>();
  for (const it of plan.items) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(it.id))
      problems.push(`item id '${it.id}' is not a short id`);
    if (ids.has(it.id)) problems.push(`duplicate item id '${it.id}'`);
    ids.add(it.id);
    if (it.title.trim() === "") problems.push(`${it.id}: empty title`);
    if (!Number.isInteger(it.priority) || it.priority < 0 || it.priority > 4)
      problems.push(`${it.id}: priority must be an integer 0-4`);
  }
  for (const it of plan.items) {
    for (const d of it.depends_on) {
      if (d === it.id) problems.push(`${it.id}: depends on itself`);
      else if (!ids.has(d)) problems.push(`${it.id}: depends on unknown item '${d}'`);
    }
  }
  return problems;
};

/** Read and validate `.ralph/plan.json`. A missing file is an empty plan. */
export const readPlan = (dir: string): Effect.Effect<Plan, StateError> =>
  Effect.gen(function* () {
    const file = planJsonPath(dir);
    if (!fs.existsSync(file)) return emptyPlan();
    const raw = yield* Effect.try({
      try: () => JSON.parse(fs.readFileSync(file, "utf8")) as unknown,
      catch: (e) => new StateError({ path: file, reason: `invalid JSON: ${String(e)}` }),
    });
    const p = yield* decodePlan(raw).pipe(
      Effect.mapError((e) => new StateError({ path: file, reason: e.message })),
    );
    const plan: Plan = {
      version: 1,
      ...(p.goal === undefined ? {} : { goal: p.goal }),
      items: p.items.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status ?? "open",
        priority: i.priority ?? 2,
        depends_on: i.depends_on ?? [],
        spec_refs: i.spec_refs ?? [],
        acceptance: i.acceptance ?? "",
        notes: i.notes ?? [],
      })),
      learnings: p.learnings ?? [],
    };
    const problems = planProblems(plan);
    if (problems.length > 0) {
      return yield* new StateError({ path: file, reason: problems.join("; ") });
    }
    return plan;
  });

const isOpen = (it: PlanItem) => it.status !== "done";

/** Open items whose dependencies are all done, highest priority first. */
export const readyItems = (plan: Plan): ReadonlyArray<PlanItem> => {
  const done = new Set(plan.items.filter((i) => i.status === "done").map((i) => i.id));
  return sortItems(
    plan.items.filter(
      (i) =>
        (i.status === "open" || i.status === "in_progress") &&
        i.depends_on.every((d) => done.has(d)),
    ),
  );
};

const idNum = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);

export const sortItems = (items: ReadonlyArray<PlanItem>): ReadonlyArray<PlanItem> =>
  [...items].sort((a, b) => a.priority - b.priority || idNum(a.id) - idNum(b.id));

export const nextId = (plan: Plan): string =>
  `T${plan.items.reduce((m, i) => Math.max(m, /^T(\d+)$/.test(i.id) ? Number(i.id.slice(1)) : 0), 0) + 1}`;

const itemLine = (it: PlanItem, done: ReadonlySet<string>): string => {
  const box = it.status === "done" ? "[x]" : "[ ]";
  const tags = [
    `P${it.priority}`,
    ...(it.status === "in_progress" ? ["in progress"] : []),
    ...(it.status === "blocked" ? ["blocked"] : []),
  ].join(", ");
  const waiting = it.depends_on.filter((d) => !done.has(d));
  const after = it.depends_on.length === 0 ? "" : ` · after ${it.depends_on.join(", ")}`;
  const lines = [
    `- ${box} **${it.id}** (${tags}) ${it.title}${after}${it.status !== "done" && waiting.length > 0 ? " ⏳" : ""}`,
  ];
  if (it.spec_refs.length > 0) lines.push(`  - Specs: ${it.spec_refs.join(", ")}`);
  if (it.acceptance.trim() !== "" && it.status !== "done")
    lines.push(`  - Acceptance: ${it.acceptance.trim().replace(/\n+/g, " ")}`);
  for (const n of it.notes) lines.push(`  - Note: ${n.replace(/\n+/g, " ")}`);
  return lines.join("\n");
};

/** IMPLEMENTATION_PLAN.md, generated from the sidecar. */
export const renderPlan = (plan: Plan): string => {
  const done = new Set(plan.items.filter((i) => i.status === "done").map((i) => i.id));
  const ready = new Set(readyItems(plan).map((i) => i.id));
  const open = sortItems(plan.items.filter(isOpen));
  const section = (title: string, items: ReadonlyArray<PlanItem>) =>
    items.length === 0 ? [] : [`## ${title}`, "", ...items.map((i) => itemLine(i, done)), ""];
  return [
    "# Implementation plan",
    "",
    "<!-- Generated by ralph from .ralph/plan.json. Do not edit by hand: use `ralph task …`",
    "     (or edit the JSON); this file is rewritten. -->",
    "",
    ...(plan.goal === undefined ? [] : [`**Goal:** ${plan.goal}`, ""]),
    `${open.length} open (${ready.size} ready) · ${done.size} done`,
    "",
    ...section(
      "Ready",
      open.filter((i) => ready.has(i.id)),
    ),
    ...section(
      "Waiting",
      open.filter((i) => !ready.has(i.id) && i.status !== "blocked"),
    ),
    ...section(
      "Blocked (needs a human)",
      open.filter((i) => i.status === "blocked"),
    ),
    ...section("Done", sortItems(plan.items.filter((i) => i.status === "done"))),
    ...(plan.learnings.length === 0
      ? []
      : ["## Learnings", "", ...plan.learnings.map((l) => `- ${l.replace(/\n+/g, " ")}`), ""]),
    ...(plan.items.length === 0 ? ["_No items yet. Run `ralph plan`._", ""] : []),
  ].join("\n");
};

const planJson = (plan: Plan) =>
  `${JSON.stringify(
    {
      version: 1,
      ...(plan.goal === undefined ? {} : { goal: plan.goal }),
      items: plan.items,
      learnings: plan.learnings,
    },
    null,
    2,
  )}\n`;

const writeIfChanged = (file: string, text: string): boolean => {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (cur === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
};

/** Write plan.json and re-render the markdown. Returns whether the markdown changed. */
export const writePlan = (dir: string, planFile: string, plan: Plan) =>
  Effect.try({
    try: () => {
      const problems = planProblems(plan);
      if (problems.length > 0) throw new Error(problems.join("; "));
      writeIfChanged(planJsonPath(dir), planJson(plan));
      return writeIfChanged(path.join(dir, planFile), renderPlan(plan));
    },
    catch: (e) =>
      new StateError({
        path: planJsonPath(dir),
        reason: e instanceof Error ? e.message : String(e),
      }),
  });

/** Re-render the markdown from the current sidecar (after an agent edited the JSON). */
export const renderFromSidecar = (dir: string, planFile: string) =>
  readPlan(dir).pipe(
    Effect.flatMap((plan) =>
      Effect.sync(() =>
        fs.existsSync(planJsonPath(dir))
          ? writeIfChanged(path.join(dir, planFile), renderPlan(plan))
          : false,
      ),
    ),
  );

// ------------------------------------------------------------------ snapshots

export interface PlanSnapshot {
  readonly backend: PlanBackendId;
  readonly total: number;
  readonly open: number;
  readonly actionable: number;
  /** Changes whenever any item's id/status/priority/title/deps change. */
  readonly digest: string;
  /** Set when the plan could not be read; counts are then 0. */
  readonly error: string | null;
}

const digestOf = (parts: ReadonlyArray<string>) =>
  createHash("sha1").update(parts.join("\n")).digest("hex");

export const markdownSnapshot = (dir: string): Effect.Effect<PlanSnapshot> =>
  readPlan(dir).pipe(
    Effect.map((plan): PlanSnapshot => ({
      backend: "markdown",
      total: plan.items.length,
      open: plan.items.filter(isOpen).length,
      actionable: readyItems(plan).length,
      digest: digestOf(
        plan.items.map(
          (i) =>
            `${i.id}|${i.status}|${i.priority}|${i.title}|${i.depends_on.join(",")}|${i.acceptance}`,
        ),
      ),
      error: null,
    })),
    Effect.catch((e: StateError) =>
      Effect.succeed({
        backend: "markdown" as const,
        total: 0,
        open: 0,
        actionable: 0,
        digest: "error",
        error: e.reason,
      }),
    ),
  );

// --------------------------------------------------------------------- beads

export interface BeadsFilter {
  readonly label: string | null;
  readonly parent: string | null;
  /** Focus on a single bead (a one-item build, e.g. a Beadsmith Tackle). */
  readonly bead: string | null;
}

export const beadsFilter = (cfg: ProjectConfig, bead: string | null): BeadsFilter => ({
  label: cfg.plan.label,
  parent: cfg.plan.parent,
  bead,
});

export const filterFlags = (f: BeadsFilter): ReadonlyArray<string> => [
  ...(f.label === null ? [] : ["--label", f.label]),
  ...(f.parent === null ? [] : ["--parent", f.parent]),
];

interface BeadRow {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly priority?: number;
  readonly issue_type?: string;
  readonly updated_at?: string;
  readonly dependency_count?: number;
}

/** Statuses that still need work (closed / deferred / pinned do not). */
const BEAD_OPEN = new Set(["open", "in_progress", "blocked", "hooked"]);

const bdJson = (dir: string, args: ReadonlyArray<string>) =>
  capture("bd", [...args, "--json"], { cwd: dir, timeoutMs: 60_000 }).pipe(
    Effect.flatMap((r) => {
      if (r.exitCode !== 0) {
        const msg = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" | ");
        return Effect.fail(`bd ${args.join(" ")}: ${r.exitCode === null ? "timed out" : msg}`);
      }
      try {
        const v = JSON.parse(r.stdout.trim() === "" ? "[]" : r.stdout) as unknown;
        return Effect.succeed((Array.isArray(v) ? v : [v]) as ReadonlyArray<BeadRow>);
      } catch (e) {
        return Effect.fail(`bd ${args.join(" ")}: unparseable JSON (${String(e)})`);
      }
    }),
  );

export const beadsSnapshot = (
  dir: string,
  f: BeadsFilter,
): Effect.Effect<PlanSnapshot, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const rows =
      f.bead !== null
        ? yield* bdJson(dir, ["show", f.bead])
        : (yield* bdJson(dir, ["list", "--all", "--flat", "-n", "0", ...filterFlags(f)])).filter(
            (r) => r.issue_type !== "epic",
          );
    const open = rows.filter((r) => BEAD_OPEN.has(r.status ?? "open"));
    let actionable: number;
    if (f.bead !== null) {
      actionable = open.filter((r) => r.status !== "blocked").length;
    } else {
      const ready = (yield* bdJson(dir, ["ready", "-n", "0", ...filterFlags(f)])).filter(
        (r) => r.issue_type !== "epic",
      );
      const inProgress = open.filter((r) => r.status === "in_progress").length;
      actionable = ready.length + inProgress;
    }
    return {
      backend: "beads" as const,
      total: rows.length,
      open: open.length,
      actionable,
      digest: digestOf(
        rows
          .map(
            (r) =>
              `${r.id}|${r.status}|${r.priority}|${r.title}|${r.dependency_count ?? 0}|${r.updated_at}`,
          )
          .sort(),
      ),
      error: null,
    };
  }).pipe(
    Effect.catch((error: string) =>
      Effect.succeed({
        backend: "beads" as const,
        total: 0,
        open: 0,
        actionable: 0,
        digest: "error",
        error,
      }),
    ),
  );
