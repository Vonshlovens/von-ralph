<script lang="ts">
  import type { Iteration, RunSummaries } from "./api.svelte.js";
  import { ago, duration } from "./format.js";

  let { summaries, iterations, running, currentIteration, error = "" }: {
    summaries: RunSummaries | null;
    iterations: Iteration[];
    running: boolean;
    currentIteration: number;
    error?: string;
  } = $props();

  const current = $derived(summaries?.current ?? null);
  const currentIsLive = $derived(running && current?.iteration === currentIteration);
  const history = $derived([...(summaries?.iterations ?? [])].sort((a, b) => b.iteration - a.iteration));
  const observer = $derived(summaries?.observer);
</script>

<div class="activity-view">
  <section class="current-activity" aria-labelledby="activity-title">
    <div class="section-heading">
      <h2 id="activity-title">{running ? "Current activity" : "Last activity"}</h2>
      {#if observer?.enabled || current}<span class="muted mono" title={current?.model ?? observer?.model ?? "claude-haiku-5-5"}>Haiku 5.5</span>{/if}
    </div>
    <div class="activity-body" role="status" aria-live="polite">
      {#if error}
        <p class="error">Couldn’t load activity summaries. {error}</p>
      {:else if current?.error}
        <p class="summary-error">Activity summary unavailable.</p>
        <p class="muted">{current.error}</p>
      {:else if current?.text}
        <p class="narrative">{current.text}</p>
      {:else if observer?.enabled === false}
        <p class="muted">Activity summaries are turned off for this run.</p>
      {:else if observer?.available === false}
        <p class="summary-error">The activity observer is unavailable.</p>
        {#if observer.error}<p class="muted">{observer.error}</p>{/if}
      {:else if summaries && observer === null}
        <p class="muted">This run started before activity summaries were available.</p>
      {:else}
        <p class="muted">{running ? "Waiting for the first activity summary." : "No activity summary was recorded for this run."}</p>
      {/if}
    </div>
    {#if current}
      <p class="summary-time mono muted">
        Iteration {current.iteration} · {ago(current.createdAt)}{!currentIsLive && running ? " · previous activity" : ""}
      </p>
    {/if}
  </section>

  <section class="history" aria-labelledby="history-title">
    <div class="section-heading">
      <h2 id="history-title">Loop summaries</h2>
      <span class="muted mono">{history.length} recorded</span>
    </div>
    {#if history.length === 0}
      <p class="muted history-empty">{running && observer?.enabled ? "A summary will appear after each iteration ends." : "No loop summaries were recorded for this run."}</p>
    {:else}
      <ol>
        {#each history as summary (summary.iteration)}
          {@const iteration = iterations.find((item) => item.iteration === summary.iteration)}
          <li>
            <div class="iteration-heading mono">
              <h3>Iteration {summary.iteration}</h3>
              {#if iteration}<span class:failed={iteration.outcome !== "completed"}>{iteration.outcome} · {duration(iteration.durationMs)}</span>{/if}
            </div>
            {#if summary.error}<p class="summary-error">Summary unavailable: {summary.error}</p>{:else}<p class="narrative">{summary.text}</p>{/if}
            <p class="summary-time mono muted">{ago(summary.createdAt)}</p>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .activity-view { min-width: 0; }
  .section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  h2 { font-size: 16px; font-weight: 600; margin: 0; }
  .activity-body { margin-top: 14px; }
  .activity-body p { margin: 0 0 10px; }
  .narrative { max-width: 70ch; font-family: var(--sans); font-size: 16px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
  .summary-time { margin: 10px 0 0; }
  .summary-error, .failed { color: var(--warn); }
  .history { border-top: 1px solid var(--line); padding-top: 22px; margin-top: 26px; }
  .history-empty { margin: 14px 0; }
  ol { list-style: none; padding: 0; margin: 8px 0 0; }
  li { padding: 16px 0; border-bottom: 1px solid var(--line); }
  li:last-child { border-bottom: 0; }
  .iteration-heading { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: baseline; }
  h3 { margin: 0; font: inherit; font-weight: 600; color: var(--ink); }
  .iteration-heading span { color: var(--muted); font-size: 12px; }
  .iteration-heading .failed { color: var(--warn); }
  li .narrative { font-size: 13px; margin: 8px 0 0; }
</style>
