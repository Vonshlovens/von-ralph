<script lang="ts">
  import type { RunPlan } from "./api.svelte.js";
  import { ago } from "./format.js";

  let { plan, running, error = "", projectDir }: { plan: RunPlan | null; running: boolean; error?: string; projectDir?: string } = $props();
  let showCompleted = $state(false);
  const done = $derived(plan?.items.filter((item) => item.status === "done").length ?? 0);
  const working = $derived(plan?.items.filter((item) => item.status === "in_progress").length ?? 0);
  const largePlan = $derived((plan?.items.length ?? 0) > 24);
  const shown = $derived(plan?.items.filter((item) => !largePlan || showCompleted || item.status !== "done") ?? []);
  const active = $derived(running ? plan?.items.filter((item) => item.status === "in_progress") ?? [] : []);
  const labels = { open: "Planned", in_progress: "In progress", done: "Done", blocked: "Blocked", deferred: "Deferred" };
</script>

<section class="plan-view" aria-labelledby="plan-title">
  <div class="section-heading">
    <h2 id="plan-title">Implementation plan</h2>
    {#if plan?.backend}<span class="muted mono">{plan.backend}</span>{/if}
  </div>
  {#if plan?.scope && (plan.scope.label || plan.scope.parent || plan.scope.bead)}
    <p class="muted mono scope">{[plan.scope.label && `Label ${plan.scope.label}`, plan.scope.parent && `Parent ${plan.scope.parent}`, plan.scope.bead && `Bead ${plan.scope.bead}`].filter(Boolean).join(" · ")}</p>
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
      <span>{done} / {plan.items.length} done</span>
      {#if working > 0}<span class:working={running}>{working} {running ? "in progress" : "unfinished"}</span>{/if}
    </div>
    <progress value={done} max={plan.items.length} aria-label="Completed plan steps">{done} of {plan.items.length}</progress>
    {#if largePlan && active.length > 0}
      <p class="active-links mono">Working on {#each active as item, index (item.id)}{index > 0 ? ", " : ""}<a href={`#plan-step-${item.id}`}>{item.id}</a>{/each}</p>
    {/if}
    {#if largePlan && done > 0}
      <button class="completed-toggle mono" aria-pressed={showCompleted} onclick={() => (showCompleted = !showCompleted)}>{showCompleted ? "Hide" : "Show"} {done} completed steps</button>
    {/if}
    <ol class="steps">
      {#each shown as item (item.id)}
        <li id={`plan-step-${item.id}`} class="step" class:current={running && item.status === "in_progress"} class:done={item.status === "done"} aria-current={running && item.status === "in_progress" ? "step" : undefined}>
          <div class="step-meta mono">
            <span>{item.id}</span>
            <span class="step-state state-{item.status}">{item.status === "in_progress" && running ? "Working" : labels[item.status]}</span>
          </div>
          <h3>{item.title}</h3>
          {#if item.depends_on.length > 0}<p class="dependencies muted mono">After {item.depends_on.join(", ")}</p>{/if}
          {#if item.acceptance || item.notes.length > 0 || item.spec_refs.length > 0}
            <details>
              <summary>Step details</summary>
              {#if item.acceptance}<p>{item.acceptance}</p>{/if}
              {#if item.notes.length > 0}<ul>{#each item.notes as note, index (index)}<li>{note}</li>{/each}</ul>{/if}
              {#if item.spec_refs.length > 0}<p class="mono muted">{item.spec_refs.join(" · ")}</p>{/if}
            </details>
          {/if}
        </li>
      {/each}
    </ol>
    {#if shown.length === 0}<p class="muted">Every step is complete.</p>{/if}
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
  progress { display: block; width: 100%; height: 4px; border: 0; background: var(--panel-2); accent-color: var(--good); margin-bottom: 18px; }
  progress::-webkit-progress-bar { background: var(--panel-2); }
  progress::-webkit-progress-value { background: var(--good); }
  progress::-moz-progress-bar { background: var(--good); }
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
