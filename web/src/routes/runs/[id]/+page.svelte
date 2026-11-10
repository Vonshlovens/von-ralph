<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    type Iteration,
    type RalphEvent,
    type Report,
    type Run,
    type RunPlan,
    type RunSummaries,
    api,
    stream,
  } from "#lib/api.svelte.js";
  import { ago, describe, duration, stateOf, tildify, tokens } from "#lib/format.js";
  import PlanView from "#lib/PlanView.svelte";
  import ActivityView from "#lib/ActivityView.svelte";
  import EventIcon from "#lib/EventIcon.svelte";

  const id = $derived(page.params.id ?? "");

  let run = $state<Run | null>(null);
  let iterations = $state<Iteration[]>([]);
  let events = $state<{ id: number; event: RalphEvent }[]>([]);
  let report = $state<Report | null>(null);
  let error = $state("");
  let tab = $state<"overview" | "live" | "iterations" | "report">("overview");
  let plan = $state<RunPlan | null>(null);
  let summaries = $state<RunSummaries | null>(null);
  let planError = $state("");
  let summaryError = $state("");
  let follow = $state(true);
  let streaming = $state(false);
  let feed: HTMLElement | undefined = $state();

  async function refresh() {
    const requestedId = id;
    try {
      const r = await api.run(requestedId);
      if (requestedId !== id) return;
      run = r.run;
      iterations = r.iterations;
      error = "";
    } catch (e) {
      if (requestedId === id) error = (e as Error).message;
    }
  }

  async function loadReport() {
    const requestedId = id;
    try {
      const result = await api.report(requestedId);
      if (requestedId === id) report = result;
    } catch (e) {
      if (requestedId === id) error = (e as Error).message;
    }
  }

  // Events: one SSE stream per run id; it replays history, then follows live.
  $effect(() => {
    const runId = id;
    events = [];
    report = null;
    run = null;
    iterations = [];
    plan = null;
    summaries = null;
    planError = "";
    summaryError = "";
    error = "";
    tab = "overview";
    let disposed = false;
    let refreshingContext = false;
    let contextQueued = false;
    const refreshContext = async () => {
      if (refreshingContext) { contextQueued = true; return; }
      refreshingContext = true;
      const [savedPlan, savedSummaries] = await Promise.allSettled([api.plan(runId), api.summaries(runId)]);
      if (!disposed && runId === id) {
        if (savedPlan.status === "fulfilled") { plan = savedPlan.value; planError = ""; }
        else planError = (savedPlan.reason as Error).message;
        if (savedSummaries.status === "fulfilled") { summaries = savedSummaries.value; summaryError = ""; }
        else summaryError = (savedSummaries.reason as Error).message;
      }
      refreshingContext = false;
      if (contextQueued && !disposed) { contextQueued = false; void refreshContext(); }
    };
    void refresh();
    void refreshContext();
    const es = stream(`/v1/runs/${encodeURIComponent(runId)}/stream`);
    streaming = false;
    es.onopen = () => { if (!disposed) streaming = true; };
    const onEvent = (e: MessageEvent) => {
      if (disposed) return;
      const event = JSON.parse(e.data) as RalphEvent;
      const eventId = Number(e.lastEventId);
      if (events.some((entry) => entry.id === eventId)) return;
      events.push({ id: eventId, event });
      if (events.length > 2000) events.splice(0, events.length - 2000);
      const t = event.type;
      if (t === "iteration_finished" || t === "run_finished" || t === "iteration_started") void refresh();
      if (["plan_updated", "activity_summary", "iteration_summary", "observer_status", "run_finished"].includes(t)) void refreshContext();
    };
    const types = [
      "run_started", "iteration_started", "session", "assistant", "thinking", "tool_call",
      "tool_result", "usage", "error", "needs_input", "harness_exit", "steer_received",
      "iteration_finished", "validate", "plan_status", "scope_violation", "notice",
      "rate_limit_sleep", "run_finished", "turn_end",
      "plan_updated", "activity_summary", "iteration_summary", "observer_status",
    ];
    for (const t of types) es.addEventListener(t, onEvent as EventListener);
    es.addEventListener("end", () => {
      streaming = false;
      es.close();
      void refresh();
      void refreshContext();
    });
    es.onerror = () => {
      streaming = false;
      // EventSource reconnects with Last-Event-ID; once the run is over, stop.
      if (run !== null && run.status !== "running") {
        streaming = false;
        es.close();
      }
    };
    const poll = setInterval(() => {
      if (run?.status === "running") { void refresh(); void refreshContext(); }
    }, 5_000);
    return () => {
      disposed = true;
      es.close();
      clearInterval(poll);
    };
  });

  $effect(() => {
    if (tab === "report" && report === null) void loadReport();
  });

  // Keep the feed pinned to the bottom while following.
  $effect(() => {
    void events.length;
    if (follow && feed !== undefined && tab === "live") {
      queueMicrotask(() => feed?.scrollTo({ top: feed.scrollHeight }));
    }
  });

  const lines = $derived(
    events.flatMap((e) => {
      const d = describe(e.event);
      return d === null ? [] : [{ ...d, key: e.id, ts: e.event.ts, iteration: e.event.iteration }];
    }),
  );
  const attach = $derived(
    events.findLast((e) => e.event.type === "session" && typeof e.event.attachId === "string")?.event
      .attachId as string | undefined,
  );

  // ---------------------------------------------------------------- actions
  let steerText = $state("");
  let busy = $state(false);
  let notice = $state("");

  async function act(f: () => Promise<string>) {
    busy = true;
    notice = "";
    try {
      notice = await f();
      await refresh();
    } catch (e) {
      notice = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const steer = (e: SubmitEvent) => {
    e.preventDefault();
    const text = steerText.trim();
    if (text === "") return;
    void act(async () => {
      const r = await api.steer(id, text);
      steerText = "";
      return `Steer #${r.steerId} queued for the next iteration.`;
    });
  };
  const stop = (graceful: boolean) => {
    if (!graceful && !confirm(`Stop ${run?.name} now? The current iteration is interrupted.`)) return;
    void act(async () => (await api.stop(id, graceful)).message);
  };
  const restart = () =>
    void act(async () => {
      const r = await api.restart(id);
      await goto(`/runs/${encodeURIComponent(r.run.id)}`);
      return `Restarted as ${r.run.id}.`;
    });

  const st = $derived(run === null ? null : stateOf(run));
  const totalTokens = $derived(iterations.reduce((s, i) => s + i.inputTokens + i.outputTokens, 0));
  const cost = $derived(iterations.reduce((s, i) => s + (i.costUsd ?? 0), 0));
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });
  const iterationSummaries = $derived(new Map(summaries?.iterations.map((summary) => [summary.iteration, summary]) ?? []));
</script>

<svelte:head><title>ralph · {run?.name ?? id}</title></svelte:head>

<a class="back muted" href="/">← Runs</a>

{#if error && run === null}
  <p class="error">{error}</p>
{:else if run !== null}
  <section class="head">
    <div class="title">
      <h1>{run.name}</h1>
      <span class="pill s-{st}">{st}</span>
      <span class="mode mono">{run.mode}</span>
    </div>
    <dl class="facts mono">
      <div><dt>run</dt><dd>{run.id}</dd></div>
      <div><dt>dir</dt><dd title={run.dir}>{tildify(run.dir)}</dd></div>
      <div><dt>agent</dt><dd>{run.harness}{run.model ? `/${run.model}` : ""}{run.effort ? ` · ${run.effort}` : ""}</dd></div>
      <div><dt>iteration</dt><dd>{run.currentIteration}{run.maxIterations > 0 ? ` / ${run.maxIterations}` : ""}</dd></div>
      <div><dt>{run.status === "running" ? "started" : "ended"}</dt><dd>{ago(run.status === "running" ? run.startedAt : run.updatedAt)}</dd></div>
      {#if run.stopReason}<div><dt>reason</dt><dd>{run.stopReason}</dd></div>{/if}
      {#if totalTokens > 0}<div><dt>tokens</dt><dd>{tokens(totalTokens)}{cost > 0 ? ` · $${cost.toFixed(2)}` : ""}</dd></div>{/if}
      {#if run.scope}<div><dt>scope</dt><dd>{run.scope}</dd></div>{/if}
      {#if run.beadId}<div><dt>bead</dt><dd>{run.beadId}</dd></div>{/if}
    </dl>
    {#if run.mode === "run"}<pre class="prompt">{run.prompt}</pre>{/if}
  </section>

  <section class="controls panel">
    {#if run.status === "running" && run.alive}
      <form class="steer" onsubmit={steer}>
        <input aria-label="Note for the next iteration" bind:value={steerText} placeholder="A note for the next iteration" />
        <button type="submit" disabled={busy || steerText.trim() === ""}>Steer</button>
      </form>
      <button disabled={busy} onclick={() => stop(true)}>Stop after this iteration</button>
      <button class="danger" disabled={busy} onclick={() => stop(false)}>Stop now</button>
    {:else}
      <span class="muted">This run is over.</span>
      <span class="spacer"></span>
      <button disabled={busy} onclick={restart}>Restart with the same settings</button>
    {/if}
    {#if notice}<p class="notice">{notice}</p>{/if}
    {#if attach && run.status === "running"}
      <p class="attach muted">Watch or take over the agent: <code>{attach.startsWith("hc:") ? `hc attach '${JSON.parse(attach.slice(3)).address}'` : attach}</code></p>
    {/if}
  </section>

  <div class="tabs" role="group" aria-label="Run views">
    <button aria-pressed={tab === "overview"} class:on={tab === "overview"} onclick={() => (tab = "overview")}>Overview</button>
    <button aria-pressed={tab === "live"} class:on={tab === "live"} onclick={() => (tab = "live")}>
      Events {#if streaming}<span class="dot" title="Connected"></span>{/if}
    </button>
    <button aria-pressed={tab === "iterations"} class:on={tab === "iterations"} onclick={() => (tab = "iterations")}>
      Iterations <span class="count">{iterations.length}</span>
    </button>
    <button aria-pressed={tab === "report"} class:on={tab === "report"} onclick={() => (tab = "report")}>Report</button>
    {#if tab === "live"}
      <label class="follow"><input type="checkbox" bind:checked={follow} /> follow</label>
    {/if}
  </div>

  {#if error}<p class="error" role="status">{error}</p>{/if}
  {#if tab === "overview"}
    <div class="overview">
      <PlanView {plan} running={run.status === "running" && run.alive} error={planError} projectDir={run.dir} />
      <ActivityView {summaries} {iterations} running={run.status === "running" && run.alive} currentIteration={run.currentIteration} error={summaryError} />
    </div>
  {:else if tab === "live"}
    <div class="feed panel" bind:this={feed}>
      {#if lines.length === 0}
        <p class="muted">No events yet.</p>
      {/if}
      {#each lines as l (l.key)}
        <div class="line k-{l.kind}">
          <span class="t mono">{time(l.ts)}</span>
          <span class="i"><EventIcon kind={l.kind} /></span>
          <span class="x">{l.text}</span>
        </div>
      {/each}
    </div>
  {:else if tab === "iterations"}
    {#if iterations.length === 0}
      <p class="muted">No finished iterations yet.</p>
    {:else}
      <div class="table panel">
        <table>
          <thead>
            <tr><th>#</th><th>outcome</th><th>time</th><th>tokens</th><th>commit</th><th>validate</th><th>plan open</th><th>summary / last message</th></tr>
          </thead>
          <tbody>
            {#each iterations as i (i.iteration)}
              <tr>
                <td class="mono">{i.iteration}</td>
                <td><span class="outcome o-{i.outcome}">{i.outcome}</span></td>
                <td class="mono">{duration(i.durationMs)}</td>
                <td class="mono">{tokens(i.inputTokens + i.outputTokens)}</td>
                <td class="mono">{i.headBefore && i.headAfter && i.headBefore !== i.headAfter ? i.headAfter.slice(0, 7) : "—"}</td>
                <td class:error={i.validateOk === false}>{i.validateOk === null ? "—" : i.validateOk ? "Passed" : "Failed"}</td>
                <td class="mono">{i.planOpen ?? "—"}</td>
                <td class="iteration-summary">
                  {#if iterationSummaries.get(i.iteration)?.text}<p>{iterationSummaries.get(i.iteration)?.text}</p>{/if}
                  {#if iterationSummaries.get(i.iteration)?.error}<p class="error">Summary unavailable: {iterationSummaries.get(i.iteration)?.error}</p>{/if}
                  {#if i.error || i.lastAssistant}<details><summary>Agent’s last message</summary><p>{i.error ?? i.lastAssistant}</p></details>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else if report === null}
    <p class="muted">Loading report…</p>
  {:else}
    <div class="report">
      {#if report.needsHuman.length > 0}
        <div class="panel attention">
          <h2>Needs a human</h2>
          <ul>{#each report.needsHuman as n, k (k)}<li>{n}</li>{/each}</ul>
        </div>
      {/if}
      <div class="cards">
        <div class="panel card"><span class="muted">iterations</span><strong>{report.iterations}</strong><span class="muted">{Object.entries(report.outcomes).map(([k, v]) => `${v} ${k}`).join(", ")}</span></div>
        <div class="panel card"><span class="muted">duration</span><strong>{duration(report.durationMs)}</strong></div>
        <div class="panel card"><span class="muted">commits</span><strong>{report.commits.length}</strong></div>
        {#if report.plan}
          <div class="panel card"><span class="muted">plan open ({report.plan.backend})</span><strong>{report.plan.before.open ?? "?"} → {report.plan.after.open ?? "?"}</strong><span class="muted">{report.plan.after.ready ?? 0} ready</span></div>
        {/if}
        {#if report.validate.runs > 0}
          <div class="panel card"><span class="muted">validation</span><strong>{report.validate.runs - report.validate.failures}/{report.validate.runs}</strong><span class="muted">last {report.validate.last?.ok ? "passed" : "failed"}</span></div>
        {/if}
      </div>
      {#if report.validate.last && !report.validate.last.ok}
        <div class="panel block">
          <h2>Last validation failure</h2>
          {#each report.validate.last.results.filter((x: { exitCode: number | null }) => x.exitCode !== 0) as x, k (k)}
            <p class="mono">{x.command} → {x.exitCode ?? "timeout"}</p>
            <pre>{x.output.slice(-3000)}</pre>
          {/each}
        </div>
      {/if}
      <div class="panel block">
        <h2>Commits</h2>
        {#if report.commits.length === 0}<p class="muted">None.</p>{/if}
        <ul class="mono commits">{#each report.commits as c, k (k)}<li>{c}</li>{/each}</ul>
        {#if report.diffStat}<pre>{report.diffStat}</pre>{/if}
      </div>
      {#if report.lastWords}
        <div class="panel block">
          <h2>Last message</h2>
          <pre class="words">{report.lastWords}</pre>
        </div>
      {/if}
      <p class="muted mono">log: {report.logPath}</p>
    </div>
  {/if}
{/if}

<style>
  .back {
    text-decoration: none;
    font-size: 13px;
  }
  .head {
    margin: 10px 0 16px;
  }
  .overview { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 36px; padding-top: 12px; align-items: start; }
  .overview > :global(:last-child) { padding-left: 30px; border-left: 1px solid var(--line); }
  .iteration-summary { min-width: 260px; max-width: 480px; }
  .iteration-summary p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .iteration-summary summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  @media (max-width: 800px) {
    .overview { grid-template-columns: minmax(0, 1fr); gap: 28px; }
    .overview > :global(:last-child) { padding-left: 0; padding-top: 24px; border-left: 0; border-top: 1px solid var(--line); }
    .tabs { flex-wrap: wrap; }
    .tabs button { padding: 8px; }
    .facts div { min-width: 0; max-width: 100%; }
    dd { overflow-wrap: anywhere; }
    h1 { overflow-wrap: anywhere; }
  }
  .title {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    letter-spacing: -0.01em;
  }
  .mode {
    color: var(--accent);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 22px;
    margin: 10px 0 0;
  }
  .facts div {
    display: flex;
    gap: 6px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .prompt {
    margin: 12px 0 0;
    padding: 10px 12px;
    background: var(--panel-2);
    border-radius: 0;
    white-space: pre-wrap;
    max-height: 160px;
    overflow: auto;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    border: 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    background: transparent;
    margin-bottom: 18px;
  }
  .steer {
    display: flex;
    gap: 8px;
    flex: 1 1 360px;
  }
  .spacer {
    flex: 1;
  }
  .notice,
  .attach {
    flex-basis: 100%;
    margin: 2px 2px 0;
    font-size: 13px;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 12px;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 8px 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tabs button.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .count {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--panel-2);
    padding: 0 6px;
    border-radius: 0;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--good);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }
  .follow {
    margin-left: auto;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  .follow input {
    width: auto;
    flex-basis: auto;
  }
  .feed {
    height: min(64vh, 720px);
    overflow: auto;
    padding: 10px 4px;
  }
  .line {
    display: grid;
    grid-template-columns: 70px 22px minmax(0, 1fr);
    gap: 6px;
    padding: 2px 10px;
    align-items: baseline;
  }
  .line .t {
    color: var(--muted);
    font-size: 12px;
  }
  .line .i { display: flex; align-self: start; margin-top: 3px; color: var(--muted); }
  .k-good .i { color: var(--good); }
  .k-bad .i { color: var(--bad); }
  .k-warn .i { color: var(--warn); }
  .line .x {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .k-tool .x,
  .k-result .x {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  .k-marker {
    margin-top: 6px;
    font-weight: 600;
  }
  .k-marker .x {
    color: var(--accent);
    font-family: var(--mono);
    font-size: 13px;
  }
  .k-good .x {
    color: var(--good);
  }
  .k-bad .x {
    color: var(--bad);
  }
  .k-warn .x {
    color: var(--warn);
  }
  .k-info .x {
    color: var(--info);
  }
  .table {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  th {
    font-weight: 500;
    color: var(--muted);
    font-size: 12px;
  }
  tr:last-child td {
    border-bottom: none;
  }
  .last {
    max-width: 380px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .outcome {
    font-family: var(--mono);
    font-size: 12px;
  }
  .o-completed {
    color: var(--good);
  }
  .o-failed,
  .o-auth_failed,
  .o-timed_out {
    color: var(--bad);
  }
  .o-blocked,
  .o-rate_limited,
  .o-interrupted {
    color: var(--warn);
  }
  .report {
    display: grid;
    gap: 12px;
  }
  .attention {
    padding: 12px 16px;
    border-color: var(--warn);
  }
  .attention ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 14px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 0;
    border-top: var(--rule-w) solid var(--rule);
    border-bottom: 1px solid var(--line);
  }
  .card {
    padding: 16px 14px;
    border: 0;
    background: transparent;
    display: grid;
    gap: 2px;
  }
  .card strong {
    font-size: 24px;
    font-family: var(--mono);
  }
  .card span {
    font-size: 12px;
  }
  .block {
    padding: 12px 16px;
  }
  .block pre {
    background: var(--panel-2);
    padding: 10px;
    border-radius: 0;
    overflow: auto;
    max-height: 360px;
  }
  .commits {
    margin: 0;
    padding-left: 18px;
  }
  .words {
    white-space: pre-wrap;
  }
</style>
