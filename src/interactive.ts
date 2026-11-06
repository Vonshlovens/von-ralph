/** Native interactive-session events, independent of terminal rendering. */
import type { HarnessEvent, HarnessId } from "./domain.ts";
import { classifyError } from "./domain.ts";
import { claudeParser, copilotParser, opencodeParser, type Parser } from "./normalize.ts";

export const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" ? (value as Record<string, any>) : {};

/**
 * @cc [owner:ghuntley,label:product] interactive-completion
 * A tool step, startup idle, or silence MUST NOT finish an iteration. Only a
 * native root-turn completion may emit turn_end; terminal death is handled by hc.
 */
export function interactiveParser(id: HarnessId): Parser {
  if (id === "claude") return claudeParser();
  if (id === "gh") {
    const parse = copilotParser();
    let finalMessage = false;
    return (raw) => {
      const e = object(raw);
      const events = [...parse(e)];
      if (e.type === "assistant.turn_start") finalMessage = false;
      if (e.type === "assistant.message") finalMessage = !e.data?.toolRequests?.length;
      if (e.type === "assistant.turn_end" && finalMessage) events.push({ type: "turn_end" });
      if (e.type === "permission.requested")
        events.push({ type: "needs_input", reason: "Copilot requests permission" });
      return events;
    };
  }
  if (id === "opencode") {
    const parse = opencodeParser();
    const emitted = new Set<string>();
    let root: string | undefined;
    return (raw) => {
      const e = object(raw);
      const p = e.properties ?? {};
      if (e.type === "ralph.session") {
        root = p.sessionID;
        return [{ type: "session", sessionId: p.sessionID }];
      }
      if (!root || (p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID) !== root) return [];
      if (e.type === "session.idle") return [{ type: "turn_end" }];
      if (e.type === "session.error") return parse({ type: "error", error: p.error });
      if (e.type === "permission.asked" || e.type === "question.asked")
        return [{ type: "needs_input", reason: `OpenCode ${e.type}` }];
      if (e.type !== "message.part.updated") return [];
      const part = p.part ?? {};
      const type =
        part.type === "tool" ? "tool_use" : part.type === "step-finish" ? "step_finish" : part.type;
      // Updated parts include streaming snapshots. Only emit their final form once.
      if ((type === "text" || type === "reasoning") && !part.time?.end) return [];
      if (type === "tool_use" && !["completed", "error"].includes(part.state?.status)) return [];
      if (emitted.has(part.id)) return [];
      emitted.add(part.id);
      return parse({ type, part, sessionID: part.sessionID });
    };
  }
  let input = 0;
  let output = 0;
  return (raw) => {
    const e = object(raw);
    const p = e.payload ?? {};
    if (e.type === "session_meta") return [{ type: "session", sessionId: p.id }];
    if (e.type === "response_item") {
      if (p.type === "message" && p.role === "assistant") {
        const text = (p.content ?? []).map((x: any) => x.text ?? "").join("");
        return text ? [{ type: "assistant", text }] : [];
      }
      if (p.type === "function_call" || p.type === "custom_tool_call") {
        const events: HarnessEvent[] = [
          { type: "tool_call", name: p.name, input: p.arguments ?? p.input ?? "" },
        ];
        if (p.name === "request_user_input")
          events.push({ type: "needs_input", reason: "Codex requests user input" });
        return events;
      }
      if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
        return [
          {
            type: "tool_result",
            output: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
            isError: false,
          },
        ];
    }
    if (e.type !== "event_msg") return [];
    if (p.type === "task_complete" || p.type === "turn_complete") return [{ type: "turn_end" }];
    if (p.type === "turn_aborted")
      return [{ type: "harness_exit", status: "stopped", detail: "Codex turn aborted" }];
    if (p.type === "error")
      return [
        {
          type: "error",
          kind: classifyError(p.message ?? ""),
          message: p.message ?? "Codex error",
        },
      ];
    if (p.type === "token_count" && p.info?.total_token_usage) {
      const total = p.info.total_token_usage;
      const nextInput = total.input_tokens ?? 0;
      const nextOutput = total.output_tokens ?? 0;
      const event: HarnessEvent = {
        type: "usage",
        inputTokens: Math.max(0, nextInput - input),
        outputTokens: Math.max(0, nextOutput - output),
      };
      input = nextInput;
      output = nextOutput;
      return [event];
    }
    return [];
  };
}
