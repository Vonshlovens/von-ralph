<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, type RunPlan } from "#lib/api.svelte.js";
  import PlanView from "#lib/PlanView.svelte";
  import { tildify } from "#lib/format.js";

  const dir = $derived(page.url.searchParams.get("dir") ?? "");
  let draft = $state("");
  let plan = $state<RunPlan | null>(null);
  let error = $state("");

  $effect(() => {
    const projectDir = dir;
    draft = projectDir;
    plan = null;
    error = "";
    if (!projectDir) return;
    let disposed = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await api.projectPlan(projectDir);
        if (!disposed) { plan = result; error = ""; }
      } catch (e) {
        if (!disposed) error = (e as Error).message;
      } finally { fetching = false; }
    };
    void refresh();
    const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
    return () => { disposed = true; clearInterval(poll); };
  });

  function open(e: SubmitEvent) {
    e.preventDefault();
    if (draft.trim()) void goto(`/plan?${new URLSearchParams({ dir: draft.trim() })}`);
  }
</script>

<svelte:head><title>ralph · project plan</title></svelte:head>

<div class="plan-page">
  <h1>Project plan</h1>
  <p class="intro muted">Follow the implementation plan while it’s being prepared, before a loop starts.</p>
  <form onsubmit={open}>
    <label for="project-dir">Project directory</label>
    <div class="directory-input">
      <input id="project-dir" bind:value={draft} placeholder="~/repos/project" required spellcheck="false" />
      <button type="submit">Open plan</button>
    </div>
  </form>
  {#if dir}
    <div class="project-heading"><p class="mono" title={dir}>{tildify(dir)}</p><span class="muted mono">Current project state</span></div>
    <PlanView {plan} running={true} {error} />
  {:else}
    <div class="empty"><p>Open a project’s saved plan.</p><p class="muted">Enter its directory above, or use the plan link from the agent supervising your loop.</p></div>
  {/if}
</div>

<style>
  .plan-page { max-width: 900px; }
  h1 { font-size: 24px; margin: 0; }
  .intro { margin: 8px 0 24px; max-width: 70ch; }
  form { margin-bottom: 28px; }
  .directory-input { display: flex; gap: 8px; margin-top: 6px; }
  .directory-input input { min-width: 0; }
  .project-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--line); padding: 16px 0 24px; }
  .project-heading p { margin: 0; overflow-wrap: anywhere; }
  .empty { padding-top: 12px; border-top: 1px solid var(--line); }
  .empty p { margin: 12px 0 0; }
</style>
