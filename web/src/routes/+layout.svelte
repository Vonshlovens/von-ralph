<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { auth, setToken } from "#lib/api.svelte.js";

  let { children } = $props();
  let draft = $state("");

  const nav = [
    { href: "/", label: "Runs" },
    { href: "/schedules", label: "Schedules" },
  ];
  const active = (href: string) =>
    href === "/" ? page.url.pathname === "/" || page.url.pathname.startsWith("/runs") : page.url.pathname.startsWith(href);
</script>

<header>
  <a class="brand" href="/">
    <span class="mark">r</span>
    <span>ralph</span>
  </a>
  <nav>
    {#each nav as n (n.href)}
      <a href={n.href} class:active={active(n.href)}>{n.label}</a>
    {/each}
  </nav>
</header>

{#if auth.needed}
  <form
    class="token panel"
    onsubmit={(e) => {
      e.preventDefault();
      setToken(draft.trim());
      location.reload();
    }}
  >
    <strong>This server needs a token.</strong>
    <span class="muted">Use the value of <code>RALPH_SERVE_TOKEN</code> (kept in this browser only).</span>
    <div class="row">
      <input type="password" bind:value={draft} placeholder="token" autocomplete="off" />
      <button class="primary" type="submit">Save</button>
    </div>
  </form>
{/if}

<main>
  {@render children()}
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    position: sticky;
    top: 0;
    z-index: 5;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    font-family: var(--mono);
    font-weight: 700;
    font-size: 15px;
    letter-spacing: 0.02em;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--ink);
    color: var(--accent);
  }
  nav {
    display: flex;
    gap: 4px;
  }
  nav a {
    text-decoration: none;
    padding: 4px 10px;
    border-radius: 6px;
    color: var(--muted);
  }
  nav a:hover {
    color: var(--ink);
  }
  nav a.active {
    color: var(--ink);
    background: var(--panel-2);
  }
  main {
    max-width: 1180px;
    margin: 0 auto;
    padding: 24px;
  }
  .token {
    max-width: 520px;
    margin: 24px auto 0;
    padding: 16px;
    display: grid;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  @media (max-width: 640px) {
    header {
      padding: 10px 16px;
      gap: 16px;
    }
    main {
      padding: 16px;
    }
  }
</style>
