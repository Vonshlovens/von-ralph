/**
 * Harness adapters. A harness runs ONE iteration (one fresh agent context) and
 * streams normalized events, ending with a `harness_exit` event.
 *
 * All harnesses launch interactive CLIs in Herdr Core terminals.
 */
import { Effect, type Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type HarnessEvent, HarnessFailed, type HarnessId, HarnessUnavailable } from "./domain.ts";
import { runHc } from "./hc.ts";

export interface IterationInput {
  readonly prompt: string;
  /** null = omit the model flag; the CLI uses its configured default */
  readonly model: string | null;
  readonly effort: string | null;
  readonly dir: string;
  /** Display name for this iteration's session (e.g. `<instance>-3`). */
  readonly sessionName: string;
  /** Called with every raw line the harness produced (persisted by the loop). */
  readonly onRaw: (line: string) => Effect.Effect<void>;
}

export type HarnessStream = Stream.Stream<
  HarnessEvent,
  HarnessFailed,
  ChildProcessSpawner.ChildProcessSpawner
>;

export interface Harness {
  readonly id: HarnessId;
  readonly binary: string;
  readonly installHint: string;
  readonly defaultModel: string | null;
  readonly defaultEffort: string | null;
  readonly run: (input: IterationInput) => HarnessStream;
}

/** Fail with HarnessUnavailable unless `binary` resolves on PATH. */
export const checkBinary = (h: Harness, needsHc = true) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const binary of needsHc ? ["hc", h.binary] : [h.binary]) {
      const code = yield* spawner
        .exitCode(
          ChildProcess.make("sh", ["-c", 'command -v "$1" >/dev/null', "sh", binary], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.orElseSucceed(() => 127));
      if (code !== 0)
        return yield* new HarnessUnavailable({
          harness: h.id,
          binary,
          hint: binary === "hc" ? "Install Herdr Core: https://herdr.dev/core/" : h.installHint,
        });
    }
  });

export const claude: Harness = {
  id: "claude",
  binary: "claude",
  installHint: "Install Claude Code: https://code.claude.com",
  defaultModel: "opus",
  defaultEffort: null,
  run: (input) => runHc("claude", input),
};
export const codex: Harness = {
  id: "codex",
  binary: "codex",
  installHint: "npm install -g @openai/codex",
  defaultModel: null,
  defaultEffort: "xhigh",
  run: (input) => runHc("codex", input),
};
export const opencode: Harness = {
  id: "opencode",
  binary: "opencode",
  installHint: "See https://opencode.ai",
  defaultModel: "openai/gpt-6.1-terra",
  defaultEffort: "xhigh",
  run: (input) => runHc("opencode", input),
};
export const copilot: Harness = {
  id: "gh",
  binary: "copilot",
  installHint: "npm install -g @github/copilot",
  defaultModel: null,
  defaultEffort: "high",
  run: (input) => runHc("gh", input),
};
