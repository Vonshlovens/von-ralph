<script lang="ts">
  import { goto } from "$app/navigation";
  import { type Harness, type Mode, type Run, api, stream } from "#lib/api.svelte.js";
  import { ago, basename, stateOf, tokens } from "#lib/format.js";

  let runs = $state<Run[]>([]);
  let loaded = $state(false);
  let live = $state(false);
  let filter = $state<"all" | "active" | "attention">("all");
  let now = $state(Date.now());
  let showNew = $state(false);

  $effect(() => {
    const es = stream("/v1/stream");
    es.addEventListener("runs", (e: MessageEvent) => {
      runs = JSON.parse(e.data) as Run[];
      loaded = true;
    });
    es.onopen = () => (live = true);
    es.onerror = () => {
      live = false;
      // Fall back to one fetch (also surfaces a 401 as the token prompt).
      api.runs().then((r: { runs: Run[] }) => {
        runs = r.runs;
        loaded = true;
      }, () => {});
    };
    const tick = setInterval(() => (now = Date.now()), 15_000);
    return () => {
      es.close();
      clearInterval(tick);
    };
  });

  const attention = (r: Run) =>
    stateOf(r) === "dead" ||
    r.status === "failed" ||
    ["plan_exhausted", "no_progress", "blocked", "auth_failed", "rate_limited"].includes(r.stopReason ?? "");

  const shown = $derived(
    runs.filter((r) =>
      filter === "active" ? r.status === "running" : filter === "attention" ? attention(r) : true,
    ),
  );
  const counts = $derived({
    active: runs.filter((r) => r.status === "running" && r.alive).length,
    attention: runs.filter(attention).length,
  });

  // ---------------------------------------------------------------- new run
  let form = $state({
    mode: "build" as Mode,
    dir: "",
    prompt: "",
    name: "",
    harness: "" as Harness | "",
    model: "",
    max: "",
    scope: "",
    callbackUrl: "",
  });
  let starting = $state(false);
  let startError = $state("");

  async function start(e: SubmitEvent) {
    e.preventDefault();
    starting = true;
    startError = "";
    const opt = (s: string) => (s.trim() === "" ? null : s.trim());
    try {
      const { run } = await api.start({
        mode: form.mode,
        dir: form.dir.trim(),
        prompt: form.mode === "run" ? form.prompt : null,
        name: opt(form.name),
        harness: form.harness === "" ? null : form.harness,
        model: opt(form.model),
        max: form.max.trim() === "" ? null : Number(form.max),
        scope: form.mode === "run" ? null : opt(form.scope),
        callbackUrl: opt(form.callbackUrl),
      });
      showNew = false;
      await goto(`/runs/${encodeURIComponent(run.id)}`);
    } catch (err) {
      startError = (err as Error).message;
    } finally {
      starting = false;
    }
  }
</script>

<svelte:head><title>ralph · runs</title></svelte:head>

<div class="bar">
  <div>
    <h1>Runs</h1>
    <p class="muted">
      <span class="live" class:on={live}></span>
      {counts.active} running{#if counts.attention > 0} · <span class="error">{counts.attention} need a look</span>{/if}
    </p>
  </div>
  <div class="actions">
    <div class="seg" role="group" aria-label="Filter">
      <button class:on={filter === "all"} onclick={() => (filter = "all")}>All</button>
      <button class:on={filter === "active"} onclick={() => (filter = "active")}>Running</button>
      <button class:on={filter === "attention"} onclick={() => (filter = "attention")}>Needs a look</button>
    </div>
    <button class="primary" onclick={() => (showNew = !showNew)}>{showNew ? "Cancel" : "New run"}</button>
  </div>
</div>

{#if showNew}
  <form class="panel new" onsubmit={start}>
    <div class="grid">
      <label>
        Mode
        <select bind:value={form.mode}>
          <option value="build">build — one plan item per iteration</option>
          <option value="plan">plan — gap analysis, no code changes</option>
          <option value="reverse">reverse — specs from existing code</option>
          <option value="run">run — free-form prompt</option>
        </select>
      </label>
      <label class="wide">
        Project directory
        <input bind:value={form.dir} placeholder="~/repos/api" required />
      </label>
      {#if form.mode === "run"}
        <label class="full">
          Prompt
          <textarea bind:value={form.prompt} rows="3" placeholder="See AGENT_PROMPT.md" required></textarea>
        </label>
      {:else}
        <label class="wide">
          Scope <span>(optional)</span>
          <input bind:value={form.scope} placeholder="e.g. billing webhooks" />
        </label>
      {/if}
      <label>
        Harness
        <select bind:value={form.harness}>
          <option value="">ralph.toml / claude</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
          <option value="opencode">opencode</option>
          <option value="gh">gh (copilot)</option>
        </select>
      </label>
      <label>
        Model <span>(optional)</span>
        <input bind:value={form.model} placeholder="harness default" />
      </label>
      <label>
        Max iterations
        <input bind:value={form.max} inputmode="numeric" placeholder="ralph.toml default" />
      </label>
      <label>
        Name <span>(optional)</span>
        <input bind:value={form.name} placeholder="{form.mode}-<dir>" />
      </label>
      <label class="wide">
        Callback URL <span>(optional)</span>
        <input bind:value={form.callbackUrl} placeholder="POSTed a summary when the run ends" />
      </label>
    </div>
    <div class="submit">
      {#if startError}<span class="error">{startError}</span>{/if}
      <button class="primary" type="submit" disabled={starting}>{starting ? "Starting…" : "Start"}</button>
    </div>
  </form>
{/if}

{#if !loaded}
  <p class="muted">Loading…</p>
{:else if shown.length === 0}
  <div class="empty panel">
    {#if runs.length === 0}
      <p>No runs yet.</p>
      <p class="muted">Start one here, or from a terminal: <code>ralph build --detach</code></p>
    {:else}
      <p class="muted">Nothing matches this filter.</p>
    {/if}
  </div>
{:else}
  <ul class="runs">
    {#each shown as r (r.id)}
      {@const st = stateOf(r)}
      <li>
        <a class="panel run" href={`/runs/${encodeURIComponent(r.id)}`}>
          <div class="top">
            <span class="name">{r.name}</span>
            <span class="pill s-{st}">{st}</span>
            <span class="mode mono">{r.mode}</span>
            <span class="spacer"></span>
            <span class="muted mono">{ago(r.status === "running" ? r.startedAt : r.updatedAt, now)}</span>
          </div>
          <div class="meta mono">
            <span title={r.dir}>{basename(r.dir)}</span>
            <span>{r.harness}{r.model ? `/${r.model}` : ""}</span>
            <span>iter {r.currentIteration}{r.maxIterations > 0 ? `/${r.maxIterations}` : ""}</span>
            {#if r.lastOutcome}<span>last {r.lastOutcome}</span>{/if}
            {#if r.stopReason}<span class:error={attention(r)}>{r.stopReason}</span>{/if}
            {#if r.inputTokens + r.outputTokens > 0}<span>{tokens(r.inputTokens + r.outputTokens)} tok</span>{/if}
            {#if r.costUsd > 0}<span>${r.costUsd.toFixed(2)}</span>{/if}
          </div>
          {#if r.mode === "run" || r.scope}
            <div class="prompt muted">{r.mode === "run" ? r.prompt : `scope: ${r.scope}`}</div>
          {/if}
          {#if r.status === "running" && r.maxIterations > 0}
            <div class="progress" aria-hidden="true">
              <span style="width: {Math.min(100, (r.currentIteration / r.maxIterations) * 100)}%"></span>
            </div>
          {/if}
        </a>
      </li>
    {/each}
  </ul>
  <p class="muted foot">Latest run per name. Every run: <code>ralph status --all</code></p>
{/if}

<style>
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    letter-spacing: -0.01em;
  }
  .bar p {
    margin: 2px 0 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
  }
  .live.on {
    background: var(--good);
  }
  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .seg {
    display: flex;
  }
  .seg button {
    border-radius: 0;
    margin-left: -1px;
    background: var(--panel);
    color: var(--muted);
  }
  .seg button:first-child {
    border-radius: 6px 0 0 6px;
  }
  .seg button:last-child {
    border-radius: 0 6px 6px 0;
  }
  .seg button.on {
    color: var(--ink);
    background: var(--panel-2);
  }
  .new {
    padding: 16px;
    margin-bottom: 18px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .grid .wide {
    grid-column: span 2;
  }
  .grid .full {
    grid-column: 1 / -1;
  }
  label span {
    opacity: 0.7;
  }
  .submit {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .runs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .run {
    display: block;
    padding: 12px 14px;
    text-decoration: none;
    transition: border-color 0.15s;
  }
  .run:hover {
    border-color: var(--muted);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .name {
    font-weight: 600;
    font-size: 15px;
  }
  .mode {
    color: var(--accent);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 4px;
    color: var(--muted);
  }
  .prompt {
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .progress {
    margin-top: 8px;
    height: 3px;
    background: var(--panel-2);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--good);
  }
  .empty {
    padding: 28px;
    text-align: center;
  }
  .empty p {
    margin: 4px 0;
  }
  .foot {
    margin-top: 14px;
    font-size: 12px;
  }
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: 1fr 1fr;
    }
    .grid .wide,
    .grid .full {
      grid-column: 1 / -1;
    }
  }
</style>
