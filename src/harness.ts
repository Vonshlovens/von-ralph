/**
 * Harness adapters. A harness runs ONE iteration (one fresh agent context) and
 * streams normalized events, ending with a `harness_exit` event.
 *
 * Process harnesses (codex, opencode, gh) spawn a CLI in its
 * non-interactive JSONL mode. The `claude` harness drives a real Claude Code
 * background session instead (see claudeBg.ts).
 */
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type HarnessEvent, HarnessFailed, type HarnessId, HarnessUnavailable } from "./domain.ts";
import { makeParser } from "./normalize.ts";

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
export const checkBinary = (h: Harness) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner
      .exitCode(
        ChildProcess.make("sh", ["-c", 'command -v "$1" >/dev/null', "sh", h.binary], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.orElseSucceed(() => 127));
    if (code !== 0)
      return yield* new HarnessUnavailable({
        harness: h.id,
        binary: h.binary,
        hint: h.installHint,
      });
  });

const STDERR_TAIL = 20;

/**
 * Spawn `binary args…` in `dir`, parse stdout as JSONL with the harness parser,
 * forward raw lines, and finish with `harness_exit` carrying the exit code.
 */
export const runJsonlProcess = (
  id: HarnessId,
  binary: string,
  args: ReadonlyArray<string>,
  input: IterationInput,
): HarnessStream =>
  Stream.unwrap(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(binary, args, {
            cwd: input.dir,
            stdin: "ignore",
            forceKillAfter: "5 seconds",
          }),
        )
        .pipe(
          Effect.mapError(
            (e) => new HarnessFailed({ harness: id, reason: `spawn failed: ${e.message}` }),
          ),
        );
      const parse = makeParser(id);
      const stderrTail: Array<string> = [];

      const stderr = handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            stderrTail.push(line);
            if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
          }),
        ),
        Effect.ignore,
      );
      yield* Effect.forkScoped(stderr);

      const events = handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            if (line.trim() === "") return [] as ReadonlyArray<HarnessEvent>;
            yield* input.onRaw(line);
            try {
              return parse(JSON.parse(line));
            } catch {
              return [] as ReadonlyArray<HarnessEvent>; // non-JSON noise: kept in raw only
            }
          }),
        ),
        Stream.flattenIterable,
        Stream.mapError((e) => new HarnessFailed({ harness: id, reason: `stdout: ${e.message}` })),
      );

      const exit = Stream.fromEffect(
        handle.exitCode.pipe(
          Effect.map((code): HarnessEvent =>
            code === 0
              ? { type: "harness_exit", status: "ok" }
              : {
                  type: "harness_exit",
                  status: "failed",
                  detail: `exit ${code}${stderrTail.length > 0 ? `: ${stderrTail.slice(-5).join(" | ")}` : ""}`,
                },
          ),
          Effect.mapError((e) => new HarnessFailed({ harness: id, reason: `wait: ${e.message}` })),
        ),
      );
      return Stream.concat(events, exit);
    }),
  );

const modelArgs = (flag: string, value: string | null): ReadonlyArray<string> =>
  value === null ? [] : [flag, value];

const effortArgs = (flag: string, value: string | null): ReadonlyArray<string> =>
  value === null ? [] : [flag, value];

export const codex: Harness = {
  id: "codex",
  binary: "codex",
  installHint: "npm install -g @openai/codex",
  // Omit -m so codex follows ~/.codex/config.toml (gpt-6-astra as of 2026-11-06), like
  // `cody`; pinned ids go stale (gpt-5.5 was retired for ChatGPT logins).
  defaultModel: null,
  defaultEffort: "xhigh",
  run: (i) =>
    runJsonlProcess(
      "codex",
      "codex",
      [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        ...modelArgs("-m", i.model),
        ...(i.effort === null ? [] : ["-c", `model_reasoning_effort=${i.effort}`]),
        i.prompt,
      ],
      i,
    ),
};

export const opencode: Harness = {
  id: "opencode",
  binary: "opencode",
  installHint: "See https://opencode.ai",
  // Newest OpenAI model in `opencode models` as of 2026-11-06; its variants are none..xhigh.
  defaultModel: "openai/gpt-6.1-terra",
  defaultEffort: "xhigh",
  run: (i) =>
    runJsonlProcess(
      "opencode",
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--auto",
        ...modelArgs("--model", i.model),
        ...effortArgs("--variant", i.effort),
        "--title",
        i.sessionName,
        i.prompt,
      ],
      i,
    ),
};

export const copilot: Harness = {
  id: "gh",
  binary: "copilot",
  installHint: "npm install -g @github/copilot",
  // Explicit model ids go stale (claude-sonnet-4.6 was rejected 2026-11-06); let copilot choose.
  defaultModel: null,
  defaultEffort: "high",
  run: (i) =>
    runJsonlProcess(
      "gh",
      "copilot",
      [
        "-p",
        i.prompt,
        "--allow-all-tools",
        "--allow-all-paths",
        "--allow-all-urls",
        "--no-ask-user",
        "--add-dir",
        i.dir,
        ...modelArgs("--model", i.model),
        ...effortArgs("--reasoning-effort", i.effort),
        "--output-format",
        "json",
        "--no-color",
      ],
      i,
    ),
};
