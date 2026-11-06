/**
 * Default templates written by `ralph init`, and the built-in fallbacks used
 * when a project has no `.ralph/prompts/<mode>.md`.
 *
 * Adapted from the Huntley / Farr Ralph playbook (PROMPT_plan.md,
 * PROMPT_build.md), made harness-neutral (claude, codex, opencode, copilot)
 * and backend-neutral: `{{plan_instructions}}` is filled with the markdown or
 * Beads instructions at run time. Prompts are re-read every iteration, so
 * edits (and `ralph-next sign`) take effect on the next iteration.
 *
 * Variables: {{goal}} {{source}} {{scope}} {{plan_file}} {{plan_instructions}}
 * {{plan_commit}} {{validate}} {{commit}} {{ralph}} {{topic}}
 */

export const PLAN_PROMPT = `# Ralph: planning iteration

You are one iteration of a planning loop. Every iteration starts with fresh
context: the files on disk are the only memory. **Plan only — do not implement
anything.** Do not change source code, tests, configuration, or specs.

## Orient

0a. Study \`specs/README.md\` (the index) and the specs under \`specs/\` to learn
    what the application must do. Use parallel subagents for reading if your
    harness has them.
0b. Study the current plan (see "Plan" below). It may be stale or wrong.
0c. Study @AGENTS.md to learn how the project is built and validated.
0d. The application source is in {{source}}. Treat shared utilities there as the
    project's standard library.

## Task

1. Gap analysis: compare the source against the specs{{scope}}. Search the code
   before concluding something is missing. Look for TODOs, placeholders,
   minimal implementations, skipped or flaky tests, and behavior that
   contradicts the specs.
2. Create or update the plan so it lists the work still needed, in priority
   order. Each item must be one iteration's worth of work for a fresh agent
   (small enough to implement, test and commit in one go) and have:
   - a concrete title,
   - acceptance criteria phrased as observable behavior,
   - the spec files it serves,
   - dependencies on other items, when order matters.
3. Close or remove items that are already done or no longer match the specs.
   Never duplicate an existing item; update it instead.
4. If a spec is missing, ambiguous, or contradicts another, add a plan item that
   says so. The human owns the specs; do not invent requirements.
5. {{plan_commit}}

## Plan

{{plan_instructions}}

## Goal

{{goal}}

IMPORTANT: Plan only. The runner checks that nothing outside the plan changed
and stops the loop for human review if it did. When the plan is complete and
correct, change nothing: an iteration that leaves the plan unchanged ends the
planning loop.
`;

export const BUILD_PROMPT = `# Ralph: build iteration

You are one iteration of a build loop. Every iteration starts with fresh
context: the plan, the specs, the code, and git history are the only memory.
**Do exactly one plan item this iteration**, then stop.

## Orient

0a. Study \`specs/README.md\` and the specs relevant to your item.
0b. Study @AGENTS.md: how to build, run, and validate.
0c. The application source is in {{source}}.

## Task

1. Pick the single most important ready item from the plan{{scope}}. Before
   changing anything, search the codebase: do not assume it is not implemented.
   Use parallel subagents for searching and reading if your harness has them,
   but only one at a time for building and testing.
2. Implement it completely. No placeholders or stubs.
3. Validate: {{validate}}. Fix failures, including ones your change did not
   cause. The runner re-runs validation after you finish and feeds failures to
   the next iteration.
4. Update the plan: mark the item done with a one-line note. File new items for
   bugs or gaps you discovered instead of fixing unrelated things now.
5. {{commit}}
6. Stop. End with a one-line summary of what you did. If no open items remain in
   the plan, end with <promise>COMPLETE</promise>.

## Plan

{{plan_instructions}}

## Signs

Guardrails added while tuning this loop (\`ralph-next sign\`). The more 9s, the
more important.

99999. When you write documentation or comments, capture the why.
999999. Keep single sources of truth: no duplicate implementations, adapters, or
    compatibility shims.
9999999. Keep @AGENTS.md operational: build/run/validate commands and short
    learnings about running the project. Status and progress belong in the plan.
99999999. If the item turns out to be wrong or too large, fix or split it in the
    plan instead of forcing it through.
999999999. If only a human can decide something, mark the item blocked with the
    question and stop. Do not guess at requirements.
`;

export const REVERSE_PROMPT = `# Ralph: reverse-engineering iteration

You are one iteration of a loop that writes specifications for an EXISTING
codebase. Every iteration starts with fresh context. **Do not change code**;
write only under \`specs/\`.

0a. Study \`specs/README.md\` (the index) and the existing specs.
0b. The application source is in {{source}}{{scope}}.

1. Pick the most important topic of concern (one coherent area of behavior that
   users or callers rely on) that has no spec yet, or whose spec is incomplete
   or wrong.
2. Write or update \`specs/NN-topic.md\` (NN = next free number):
   - purpose: the job it does, for whom;
   - behavior as observable acceptance criteria (inputs, outputs, states, errors);
   - edge cases and error handling;
   - a source citation (\`path:line\`) for every claim.
   Describe what the code does, not what it should do. Mark suspected bugs as
   "Observed (possible bug)".
3. Update \`specs/README.md\`: one line per spec with a summary and keywords, so
   agents can find the right spec.
4. Commit only specs: \`git add specs && git commit -m "specs: <topic>"\`.

When every significant behavior is specified, change nothing: an iteration
with no spec changes ends the loop.
`;

export const SPEC_PROMPT = `You are helping a human write specifications for this project, Ralph style
(specs → plan → build). This is an interactive session: the human owns the
specs, and they are the most expensive place to get things wrong.

1. Read \`specs/README.md\`, the existing specs, and @AGENTS.md, and skim the code
   to ground yourself.
2. Interview the human about the jobs to be done{{topic}}: who needs what, and
   why. Ask one focused question at a time (use AskUserQuestion when you have it).
3. Split the jobs into topics of concern, one spec per topic. A topic should be
   describable in one sentence without "and".
4. For each topic, agree on acceptance criteria phrased as observable behavior
   (inputs → outputs, states, errors). No implementation detail unless the human
   requires it.
5. Write \`specs/NN-topic.md\` (NN = next free number) and add a line to
   \`specs/README.md\` (file, one-line summary, keywords).
6. Read each spec back and have the human confirm or correct it before moving on.

Do not write code or a plan. When the specs are done, suggest running
\`ralph-next plan\`.
`;

export const SPECS_README = `# Specs

One file per topic of concern. Agents read this index first to find the right
spec, so keep each line short and keyword-rich.

| Spec | Summary | Keywords |
|---|---|---|
`;

export const agentsMd = (validate: ReadonlyArray<string>) => `# AGENTS.md

Operational notes for agents. Keep this short (under ~60 lines) and
operational: how to build, run, and validate. No status or progress notes —
those belong in the plan.

## Build & run

- <how to install dependencies, build, and run the project>

## Validation (backpressure)

Run before every commit; all must pass:

${validate.length === 0 ? "- <test / typecheck / lint commands>" : validate.map((c) => `- \`${c}\``).join("\n")}

## Codebase patterns

- <shared utilities and conventions to reuse>
`;

const tomlString = (s: string) => JSON.stringify(s);

export const ralphToml = (o: {
  readonly harness: string;
  readonly backend: string;
  readonly goal: string | null;
  readonly source: ReadonlyArray<string>;
  readonly validate: ReadonlyArray<string>;
}) => `# Ralph project config (ralph-next). CLI flags override these.

harness = ${tomlString(o.harness)}   # claude | codex | opencode | gh
# model = "opus"        # omit to use the harness default
# effort = "xhigh"

[project]
goal = ${tomlString(o.goal ?? "")}
source = [${o.source.map(tomlString).join(", ")}]

[plan]
backend = ${tomlString(o.backend)}   # auto (beads if .beads/ exists) | beads | markdown
file = "IMPLEMENTATION_PLAN.md"      # markdown backend: generated from .ralph/plan.json
# label = "ralph"                    # beads backend: only issues with this label
# parent = "proj-123"                # beads backend: only children of this epic

[validate]                           # runner-side backpressure, run after every build iteration
commands = [${o.validate.map(tomlString).join(", ")}]
timeout_minutes = 20

[limits]
plan_iterations = 2
build_iterations = 20
reverse_iterations = 3
no_progress_iterations = 3           # stop after N build iterations without a commit or plan change
max_validate_failures = 3            # stop after N consecutive failed validations
iteration_timeout_minutes = 120

[git]
push = false                         # build prompt asks the agent to push after committing
`;

/** Replace `{{name}}`; unknown variables are left as-is. */
export const render = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{([a-z_]+)\}\}/g, (m, k: string) => vars[k] ?? m);
