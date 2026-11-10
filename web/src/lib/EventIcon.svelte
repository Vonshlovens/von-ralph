<script lang="ts">
  import type { EventLine } from "./format.js";
  let { kind }: { kind: EventLine["kind"] } = $props();
  const paths: Record<EventLine["kind"], string> = {
    assistant: "M4 4h16v11H9l-5 5V4Z",
    tool: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 20",
    result: "M5 3h14v18H5V3Zm4 5h6m-6 4h6m-6 4h4",
    marker: "m9 5 9 7-9 7V5Z",
    good: "m5 12 5 5L20 7",
    bad: "m6 6 12 12M6 18 18 6",
    info: "M12 10v8m0-12v1M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0",
    warn: "m12 3 10 18H2L12 3Zm0 6v5m0 3v1",
  };
</script>

<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>
