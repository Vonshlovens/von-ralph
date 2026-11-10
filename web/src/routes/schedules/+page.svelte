<script lang="ts">
  import { type Schedule, api } from "#lib/api.svelte.js";
  import { ago, tildify } from "#lib/format.js";

  let schedules = $state<Schedule[] | null>(null);
  let error = $state("");
  let notice = $state("");

  async function load() {
    try {
      schedules = (await api.schedules()).schedules;
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  });

  async function runNow(name: string) {
    notice = "";
    try {
      await api.runSchedule(name);
      notice = `Started ${name}; it appears under Runs in a moment.`;
      setTimeout(load, 1500);
    } catch (e) {
      notice = (e as Error).message;
    }
  }

  const stateOf = (s: Schedule) => (s.running ? "running" : s.enabled ? "enabled" : "paused");
  const result = (s: Schedule) =>
    s.lastRun === null
      ? "never ran"
      : s.lastExitCode === 0
        ? "done"
        : s.lastExitCode === 3
          ? "needs a human"
          : `${s.lastResult ?? "failed"}${s.lastExitCode === null ? "" : ` (exit ${s.lastExitCode})`}`;
</script>

<svelte:head><title>ralph · schedules</title></svelte:head>

<h1>Schedules</h1>
<p class="muted lead">
  systemd user timers that run ralph in the foreground. Add one from a terminal:
  <code>ralph schedule add nightly --cron "0 2 * * *" -- build -d ~/repo -N 8</code>
</p>

{#if error}<p class="error">{error}</p>{/if}
{#if notice}<p class="notice">{notice}</p>{/if}

{#if schedules === null && !error}
  <p class="muted">Loading…</p>
{:else if schedules !== null && schedules.length === 0}
  <div class="panel empty"><p class="muted">No schedules.</p></div>
{:else if schedules !== null}
  <div class="list">
    {#each schedules as s (s.name)}
      <div class="panel item">
        <div class="top">
          <span class="name">{s.name}</span>
          <span class="pill st-{stateOf(s)}">{stateOf(s)}</span>
          <span class="mono when">{s.cron ?? s.calendar}</span>
          <span class="spacer"></span>
          <button onclick={() => runNow(s.name)} disabled={s.running}>Run now</button>
        </div>
        <code class="cmd">ralph {s.args.join(" ")}</code>
        <div class="meta mono">
          <span>dir {tildify(s.dir)}</span>
          <span>next {s.nextRun === null ? "—" : ago(s.nextRun)}</span>
          <span>last {s.lastRun === null ? "—" : ago(s.lastRun)} · <span class:error={s.lastRun !== null && s.lastExitCode !== 0}>{result(s)}</span></span>
          {#if s.persistent}<span>persistent</span>{/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  h1 {
    margin: 0;
    font-size: 24px;
  }
  .lead {
    margin: 4px 0 18px;
  }
  .list {
    display: grid;
    gap: 8px;
  }
  .item {
    padding: 12px 14px;
    display: grid;
    gap: 6px;
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
  .when {
    color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .cmd {
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    color: var(--muted);
  }
  .st-enabled {
    color: var(--info);
  }
  .st-running {
    color: var(--good);
  }
  .st-paused {
    color: var(--muted);
  }
  .empty {
    padding: 28px;
    text-align: center;
  }
</style>
