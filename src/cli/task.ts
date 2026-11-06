/**
 * `ralph task …`: the markdown plan backend's CLI, for agents and humans.
 * Every write validates `.ralph/plan.json` and regenerates the markdown, so the
 * two cannot drift. Beads projects use `bd` instead.
 */
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as path from "node:path";
import { StateError } from "../domain.ts";
import {
  ItemStatus,
  type Plan,
  type PlanItem,
  nextId,
  readPlan,
  readyItems,
  renderPlan,
  sortItems,
  writePlan,
} from "../plan.ts";
import { type ProjectConfig, loadProject, ralphDir, resolveBackend } from "../project.ts";
import * as fs from "node:fs";

const dirFlag = Flag.String("dir").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Project directory (default: cwd)"),
  Flag.optional,
);
const idArg = Argument.String("id").pipe(Argument.withDescription("Item id, e.g. T3"));
const noteFlag = Flag.String("note").pipe(Flag.withDescription("Note to add"), Flag.optional);

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");

/** Find the project (walking up from the dir, like git) and refuse beads projects. */
const project = (d: Option.Option<string>) =>
  Effect.gen(function* () {
    let dir = path.resolve(Option.getOrElse(d, () => process.cwd()));
    while (!fs.existsSync(ralphDir(dir)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const p = yield* loadProject(dir);
    if (!fs.existsSync(ralphDir(dir))) {
      return yield* new StateError({
        path: path.resolve(Option.getOrElse(d, () => process.cwd())),
        reason: "no .ralph/ here or above: run `ralph init`",
      });
    }
    if (resolveBackend(p) === "beads") {
      return yield* new StateError({
        path: dir,
        reason: "this project's plan lives in Beads: use `bd` (bd ready, bd create, bd close …)",
      });
    }
    return p;
  });

const mutate = (
  p: ProjectConfig,
  f: (plan: Plan) => Effect.Effect<{ plan: Plan; message: string }, StateError>,
) =>
  Effect.gen(function* () {
    const plan = yield* readPlan(p.dir);
    const next = yield* f(plan);
    yield* writePlan(p.dir, p.plan.file, next.plan);
    yield* Console.log(next.message);
  });

const findItem = (plan: Plan, id: string): Effect.Effect<PlanItem, StateError> => {
  const it = plan.items.find((i) => i.id === id);
  return it === undefined
    ? Effect.fail(new StateError({ path: id, reason: `no plan item '${id}'` }))
    : Effect.succeed(it);
};

const replace = (plan: Plan, item: PlanItem): Plan => ({
  ...plan,
  items: plan.items.map((i) => (i.id === item.id ? item : i)),
});

const fmt = (i: PlanItem) =>
  `${i.id.padEnd(5)} P${i.priority} ${i.status.padEnd(11)} ${i.title}${i.depends_on.length > 0 ? `  (after ${i.depends_on.join(", ")})` : ""}`;

const listCmd = Command.make(
  "list",
  {
    dir: dirFlag,
    ready: Flag.Boolean("ready").pipe(
      Flag.withDescription("Only items that can be worked on now"),
      Flag.withDefault(false),
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Include done items"),
      Flag.withDefault(false),
    ),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  },
  (a) =>
    Effect.gen(function* () {
      const p = yield* project(a.dir);
      const plan = yield* readPlan(p.dir);
      const items = a.ready
        ? readyItems(plan)
        : sortItems(plan.items.filter((i) => a.all || i.status !== "done"));
      if (a.json) return yield* Console.log(JSON.stringify(items, null, 2));
      if (items.length === 0) return yield* Console.log(a.ready ? "Nothing ready." : "No items.");
      yield* Console.log(items.map(fmt).join("\n"));
    }),
).pipe(Command.withDescription("List plan items (open by default)"));

const showCmd = Command.make("show", { id: idArg, dir: dirFlag }, (a) =>
  Effect.gen(function* () {
    const p = yield* project(a.dir);
    const it = yield* findItem(yield* readPlan(p.dir), a.id);
    yield* Console.log(JSON.stringify(it, null, 2));
  }),
).pipe(Command.withDescription("Show one item as JSON"));

const itemFlags = {
  priority: Flag.Int("priority").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("0 (highest) … 4"),
    Flag.optional,
  ),
  after: Flag.String("after").pipe(
    Flag.withDescription("Comma-separated ids this item depends on"),
    Flag.optional,
  ),
  spec: Flag.String("spec").pipe(
    Flag.withDescription("Comma-separated spec files it serves"),
    Flag.optional,
  ),
  accept: Flag.String("accept").pipe(
    Flag.withDescription("Acceptance criteria (observable behavior)"),
    Flag.optional,
  ),
};

const addCmd = Command.make(
  "add",
  {
    title: Argument.String("title"),
    dir: dirFlag,
    ...itemFlags,
    note: noteFlag,
  },
  (a) =>
    Effect.gen(function* () {
      const p = yield* project(a.dir);
      yield* mutate(p, (plan) => {
        const id = nextId(plan);
        const item: PlanItem = {
          id,
          title: a.title,
          status: "open",
          priority: Option.getOrElse(a.priority, () => 2),
          depends_on: Option.match(a.after, { onNone: () => [], onSome: list }),
          spec_refs: Option.match(a.spec, { onNone: () => [], onSome: list }),
          acceptance: Option.getOrElse(a.accept, () => ""),
          notes: Option.match(a.note, { onNone: () => [], onSome: (n) => [n] }),
        };
        return Effect.succeed({ plan: { ...plan, items: [...plan.items, item] }, message: id });
      });
    }),
).pipe(Command.withDescription("Add an item; prints its id"));

const editCmd = Command.make(
  "edit",
  {
    id: idArg,
    dir: dirFlag,
    title: Flag.String("title").pipe(Flag.optional),
    ...itemFlags,
  },
  (a) =>
    Effect.gen(function* () {
      const p = yield* project(a.dir);
      yield* mutate(p, (plan) =>
        findItem(plan, a.id).pipe(
          Effect.map((it) => ({
            plan: replace(plan, {
              ...it,
              title: Option.getOrElse(a.title, () => it.title),
              priority: Option.getOrElse(a.priority, () => it.priority),
              depends_on: Option.match(a.after, { onNone: () => it.depends_on, onSome: list }),
              spec_refs: Option.match(a.spec, { onNone: () => it.spec_refs, onSome: list }),
              acceptance: Option.getOrElse(a.accept, () => it.acceptance),
            }),
            message: `edited ${it.id}`,
          })),
        ),
      );
    }),
).pipe(Command.withDescription("Change an item's fields"));

const statusCmd = (
  name: string,
  status: typeof ItemStatus.Type,
  description: string,
  requireNote = false,
) =>
  Command.make(name, { id: idArg, dir: dirFlag, note: noteFlag }, (a) =>
    Effect.gen(function* () {
      if (requireNote && Option.isNone(a.note)) {
        return yield* new StateError({ path: a.id, reason: `--note is required for ${name}` });
      }
      const p = yield* project(a.dir);
      yield* mutate(p, (plan) =>
        findItem(plan, a.id).pipe(
          Effect.map((it) => ({
            plan: replace(plan, {
              ...it,
              status,
              notes: Option.match(a.note, {
                onNone: () => it.notes,
                onSome: (n) => [...it.notes, n],
              }),
            }),
            message: `${it.id} → ${status}`,
          })),
        ),
      );
    }),
  ).pipe(Command.withDescription(description));

const rmCmd = Command.make("rm", { id: idArg, dir: dirFlag }, (a) =>
  Effect.gen(function* () {
    const p = yield* project(a.dir);
    yield* mutate(p, (plan) =>
      findItem(plan, a.id).pipe(
        Effect.map((it) => ({
          plan: {
            ...plan,
            items: plan.items
              .filter((i) => i.id !== it.id)
              .map((i) => ({ ...i, depends_on: i.depends_on.filter((d) => d !== it.id) })),
          },
          message: `removed ${it.id}`,
        })),
      ),
    );
  }),
).pipe(Command.withDescription("Delete an item (and dependencies on it)"));

const noteCmd = Command.make(
  "note",
  { id: idArg, text: Argument.String("text"), dir: dirFlag },
  (a) =>
    Effect.gen(function* () {
      const p = yield* project(a.dir);
      yield* mutate(p, (plan) =>
        findItem(plan, a.id).pipe(
          Effect.map((it) => ({
            plan: replace(plan, { ...it, notes: [...it.notes, a.text] }),
            message: `noted ${it.id}`,
          })),
        ),
      );
    }),
).pipe(Command.withDescription("Add a note to an item"));

const learnCmd = Command.make("learn", { text: Argument.String("text"), dir: dirFlag }, (a) =>
  Effect.gen(function* () {
    const p = yield* project(a.dir);
    yield* mutate(p, (plan) =>
      Effect.succeed({
        plan: { ...plan, learnings: [...plan.learnings, a.text] },
        message: "learning recorded",
      }),
    );
  }),
).pipe(Command.withDescription("Record a project learning (listed at the end of the plan)"));

const renderCmd = Command.make(
  "render",
  {
    dir: dirFlag,
    stdout: Flag.Boolean("stdout").pipe(
      Flag.withDescription("Print instead of writing the file"),
      Flag.withDefault(false),
    ),
  },
  (a) =>
    Effect.gen(function* () {
      const p = yield* project(a.dir);
      const plan = yield* readPlan(p.dir);
      if (a.stdout) return yield* Console.log(renderPlan(plan));
      const changed = yield* writePlan(p.dir, p.plan.file, plan);
      yield* Console.log(changed ? `rendered ${p.plan.file}` : `${p.plan.file} is up to date`);
    }),
).pipe(Command.withDescription("Validate plan.json and regenerate the markdown plan"));

export const task = Command.make("task").pipe(
  Command.withDescription("Edit the markdown plan (.ralph/plan.json → IMPLEMENTATION_PLAN.md)"),
  Command.withSubcommands([
    listCmd,
    showCmd,
    addCmd,
    editCmd,
    statusCmd("start", "in_progress", "Mark an item in progress"),
    statusCmd("done", "done", "Mark an item done (add --note with what was done)"),
    statusCmd(
      "block",
      "blocked",
      "Mark an item blocked on a human (--note with the question)",
      true,
    ),
    statusCmd("reopen", "open", "Reopen an item"),
    rmCmd,
    noteCmd,
    learnCmd,
    renderCmd,
  ]),
);
