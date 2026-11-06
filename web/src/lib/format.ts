/** Display helpers shared by the pages. */
import type { RalphEvent, Run } from "./api.svelte.js";

export const basename = (p: string) => p.replace(/\/+$/, "").split("/").at(-1) ?? p;

export const tildify = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

export function ago(iso: string | null, now = Date.now()): string {
  if (iso === null) return "—";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const v =
    a < 60
      ? `${a}s`
      : a < 3600
        ? `${Math.round(a / 60)}m`
        : a < 86400
          ? `${Math.round(a / 3600)}h`
          : `${Math.round(a / 86400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}

export const duration = (ms: number) =>
  ms < 90_000
    ? `${Math.round(ms / 1000)}s`
    : ms < 5_400_000
      ? `${Math.round(ms / 60_000)}m`
      : `${(ms / 3_600_000).toFixed(1)}h`;

export const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

/** One word for a run's state, with dead runners called out. */
export function stateOf(r: Pick<Run, "status" | "alive">): "running" | "dead" | Run["status"] {
  if (r.status === "running") return r.alive ? "running" : "dead";
  return r.status;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export interface EventLine {
  kind: "assistant" | "tool" | "result" | "marker" | "good" | "bad" | "info" | "warn";
  icon: string;
  text: string;
}

/** The same vocabulary as the CLI log (src/store.ts formatLogLine). */
export function describe(e: RalphEvent): EventLine | null {
  const f = e as Record<string, unknown>;
  switch (e.type) {
    case "run_started":
      return {
        kind: "marker",
        icon: "🚀",
        text: `started · ${f.mode} · ${f.harness}${f.model ? `/${f.model}` : ""} · max ${f.maxIterations || "∞"}`,
      };
    case "iteration_started":
      return { kind: "marker", icon: "▸", text: `iteration ${e.iteration}` };
    case "session":
      return { kind: "info", icon: "🧵", text: `session ${f.sessionId}` };
    case "assistant":
      return { kind: "assistant", icon: "💬", text: String(f.text ?? "") };
    case "tool_call":
      return { kind: "tool", icon: "🔧", text: `${f.name}: ${clip(f.input, 240)}` };
    case "tool_result":
      return {
        kind: f.isError ? "bad" : "result",
        icon: "📋",
        text: clip(f.output, 300),
      };
    case "error":
      return { kind: "bad", icon: "⚠️", text: `${f.kind}: ${clip(f.message, 400)}` };
    case "needs_input":
      return { kind: "warn", icon: "✋", text: `needs input: ${f.reason}` };
    case "harness_exit":
      return f.status === "ok"
        ? null
        : {
            kind: "warn",
            icon: "⚠️",
            text: `harness ${f.status}${f.detail ? `: ${f.detail}` : ""}`,
          };
    case "steer_received":
      return { kind: "info", icon: "🧭", text: `steer: ${clip(f.text, 300)}` };
    case "iteration_finished":
      return {
        kind: f.outcome === "completed" ? "marker" : "warn",
        icon: "■",
        text: `iteration ${e.iteration} ${f.outcome} · ${duration(Number(f.durationMs ?? 0))}`,
      };
    case "validate":
      return f.ok
        ? { kind: "good", icon: "✅", text: "validate passed" }
        : { kind: "bad", icon: "❌", text: "validate failed" };
    case "plan_status":
      return f.error
        ? { kind: "warn", icon: "🗺️", text: `plan: ${clip(f.error, 200)}` }
        : {
            kind: "info",
            icon: "🗺️",
            text: `plan: ${f.open} open · ${f.actionable} ready · ${f.total} total${f.changed ? " (changed)" : ""}`,
          };
    case "scope_violation":
      return {
        kind: "bad",
        icon: "🚧",
        text: `out-of-scope changes: ${clip((f.files as string[] | undefined)?.join(", "), 300)}`,
      };
    case "notice":
      return { kind: "info", icon: "ℹ️", text: String(f.text ?? "") };
    case "rate_limit_sleep":
      return {
        kind: "warn",
        icon: "⏳",
        text: `rate limited, sleeping ${Math.round(Number(f.seconds) / 60)}m`,
      };
    case "run_finished":
      return { kind: "marker", icon: "🛑", text: `finished after ${f.iterations} · ${f.reason}` };
    default:
      return null;
  }
}
