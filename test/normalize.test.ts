import { describe, expect, it } from "@effect/vitest";
import { parseBackgroundedId, launchArgs } from "../src/claudeBg.ts";
import { classifyError } from "../src/domain.ts";
import { outcomeOf } from "../src/loop.ts";
import { claudeParser, codexParser, copilotParser, opencodeParser } from "../src/normalize.ts";

describe("claude transcript / stream-json", () => {
  it("maps assistant blocks, tools, results, and turn end", () => {
    const p = claudeParser();
    const msg = {
      id: "msg_1",
      usage: { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 7 },
    };
    expect(
      p({
        type: "assistant",
        sessionId: "s-1",
        message: { ...msg, content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([
      { type: "session", sessionId: "s-1" },
      { type: "assistant", text: "hi" },
      { type: "usage", inputTokens: 102, outputTokens: 7 },
    ]);
    // Same API message, next content block: usage must not be counted twice.
    expect(
      p({
        type: "assistant",
        sessionId: "s-1",
        message: {
          ...msg,
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      }),
    ).toEqual([{ type: "tool_call", name: "Bash", input: '{"command":"ls"}' }]);
    expect(
      p({
        type: "user",
        message: { content: [{ type: "tool_result", content: "a.txt", is_error: false }] },
      }),
    ).toEqual([{ type: "tool_result", output: "a.txt", isError: false }]);
    expect(p({ type: "system", subtype: "turn_duration", durationMs: 1234 })).toEqual([
      { type: "turn_end", durationMs: 1234 },
    ]);
    expect(p({ type: "cost-state", totalCostUSD: 0.5 })).toEqual([
      { type: "usage", totalCostUsd: 0.5 },
    ]);
  });

  it("classifies the synthetic API error message seen on a blocked bg session", () => {
    // Shape observed 2026-11-06 in a real background-session transcript.
    const events = claudeParser()({
      type: "assistant",
      isApiErrorMessage: true,
      error: "authentication_failed",
      apiErrorStatus: 403,
      message: {
        model: "<synthetic>",
        content: [
          {
            type: "text",
            text: "Please run /login · API Error: 403 this endpoint only accepts official Claude Code clients",
          },
        ],
      },
    });
    expect(events).toEqual([
      {
        type: "error",
        kind: "auth",
        message:
          "Please run /login · API Error: 403 this endpoint only accepts official Claude Code clients",
      },
    ]);
  });

  it("handles the claude -p result event", () => {
    expect(
      claudeParser()({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.12,
        duration_ms: 900,
      }),
    ).toEqual([
      { type: "usage", totalCostUsd: 0.12 },
      { type: "turn_end", durationMs: 900 },
    ]);
  });
});

describe("codex", () => {
  it("maps thread, commands, messages, usage", () => {
    const p = codexParser();
    expect(p({ type: "thread.started", thread_id: "t-9" })).toEqual([
      { type: "session", sessionId: "t-9" },
    ]);
    expect(
      p({
        type: "item.completed",
        item: { type: "command_execution", command: "ls", exit_code: 1, aggregated_output: "nope" },
      }),
    ).toEqual([
      { type: "tool_call", name: "shell", input: "ls" },
      { type: "tool_result", output: "[exit 1] nope", isError: true },
    ]);
    expect(p({ type: "item.completed", item: { type: "agent_message", text: "done" } })).toEqual([
      { type: "assistant", text: "done" },
    ]);
    expect(p({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } })).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 3 },
      { type: "turn_end" },
    ]);
    expect(p({ type: "turn.failed", error: { message: "429 Too Many Requests" } })).toEqual([
      { type: "error", kind: "rate_limit", message: "429 Too Many Requests" },
    ]);
  });
});

describe("opencode", () => {
  it("maps text, completed tools, step usage", () => {
    const p = opencodeParser();
    expect(p({ type: "text", sessionID: "ses_1", part: { text: "ok" } })).toEqual([
      { type: "session", sessionId: "ses_1" },
      { type: "assistant", text: "ok" },
    ]);
    expect(p({ type: "tool_use", part: { tool: "bash", state: { status: "running" } } })).toEqual(
      [],
    );
    expect(
      p({
        type: "tool_use",
        part: { tool: "bash", state: { status: "completed", input: { c: 1 }, output: "out" } },
      }),
    ).toEqual([
      { type: "tool_call", name: "bash", input: '{"c":1}' },
      { type: "tool_result", output: "out", isError: false },
    ]);
    expect(
      p({ type: "step_finish", part: { tokens: { input: 5, output: 6 }, cost: 0.01 } }),
    ).toEqual([{ type: "usage", inputTokens: 5, outputTokens: 6, costUsd: 0.01 }]);
  });
});

describe("copilot", () => {
  it("maps assistant messages and result", () => {
    const p = copilotParser();
    expect(p({ type: "assistant.message", data: { content: "hey" } })).toEqual([
      { type: "assistant", text: "hey" },
    ]);
    expect(p({ type: "assistant.message_delta", data: { deltaContent: "h" } })).toEqual([]);
    expect(p({ type: "result", exitCode: 0 })).toEqual([{ type: "turn_end" }]);
  });
});

describe("claude --bg helpers", () => {
  it("parses the short id from real --bg output", () => {
    const out =
      "warning: …\nStarting background service…\nbackgrounded · 406a60fa · ralph-bgprobe\n  claude agents             list sessions\n";
    expect(parseBackgroundedId(out)).toBe("406a60fa");
    expect(parseBackgroundedId("error: not logged in")).toBeUndefined();
  });

  it("builds launch args without -p and with bg isolation disabled", () => {
    const args = launchArgs({ prompt: "do it", model: "opus", effort: "high", sessionName: "w-1" });
    expect(args).not.toContain("-p");
    expect(args.slice(0, 3)).toEqual(["--bg", "-n", "w-1"]);
    expect(args).toContain("bypassPermissions");
    expect(args.at(-1)).toBe("do it");
    expect(args[args.indexOf("--settings") + 1]).toBe('{"worktree":{"bgIsolation":"none"}}');
  });
});

describe("classification", () => {
  it("classifies common error strings", () => {
    expect(classifyError("You've hit your limit · resets 5pm")).toBe("rate_limit");
    expect(classifyError("Please run /login")).toBe("auth");
    expect(classifyError("prompt is too long: 210000 tokens")).toBe("context");
    expect(classifyError("ENOENT")).toBe("unknown");
  });

  it("derives iteration outcomes", () => {
    const base = { sawBlocked: false, errorKinds: new Set<string>(), exitStatus: "ok" as const };
    expect(outcomeOf(base)).toBe("completed");
    expect(outcomeOf({ ...base, exitStatus: "failed" })).toBe("failed");
    expect(outcomeOf({ ...base, sawBlocked: true })).toBe("blocked");
    expect(outcomeOf({ ...base, errorKinds: new Set(["auth"]), sawBlocked: true })).toBe(
      "auth_failed",
    );
    expect(outcomeOf({ ...base, errorKinds: new Set(["rate_limit"]) })).toBe("rate_limited");
  });
});
