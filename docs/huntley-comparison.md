# von-ralph vs Huntley's Ralph: is the plan too rigid?

Date: 2026-11-14
Status: Review / guidance. Compares the process in
[ralph-v2-design.md](ralph-v2-design.md) with Geoffrey Huntley's writing and
Clayton Farr's playbook (which Huntley forked).

**Question:** von-ralph feels "not dynamic enough", as if it's too limited by
the implementation plan.

**Short answer:** The build loop can already change the plan: it can add,
split, fix and block items. What makes von-ralph feel rigid is that the runner
treats the plan as the thing the run is working toward. In Huntley's model the
plan is a scratch to-do list that the goal and specs produce and that gets
thrown away often.

## What von-ralph gets right

Most of the mechanics match the canonical method, and some go further than it:

- **One task per loop, fresh context every time.** Each iteration gets a new
  session and does one item.
- **Prompts are re-read every iteration**, and `ralph sign` adds guardrails.
  Huntley calls this tuning Ralph "like a guitar".
- **The runner runs validation itself** and feeds failures into the next
  prompt. That's the backpressure. Huntley notes that writing code is cheap and
  the hard part is "ensuring that Ralph has generated the right thing."
- **Watching the loop** is built in (watch, the observer, the web UI), and he
  treats that as part of the method.
- **Scoped plans are fixed when the plan is made** (`--scope`, `--bead`).
  Farr's playbook says to do exactly this rather than filter a big plan at run
  time.

## Where it's less dynamic than Huntley

### 1. Running out of plan stops the run; for Huntley it starts a new planning loop

[`src/modes.ts`](../src/modes.ts) ends the build with `plan_complete` or
`plan_exhausted` (the `snap.open === 0` / `snap.actionable === 0` checks at the
end of `review()`), and `no_progress` stops it too. A human then has to run
`ralph plan` again.

Huntley: *"Eventually, Ralph will run out of things to do in the TODO list. Or,
it goes completely off track. You run a Ralph loop… to generate a new TODO
list."* He relies on "eventual consistency", meaning more loops fix earlier
mistakes. In von-ralph the plan is the finish line. For him, the run is only
done when a fresh gap analysis of specs against code finds nothing left.

### 2. The plan is hard to throw away, especially with Beads

Huntley: *"The TODO list is what I'm watching like a hawk. And I throw it out
often."* Farr: *"If it's wrong, throw it out, and start over."*

Our plan is a structured database instead: IDs, dependencies, priorities and
acceptance criteria in `plan.json`, or Beads issues. The plan prompt tells the
agent to merge into it ("never duplicate, update instead") rather than replace
it. With Beads you can't really delete the to-do list at all, so the first
plan's structure sticks around. Farr also says to *"let Ralph/LLM dictate and
manage format that works best for it."*

### 3. All the breakdown happens up front

The plan prompt ([`src/templates.ts`](../src/templates.ts), `PLAN_PROMPT`)
makes every item "one iteration's worth" and links them with dependencies.
That's close to the "brick by brick, like Jenga" style Huntley contrasts with
loops.

The build agent then takes the "most important *ready* item" (`BUILD_PROMPT`).
With Beads, that effectively means whatever `bd ready` puts first. Huntley's
prompt says *"choose the most important thing"*, so the agent decides fresh
each loop what matters most given the current state of the code.

### 4. The agent can never touch specs

The plan prompt bans spec edits ("Do not change source code, tests,
configuration, or specs"; "The human owns the specs; do not invent
requirements"), and the planning loop is stopped for human review if anything
outside the plan changes (`scope_violation`).

Huntley lets Ralph update specs when it finds them inconsistent, and Farr says
build mode "can even create new specs if missing." Keeping humans in charge of
specs is a sound choice. But a total ban means a spec contradiction ends up as
a blocked item, then `plan_exhausted`, then the run stops.

### 5. The goal is weak; the plan carries the load

"Give it a goal then loop the goal." Our `goal` defaults to "Satisfy the
specifications" and does little. In Huntley's model, the goal plus specs plus
tests are what last, and the plan is a cache derived from them.

His newer stance pushes this further: *"code is the spec, folks. Markdown is
not a spec"* ([Toronto, Oct 2026](https://ghuntley.com/toronto/)). Acceptance
criteria should become tests, not stay as text on plan items.

## What to change (roughly by payoff)

1. **Re-plan automatically inside `build`.** When `plan_complete`,
   `plan_exhausted`, `no_progress` or drift would stop the run, make the next
   iteration a planning iteration, then carry on building. Only stop when a
   planning iteration finds nothing to add and no items remain open. Cap
   re-plans with a new `[limits] replans`. This is the single biggest change,
   and it fits neatly into the `review()` method in `modes.ts`: it switches
   which prompt the next iteration renders.
2. **Re-plan on drift, not only when the plan runs out.** The runner already
   tracks the signals: items added faster than they're closed, the same item
   reopened, repeated validation failures, a COMPLETE claim while items are
   still open. Also add a re-plan every N build iterations. Farr's triggers are
   going off track, a stale plan, clutter, and spec changes.
3. **Add a fresh-plan option** (`ralph plan --fresh`). It archives the current
   plan and regenerates from specs plus code alone, with no merging. For
   Beads, put each plan "epoch" under its own parent epic or label, so a fresh
   plan can `bd supersede` the whole epoch instead of reconciling item by item.
4. **Loosen the build prompt.** Say "choose the most important thing" rather
   than "top ready item". Allow fixing a bug that blocks the current item
   instead of always filing it. Allow editing a spec when it contradicts
   itself, but show those edits in `ralph report` for review rather than
   banning them.
5. **Turn acceptance criteria into tests during planning** (Farr: "can't claim
   done without required tests derived from acceptance criteria"). The tests
   become the spec, and the plan shrinks to a map pointing at them.
6. **Add a verify loop.** Per "everything is a ralph loop", a loop that audits
   the system against the specs and tests and files items, alongside the build
   loop that fixes them. Point 1 covers most of this, but a standalone
   `ralph verify` would be useful on a schedule.
7. **Refresh AGENTS.md and signs after each model release.** Huntley's hot
   take is that they "should be deleted after every model release." Signs only
   ever pile up today.

## Tradeoff

Some of the rigidity is deliberate and useful. Scope-violation checks,
human-owned specs, and Beads as the record for Beadsmith all serve a purpose.
Don't remove them. The goal is to move rigidity off the plan and onto the
backpressure: be strict about tests, types and the goal, and relaxed about the
plan.

## Limits of this review

The [Toronto post](https://ghuntley.com/toronto/) is paywalled partway
through, and the teaser mentions a talk on "loops, back pressure and
property-based testing" that wasn't readable. His talks (YouTube) and recent X
threads weren't reviewed.

## Sources

- [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/)
- [everything is a ralph loop](https://ghuntley.com/loop/)
- [state of agentic coding #11 (Toronto)](https://ghuntley.com/toronto/)
- [The Ralph Playbook (Farr)](https://claytonfarr.github.io/ralph-playbook/)
- [ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)
