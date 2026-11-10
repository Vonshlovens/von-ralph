<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { auth, setToken } from "#lib/api.svelte.js";
  import { onMount } from "svelte";

  let { children } = $props();
  let draft = $state("");
  let theme = $state<"auto" | "light" | "dark">("auto");
  function applyTheme(value: "auto" | "light" | "dark") {
    theme = value;
    if (value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }
  onMount(() => {
    try {
      const saved = localStorage.getItem("ralph.theme");
      if (saved === "light" || saved === "dark") applyTheme(saved);
    } catch { /* Theme preference stays in memory when storage is unavailable. */ }
  });
  function cycleTheme() {
    const value = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    applyTheme(value);
    try { localStorage.setItem("ralph.theme", value); } catch { /* Optional preference. */ }
  }

  const nav = [
    { href: "/", label: "Runs" },
    { href: "/plan", label: "Plan" },
    { href: "/schedules", label: "Schedules" },
  ];
  const active = (href: string) =>
    href === "/" ? page.url.pathname === "/" || page.url.pathname.startsWith("/runs") : page.url.pathname.startsWith(href);
</script>

<a class="skip-link" href="#main">Skip to content</a>
<header>
  <a class="brand" href="/">
    <span class="mark">r</span>
    <span>ralph</span>
  </a>
  <nav aria-label="Main navigation">
    {#each nav as n (n.href)}
      <a href={n.href} class:active={active(n.href)} aria-current={active(n.href) ? "page" : undefined}>{n.label}</a>
    {/each}
  </nav>
  <button class="theme mono" onclick={cycleTheme} aria-label={`Theme: ${theme}. Switch to ${theme === "auto" ? "light" : theme === "light" ? "dark" : "auto"}.`}>[{theme}]</button>
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

<main id="main" tabindex="-1">
  {@render children()}
</main>

<style>
  .skip-link { position: fixed; top: -80px; left: 16px; padding: 10px 16px; background: var(--ink); color: var(--bg); z-index: 20; }
  .skip-link:focus { top: 8px; }
  header {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 12px 24px;
    border-bottom: var(--rule-w) solid var(--rule);
    background: var(--bg);
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
    border-radius: 0;
    background: var(--mark-fill);
    color: var(--on-mark);
  }
  nav {
    display: flex;
    gap: 4px;
  }
  nav a {
    text-decoration: none;
    padding: 4px 10px;
    border-radius: 0;
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
    max-width: 1320px;
    margin: 0 auto;
    padding: 24px;
  }
  .theme { margin-left: auto; background: transparent; border: 0; color: var(--muted); padding: 6px 8px; }
  .theme:hover { color: var(--ink); }
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
      flex-wrap: wrap;
    }
    nav { order: 3; width: 100%; }
    main {
      padding: 16px;
    }
  }
</style>
