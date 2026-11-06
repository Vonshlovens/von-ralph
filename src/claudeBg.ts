/**
 * `claude` harness: each iteration is a real Claude Code background session
 * (`claude --bg`), not `claude -p`.
 *
 * Verified on Claude Code 2.1.318 (2026-11-06):
 * - `--bg` prints `backgrounded · <short-id> · <name>` and ignores `--session-id`.
 * - `claude agents --json --all` lists sessions with
 *   `{id, sessionId, cwd, kind, name, state, status?}` and
 *   `state ∈ working | blocked | done | failed | stopped`.
 * - The transcript is `~/.claude/projects/<slug>/<sessionId>.jsonl` (internal
 *   format; parsed best-effort by `claudeParser`, kept raw).
 *
 * Each iteration gets a fresh session (fresh context, the Ralph rule). The
 * session is stopped when the iteration ends or is interrupted; its
 * conversation is kept, so `claude attach <id>` / `claude --resume <sessionId>`
 * still work for inspection.
 */
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type HarnessEvent, HarnessFailed } from "./domain.ts";
import type { Harness, IterationInput } from "./harness.ts";
import { claudeParser } from "./normalize.ts";

const POLL = "2 seconds";
/** How many polls a just-launched session may be missing from `claude agents`. */
const MAX_MISSING_POLLS = 15;

const AgentEntry = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
const AgentList = Schema.Array(Schema.Unknown);

const fail = (reason: string) => new HarnessFailed({ harness: "claude", reason });

/** Parse the short id from `claude --bg` output. */
export const parseBackgroundedId = (output: string): string | undefined =>
  /backgrounded\s*·\s*([0-9a-f]{6,})\b/i.exec(output)?.[1];

/** `--settings` JSON: Ralph owns worktree policy, so Claude's bg isolation is off. */
export const bgSettings = JSON.stringify({ worktree: { bgIsolation: "none" } });

export const launchArgs = (
  i: Pick<IterationInput, "prompt" | "model" | "effort" | "sessionName">,
): ReadonlyArray<string> => [
  "--bg",
  "-n",
  i.sessionName,
  ...(i.model === null ? [] : ["--model", i.model]),
  ...(i.effort === null ? [] : ["--effort", i.effort]),
  "--permission-mode",
  "bypassPermissions",
  "--settings",
  bgSettings,
  i.prompt,
];

const run = (cmd: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(cmd, { includeStderr: true });
  });

const findAgent = (shortId: string) =>
  run(ChildProcess.make("claude", ["agents", "--json", "--all"], { stdin: "ignore" })).pipe(
    Effect.mapError((e) => fail(`claude agents: ${e.message}`)),
    Effect.flatMap((out) =>
      Effect.try({
        try: () => JSON.parse(out) as unknown,
        catch: () => fail(`claude agents: unparseable output: ${out.slice(0, 200)}`),
      }),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(AgentList)),
    Effect.mapError((e) => (e instanceof HarnessFailed ? e : fail(`claude agents: ${String(e)}`))),
    Effect.map((list) => {
      for (const raw of list) {
        const decoded = Schema.decodeUnknownOption(AgentEntry)(raw);
        if (
          Option.isSome(decoded) &&
          (decoded.value.id === shortId || decoded.value.sessionId.startsWith(shortId))
        )
          return decoded.value;
      }
      return undefined;
    }),
  );

const stopSession = (shortId: string) =>
  run(ChildProcess.make("claude", ["stop", shortId], { stdin: "ignore" })).pipe(Effect.ignore);

const projectsDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");

const locateTranscript = (sessionId: string) =>
  Effect.tryPromise(async () => {
    const root = projectsDir();
    for (const d of await fs.readdir(root)) {
      const p = path.join(root, d, `${sessionId}.jsonl`);
      try {
        await fs.access(p);
        return p;
      } catch {
        // keep looking
      }
    }
    return undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Read complete lines appended since `offset`; returns new offset (excludes a trailing partial line). */
export const readNewLines = (file: string, offset: number) =>
  Effect.tryPromise(async () => {
    const fh = await fs.open(file, "r");
    try {
      const { size } = await fh.stat();
      if (size <= offset) return { lines: [] as Array<string>, offset };
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) return { lines: [] as Array<string>, offset };
      const complete = text.slice(0, lastNl);
      return {
        lines: complete.split("\n"),
        offset: offset + Buffer.byteLength(complete, "utf8") + 1,
      };
    } finally {
      await fh.close();
    }
  }).pipe(Effect.mapError((e) => fail(`read transcript: ${String(e)}`)));

type PollState = {
  readonly first: boolean;
  readonly sessionId: string | undefined;
  readonly transcript: string | undefined;
  readonly offset: number;
  readonly missing: number;
};

const TERMINAL: Record<string, "ok" | "failed" | "blocked" | "stopped"> = {
  done: "ok",
  failed: "failed",
  blocked: "blocked",
  stopped: "stopped",
};

export const claudeBg: Harness = {
  id: "claude",
  binary: "claude",
  installHint: "Install Claude Code: https://code.claude.com",
  defaultModel: "opus",
  defaultEffort: null,
  run: (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const out = yield* run(
          ChildProcess.make("claude", launchArgs(input), { cwd: input.dir, stdin: "ignore" }),
        ).pipe(Effect.mapError((e) => fail(`launch: ${e.message}`)));
        yield* input.onRaw(JSON.stringify({ ralph: "claude-bg-launch", output: out.trim() }));
        const shortId = parseBackgroundedId(out);
        if (shortId === undefined)
          return yield* fail(
            `could not parse session id from 'claude --bg' output: ${out.trim().slice(0, 300)}`,
          );
        // Always stop the session when this iteration ends (done, error, or interrupt).
        yield* Effect.addFinalizer(() => stopSession(shortId));

        const parse = claudeParser();
        const drain = (st: PollState) =>
          st.transcript === undefined
            ? Effect.succeed({ events: [] as Array<HarnessEvent>, offset: st.offset })
            : readNewLines(st.transcript, st.offset).pipe(
                Effect.flatMap(({ lines, offset }) =>
                  Effect.gen(function* () {
                    const events: Array<HarnessEvent> = [];
                    for (const line of lines) {
                      if (line.trim() === "") continue;
                      yield* input.onRaw(line);
                      try {
                        // The adapter already emitted the session (with its attach id).
                        events.push(
                          ...parse(JSON.parse(line)).filter((ev) => ev.type !== "session"),
                        );
                      } catch {
                        // partial/garbled line: raw only
                      }
                    }
                    return { events, offset };
                  }),
                ),
              );

        const initial: PollState = {
          first: true,
          sessionId: undefined,
          transcript: undefined,
          offset: 0,
          missing: 0,
        };
        return Stream.paginate(initial, (st) =>
          Effect.gen(function* () {
            if (!st.first) yield* Effect.sleep(POLL);
            const agent = yield* findAgent(shortId);
            if (agent === undefined) {
              if (st.missing + 1 >= MAX_MISSING_POLLS)
                return yield* fail(`session ${shortId} disappeared from 'claude agents'`);
              return [[], Option.some({ ...st, first: false, missing: st.missing + 1 })] as const;
            }
            const pre: Array<HarnessEvent> = [];
            const sessionId = agent.sessionId;
            if (st.sessionId === undefined)
              pre.push({ type: "session", sessionId, attachId: shortId });
            const transcript = st.transcript ?? (yield* locateTranscript(sessionId));
            const terminal = agent.state === undefined ? undefined : TERMINAL[agent.state];
            if (terminal !== undefined) yield* Effect.sleep("500 millis"); // let the transcript flush
            const { events, offset } = yield* drain({ ...st, transcript });
            const next: PollState = { first: false, sessionId, transcript, offset, missing: 0 };
            if (terminal === undefined) return [[...pre, ...events], Option.some(next)] as const;
            const tail: Array<HarnessEvent> =
              terminal === "blocked"
                ? [
                    {
                      type: "needs_input",
                      reason: `claude session ${shortId} is blocked (claude attach ${shortId})`,
                    },
                    { type: "harness_exit", status: "blocked" },
                  ]
                : [
                    {
                      type: "harness_exit",
                      status: terminal,
                      detail: `claude session ${shortId} ${agent.state}`,
                    },
                  ];
            return [[...pre, ...events, ...tail], Option.none()] as const;
          }),
        );
      }),
    ),
};
