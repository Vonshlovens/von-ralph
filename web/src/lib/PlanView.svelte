<script lang="ts">
  import type { RunPlan } from "./api.svelte.js";
  import { ago } from "./format.js";

  let { plan, running, error = "", projectDir }: { plan: RunPlan | null; running: boolean; error?: string; projectDir?: string } = $props();
  let showCompleted = $state(false);
  const items = $derived(plan?.items ?? []);
  const beads = $derived(plan?.backend === "beads");
  const noun = $derived(beads ? "beads" : "steps");
  const count = (status: string) => items.filter((item) => item.status === status).length;
  const done = $derived(count("done"));
  const working = $derived(count("in_progress"));
  const blocked = $derived(count("blocked"));
  const deferred = $derived(count("deferred"));
  // "ready" only exists on newer saved plans; without it every open item is just "open".
  const hasReady = $derived(items.some((item) => item.ready !== undefined));
  const ready = $derived(items.filter((item) => item.status === "open" && item.ready).length);
  const waiting = $derived(count("open") - ready);
  const remaining = $derived(items.length - done);
  // What this run itself closed, against the plan as it first read it.
  const closedThisRun = $derived.by(() => {
    const before = new Set(plan?.baseline?.done ?? []);
    return plan?.baseline ? items.filter((item) => item.status === "done" && !before.has(item.id)).length : null;
  });
  const addedThisRun = $derived.by(() => {
    const before = plan?.baseline?.ids;
    if (!before) return null;
    const ids = new Set(before);
    return items.filter((item) => !ids.has(item.id)).length;
  });
  const doneBefore = $derived(closedThisRun === null ? done : done - closedThisRun);
  const pct = (n: number) => (items.length === 0 ? 0 : (n / items.length) * 100);
  const segments = $derived([
    { key: "before", n: doneBefore, label: closedThisRun === null ? "closed" : "closed before this run" },
    { key: "this-run", n: closedThisRun ?? 0, label: "closed by this run" },
    { key: "in_progress", n: working, label: running ? "in progress" : "left in progress" },
    { key: "blocked", n: blocked, label: "blocked" },
  ].filter((segment) => segment.n > 0));
  const breakdown = $derived([
    { key: "in_progress", n: working, label: running ? "in progress" : "left in progress", hint: running ? "claimed and being worked on now" : "claimed when the run ended but not closed" },
    { key: "ready", n: hasReady ? ready : 0, label: "ready", hint: "open with nothing blocking it" },
    { key: "open", n: hasReady ? waiting : count("open"), label: hasReady ? "waiting" : "open", hint: hasReady ? "open, waiting on another item" : "not started" },
    { key: "blocked", n: blocked, label: "blocked", hint: "marked blocked" },
    { key: "deferred", n: deferred, label: "deferred", hint: "deferred or pinned; not counted as work left" },
  ].filter((part) => part.n > 0));
  const largePlan = $derived((plan?.items.length ?? 0) > 24);
  const shown = $derived(plan?.items.filter((item) => !largePlan || showCompleted || item.status !== "done") ?? []);
  const active = $derived(running ? plan?.items.filter((item) => item.status === "in_progress") ?? [] : []);
  const labels = { open: "Planned", in_progress: "In progress", done: "Done", blocked: "Blocked", deferred: "Deferred" };
</script>

<section class="plan-view" aria-labelledby="plan-title">
  <div class="section-heading">
    <h2 id="plan-title">{beads ? "Beads" : "Implementation plan"}</h2>
    {#if plan?.backend}<span class="muted mono" title={beads ? "The plan for this run is the set of beads in its scope; each bead is one step." : "The plan is IMPLEMENTATION_PLAN.md."}>{beads ? "bd issues in scope" : "markdown plan"}</span>{/if}
  </div>
  {#if plan?.scope && (plan.scope.label || plan.scope.parent || plan.scope.bead)}
    <p class="muted mono scope">{[plan.scope.label && `Label ${plan.scope.label}`, plan.scope.parent && `Children of ${plan.scope.parent} (epic itself not counted)`, plan.scope.bead && `Bead ${plan.scope.bead}`].filter(Boolean).join(" · ")}</p>
  {/if}
  {#if error || plan?.error}
    <p class="error" role="status">Couldn’t load the plan. {error || plan?.error}</p>
  {/if}
  {#if plan === null}
    {#if !error}<p class="muted" role="status">Loading the plan…</p>{/if}
  {:else if plan.items.length === 0}
    <div class="empty-plan">
      <p>No saved plan for this run.</p>
      {#if projectDir}
        <p><a href={`/plan?${new URLSearchParams({ dir: projectDir })}`}>View the current project plan</a></p>
      {:else}
        <p class="muted">{running ? "The steps will appear here when the agent saves its plan." : "This run has no recorded plan steps."}</p>
      {/if}
    </div>
  {:else}
    {#if plan.goal}<p class="goal">{plan.goal}</p>{/if}
    <div class="plan-counts mono">
      <span>{done} / {items.length} {noun} {beads ? "closed" : "done"}</span>
      {#if closedThisRun !== null}<span><span class="this-run">{closedThisRun} closed by this run</span>{#if addedThisRun}<span class="muted"> · {addedThisRun} new</span>{/if}</span>{/if}
    </div>
    <div class="bar" role="img" aria-label={`${done} of ${items.length} ${noun} ${beads ? "closed" : "done"}${closedThisRun !== null ? `, ${closedThisRun} by this run` : ""}`}>
      {#each segments as segment (segment.key)}<span class="seg seg-{segment.key}" style:width="{pct(segment.n)}%" title="{segment.n} {segment.label}"></span>{/each}
    </div>
    {#if remaining > 0}
      <ul class="breakdown mono" aria-label={`${remaining} ${noun} not ${beads ? "closed" : "done"}`}>
        <li class="muted">{remaining} left:</li>
        {#each breakdown as part (part.key)}<li class="state-{part.key}" class:working={part.key === "in_progress" && running} title={part.hint}><span class="dot"></span>{part.n} {part.label}</li>{/each}
      </ul>
    {/if}
    {#if largePlan && active.length > 0}
      <p class="active-links mono">Working on {#each active as item, index (item.id)}{index > 0 ? ", " : ""}<a href={`#plan-step-${item.id}`}>{item.id}</a>{/each}</p>
    {/if}
    {#if largePlan && done > 0}
      <button class="completed-toggle mono" aria-pressed={showCompleted} onclick={() => (showCompleted = !showCompleted)}>{showCompleted ? "Hide" : "Show"} {done} {beads ? "closed beads" : "completed steps"}</button>
    {/if}
    <ol class="steps">
      {#each shown as item (item.id)}
        <li id={`plan-step-${item.id}`} class="step" class:current={running && item.status === "in_progress"} class:done={item.status === "done"} aria-current={running && item.status === "in_progress" ? "step" : undefined}>
          <div class="step-meta mono">
            <span>{item.id}</span>
            <span class="step-state state-{item.status}">{#if closedThisRun !== null && item.status === "done" && !plan.baseline?.done.includes(item.id)}<span class="this-run">this run · </span>{/if}{item.status === "in_progress" && running ? "Working" : item.status === "in_progress" ? "Left in progress" : item.status === "open" && item.ready ? "Ready" : labels[item.status]}</span>
          </div>
          <h3>{item.title}</h3>
          {#if item.depends_on.length > 0}<p class="dependencies muted mono">After {item.depends_on.join(", ")}</p>{/if}
          {#if item.acceptance || item.notes.length > 0 || item.spec_refs.length > 0}
            <details>
              <summary>{beads ? "Bead details" : "Step details"}</summary>
              {#if item.acceptance}<p>{item.acceptance}</p>{/if}
              {#if item.notes.length > 0}<ul>{#each item.notes as note, index (index)}<li>{note}</li>{/each}</ul>{/if}
              {#if item.spec_refs.length > 0}<p class="mono muted">{item.spec_refs.join(" · ")}</p>{/if}
            </details>
          {/if}
        </li>
      {/each}
    </ol>
    {#if shown.length === 0}<p class="muted">{beads ? "Every bead is closed." : "Every step is complete."}</p>{/if}
    {#if plan.learnings.length > 0}
      <details class="learnings">
        <summary>Learnings · {plan.learnings.length}</summary>
        <ul>{#each plan.learnings as learning, index (index)}<li>{learning}</li>{/each}</ul>
      </details>
    {/if}
  {/if}
  {#if plan?.updatedAt}<p class="plan-updated muted mono">{running ? "Updated" : "Recorded"} {ago(plan.updatedAt)}</p>{/if}
</section>

<style>
  .plan-view { min-width: 0; }
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .goal { margin: 14px 0; max-width: 70ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  .scope { overflow-wrap: anywhere; }
  .plan-counts { display: flex; justify-content: space-between; gap: 12px; margin: 14px 0 6px; }
  .working, .state-in_progress { color: var(--info); }
  .this-run { color: var(--good); }
  .bar { display: flex; width: 100%; height: 4px; background: var(--panel-2); margin-bottom: 10px; overflow: hidden; }
  .seg { display: block; height: 100%; }
  .seg-before { background: var(--good); opacity: 0.45; }
  .seg-this-run { background: var(--good); }
  .seg-in_progress { background: var(--info); }
  .seg-blocked { background: var(--warn); }
  .breakdown { display: flex; flex-wrap: wrap; gap: 4px 14px; list-style: none; margin: 0 0 18px; padding: 0; font-size: 13px; }
  .breakdown li { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .breakdown .state-open, .breakdown .state-deferred { color: var(--muted); }
  .breakdown .state-ready { color: inherit; }
  .steps { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  .step { padding: 14px 12px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; scroll-margin-top: 150px; }
  .active-links { color: var(--info); }
  .completed-toggle { margin-bottom: 12px; }
  .step.current { background: var(--active-bg, var(--panel-2)); outline: 1px solid var(--info); outline-offset: -1px; }
  .step-meta { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); }
  .step-state { white-space: nowrap; }
  .state-blocked { color: var(--warn); }
  .state-done { color: var(--good); }
  h3 { font-size: 14px; line-height: 1.55; font-weight: 500; margin: 5px 0 0; }
  .done h3 { color: var(--muted); }
  .current h3 { font-weight: 600; }
  .dependencies { margin: 6px 0 0; }
  details { margin-top: 8px; font-size: 13px; }
  summary { color: var(--muted); cursor: pointer; width: fit-content; }
  details p { margin: 8px 0; white-space: pre-wrap; }
  details ul { padding-left: 20px; }
  .learnings { padding: 8px 12px; }
  .plan-updated { margin: 14px 0 0; }
  .empty-plan { padding: 24px 0; }
  .empty-plan p { margin: 0 0 6px; }
</style>
