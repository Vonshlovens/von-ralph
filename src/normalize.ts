/**
 * Per-harness parsers: one native JSON event in, zero or more HarnessEvents out.
 *
 * Parsers are pure apart from small per-iteration state (dedup of usage and
 * session ids), so each iteration gets a fresh parser from `makeParser`.
 * Unknown shapes produce nothing; the raw line is persisted by the caller.
 */
import {
  type ErrorKind,
  type HarnessEvent,
  type HarnessId,
  classifyError,
  clip,
} from "./domain.ts";

export type Parser = (json: unknown) => ReadonlyArray<HarnessEvent>;

const TOOL_INPUT_MAX = 300;
const TOOL_OUTPUT_MAX = 400;

type J = Record<string, unknown>;
const isObj = (u: unknown): u is J => typeof u === "object" && u !== null && !Array.isArray(u);
const str = (u: unknown): string =>
  typeof u === "string" ? u : u === undefined || u === null ? "" : JSON.stringify(u);
const num = (u: unknown): number | undefined =>
  typeof u === "number" && Number.isFinite(u) ? u : undefined;
const get = (o: unknown, ...path: ReadonlyArray<string>): unknown => {
  let cur: unknown = o;
  for (const k of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
};

const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (isObj(c) && typeof c.text === "string" ? c.text : str(c)))
      .join("\n");
  return str(content);
};

/** Claude Code `error` field on synthetic API-error messages. */
const claudeErrorKind = (code: unknown, text: string): ErrorKind => {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "auth";
    case "rate_limit":
    case "rate_limited":
      return "rate_limit";
    default:
      return classifyError(text);
  }
};

/**
 * Claude Code session transcript (`~/.claude/projects/…/<id>.jsonl`), tailed
 * while an interactive session runs. `assistant`/`user` entries carry an
 * Anthropic `message`; the format is internal to Claude Code, so unknown
 * entries are ignored (they stay in the raw file).
 */
export const claudeParser = (): Parser => {
  const seenUsage = new Set<string>();
  let session: string | undefined;
  return (e) => {
    if (!isObj(e)) return [];
    const out: Array<HarnessEvent> = [];
    const sid =
      typeof e.session_id === "string"
        ? e.session_id
        : typeof e.sessionId === "string"
          ? e.sessionId
          : undefined;
    if (sid !== undefined && session === undefined) {
      session = sid;
      out.push({ type: "session", sessionId: sid });
    }
    switch (e.type) {
      case "assistant": {
        const content = get(e, "message", "content");
        if (e.isApiErrorMessage === true) {
          const text = Array.isArray(content)
            ? content.map((c) => str(get(c, "text"))).join(" ")
            : str(content);
          out.push({
            type: "error",
            kind: claudeErrorKind(e.error, text),
            message: text || str(e.error),
          });
          return out;
        }
        if (Array.isArray(content)) {
          for (const c of content) {
            if (!isObj(c)) continue;
            if (c.type === "text" && typeof c.text === "string" && c.text.trim() !== "")
              out.push({ type: "assistant", text: c.text });
            else if (
              c.type === "thinking" &&
              typeof c.thinking === "string" &&
              c.thinking.trim() !== ""
            )
              out.push({ type: "thinking", text: c.thinking });
            else if (c.type === "tool_use")
              out.push({
                type: "tool_call",
                name: str(c.name),
                input: clip(str(c.input), TOOL_INPUT_MAX),
              });
          }
        }
        // Transcripts repeat one API message per content block; count usage once per message id.
        const id = str(get(e, "message", "id"));
        const usage = get(e, "message", "usage");
        if (isObj(usage) && id !== "" && !seenUsage.has(id)) {
          seenUsage.add(id);
          out.push({
            type: "usage",
            inputTokens:
              (num(usage.input_tokens) ?? 0) +
              (num(usage.cache_read_input_tokens) ?? 0) +
              (num(usage.cache_creation_input_tokens) ?? 0),
            outputTokens: num(usage.output_tokens),
          });
        }
        return out;
      }
      case "user": {
        const content = get(e, "message", "content");
        if (Array.isArray(content)) {
          for (const c of content) {
            if (isObj(c) && c.type === "tool_result") {
              out.push({
                type: "tool_result",
                output: clip(toolResultText(c.content), TOOL_OUTPUT_MAX),
                isError: c.is_error === true,
              });
            }
          }
        }
        return out;
      }
      case "system":
        if (e.subtype === "turn_duration")
          out.push({ type: "turn_end", durationMs: num(e.durationMs) });
        return out;
      case "cost-state": {
        const cost = num(e.totalCostUSD);
        if (cost !== undefined) out.push({ type: "usage", totalCostUsd: cost });
        return out;
      }
      default:
        return out;
    }
  };
};

/** OpenAI Codex `codex exec --json`. */
export const codexParser = (): Parser => (e) => {
  if (!isObj(e)) return [];
  switch (e.type) {
    case "thread.started":
      return typeof e.thread_id === "string" ? [{ type: "session", sessionId: e.thread_id }] : [];
    case "item.completed": {
      const i = e.item;
      if (!isObj(i)) return [];
      switch (i.type) {
        case "agent_message":
          return [{ type: "assistant", text: str(i.text) }];
        case "reasoning":
          return str(i.text) === "" ? [] : [{ type: "thinking", text: str(i.text) }];
        case "command_execution":
          return [
            { type: "tool_call", name: "shell", input: clip(str(i.command), TOOL_INPUT_MAX) },
            {
              type: "tool_result",
              output: clip(
                `[exit ${str(i.exit_code) || "?"}] ${str(i.aggregated_output)}`,
                TOOL_OUTPUT_MAX,
              ),
              isError: num(i.exit_code) !== undefined && i.exit_code !== 0,
            },
          ];
        case "file_change": {
          const changes = Array.isArray(i.changes) ? i.changes : [];
          return [
            {
              type: "tool_call",
              name: "file_change",
              input: changes.map((c) => `${str(get(c, "kind"))} ${str(get(c, "path"))}`).join(", "),
            },
          ];
        }
        case "mcp_tool_call":
          return [
            {
              type: "tool_call",
              name: `${str(i.server)}.${str(i.tool)}`,
              input: clip(str(i.arguments), TOOL_INPUT_MAX),
            },
          ];
        default:
          return [];
      }
    }
    case "turn.completed": {
      const u = e.usage;
      return [
        {
          type: "usage",
          inputTokens: num(get(u, "input_tokens")),
          outputTokens: num(get(u, "output_tokens")),
        },
        { type: "turn_end" },
      ];
    }
    case "turn.failed": {
      const msg = str(get(e, "error", "message"));
      return [{ type: "error", kind: classifyError(msg), message: msg }];
    }
    case "error": {
      const msg = str(e.message);
      return [{ type: "error", kind: classifyError(msg), message: msg }];
    }
    default:
      return [];
  }
};

/** sst/opencode `opencode run --format json`. */
export const opencodeParser = (): Parser => {
  let session: string | undefined;
  return (e) => {
    if (!isObj(e)) return [];
    const out: Array<HarnessEvent> = [];
    const sid = str(e.sessionID) || str(get(e, "part", "sessionID"));
    if (sid !== "" && session === undefined) {
      session = sid;
      out.push({ type: "session", sessionId: sid });
    }
    const p = e.part;
    switch (e.type) {
      case "text": {
        const text = str(get(p, "text")) || str(e.text);
        if (text.trim() !== "") out.push({ type: "assistant", text });
        break;
      }
      case "reasoning": {
        const text = str(get(p, "text"));
        if (text.trim() !== "") out.push({ type: "thinking", text });
        break;
      }
      case "tool_use":
        if (get(p, "state", "status") === "completed" || get(p, "state", "status") === "error") {
          out.push({
            type: "tool_call",
            name: str(get(p, "tool")) || "?",
            input: clip(str(get(p, "state", "input")), TOOL_INPUT_MAX),
          });
          out.push({
            type: "tool_result",
            output: clip(
              str(get(p, "state", "output")) || str(get(p, "state", "error")),
              TOOL_OUTPUT_MAX,
            ),
            isError: get(p, "state", "status") === "error",
          });
        }
        break;
      case "step_finish":
        out.push({
          type: "usage",
          inputTokens: num(get(p, "tokens", "input")),
          outputTokens: num(get(p, "tokens", "output")),
          costUsd: num(get(p, "cost")),
        });
        break;
      case "error": {
        const msg =
          str(get(e, "error", "data", "message")) ||
          str(get(e, "error", "message")) ||
          str(get(e, "error", "name"));
        out.push({ type: "error", kind: classifyError(msg), message: msg });
        break;
      }
    }
    return out;
  };
};

/** GitHub Copilot CLI `copilot -p --output-format json` (schema is loosely documented). */
export const copilotParser = (): Parser => {
  let session: string | undefined;
  return (e) => {
    if (!isObj(e)) return [];
    const out: Array<HarnessEvent> = [];
    const t = str(e.type) || str(e.event);
    const sid = str(get(e, "data", "sessionId")) || str(e.sessionId);
    if (sid !== "" && session === undefined) {
      session = sid;
      out.push({ type: "session", sessionId: sid });
    }
    if (t === "assistant.message") {
      const text = str(get(e, "data", "content"));
      if (text.trim() !== "") out.push({ type: "assistant", text });
      const tools = get(e, "data", "toolRequests");
      if (Array.isArray(tools)) {
        for (const tr of tools)
          out.push({
            type: "tool_call",
            name: str(get(tr, "name")),
            input: clip(str(get(tr, "arguments")), TOOL_INPUT_MAX),
          });
      }
    } else if (t === "tool.execution_complete" || t === "tool_result" || t === "tool.result") {
      const output = str(get(e, "data", "result", "content")) || str(e.output) || str(e.content);
      out.push({
        type: "tool_result",
        output: clip(output, TOOL_OUTPUT_MAX),
        isError: get(e, "data", "success") === false,
      });
    } else if (t === "result") {
      out.push({ type: "turn_end" });
    } else if (t === "error" || t === "session.error") {
      const msg = str(get(e, "data", "message")) || str(e.message) || str(e.error);
      out.push({ type: "error", kind: classifyError(msg), message: msg });
    }
    return out;
  };
};

export const makeParser = (harness: HarnessId): Parser => {
  switch (harness) {
    case "claude":
      return claudeParser();
    case "codex":
      return codexParser();
    case "opencode":
      return opencodeParser();
    case "gh":
      return copilotParser();
  }
};
