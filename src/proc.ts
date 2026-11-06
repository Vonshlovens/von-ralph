/**
 * Run a short-lived command and capture its output (git, bd, validate commands).
 * Never fails: spawn errors become exit code -1 with the message on stderr, and
 * a timeout kills the process and reports `exitCode: null`.
 */
import { Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface Captured {
  /** null = timed out (the process was killed) */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CaptureOptions {
  readonly cwd: string;
  /** 0 / undefined = no timeout */
  readonly timeoutMs?: number | undefined;
  /** Keep at most this many trailing characters of each stream (default 1 MB). */
  readonly maxChars?: number | undefined;
  /** Merge stderr into stdout (in arrival order), e.g. for validate output. */
  readonly combine?: boolean | undefined;
}

const keepTail = (max: number) => (acc: string, chunk: string) => {
  const s = acc + chunk;
  return s.length > max ? s.slice(s.length - max) : s;
};

export const capture = (
  command: string,
  args: ReadonlyArray<string>,
  options: CaptureOptions,
): Effect.Effect<Captured, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const t0 = Date.now();
  const max = options.maxChars ?? 1_000_000;
  const collect = <E>(s: Stream.Stream<Uint8Array, E>) =>
    s.pipe(
      Stream.decodeText(),
      Stream.runFold(() => "", keepTail(max)),
    );
  const run = Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd: options.cwd,
          stdin: "ignore",
          forceKillAfter: "5 seconds",
        }),
      );
      if (options.combine === true) {
        const [out, code] = yield* Effect.all([collect(handle.all), handle.exitCode], {
          concurrency: "unbounded",
        });
        return { exitCode: code as number, stdout: out, stderr: "" };
      }
      const [stdout, stderr, code] = yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode: code as number, stdout, stderr };
    }),
  );
  const bounded =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? run.pipe(
          Effect.timeoutOption(Duration.millis(options.timeoutMs)),
          Effect.map(Option.getOrElse(() => ({ exitCode: null, stdout: "", stderr: "timed out" }))),
        )
      : run;
  return bounded.pipe(
    Effect.catch((e) => Effect.succeed({ exitCode: -1, stdout: "", stderr: String(e) })),
    Effect.map((r) => ({ ...r, durationMs: Date.now() - t0 })),
  );
};

/** `sh -c <script>` in `cwd`. */
export const shell = (script: string, options: CaptureOptions) =>
  capture("sh", ["-c", script], options);
