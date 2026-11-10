/** Shared interactive terminal backend for every Ralph harness. */
import { Effect, Option, Stream } from "effect";
import { spawn, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { HarnessFailed, type HarnessEvent, type HarnessId } from "./domain.ts";
import type { HarnessStream, IterationInput } from "./harness.ts";
import { interactiveParser, object } from "./interactive.ts";
import { claudeConnection } from "./underclass.ts";

const exec = promisify(execFile);
const fail = (id: HarnessId, reason: string) => new HarnessFailed({ harness: id, reason });
const flag = (name: string, value: string | null) => (value === null ? [] : [name, value]);

/**
 * @cc [owner:ghuntley,label:product] interactive-launch
 * Every harness MUST launch its interactive CLI in a fresh context. Claude MUST
 * receive neither --bg nor -p; Codex MUST use --no-daemon, never exec. Credentials
 * MUST NOT be placed in command arguments.
 */
export function interactiveArgs(
  id: HarnessId,
  input: IterationInput,
  uuid: string,
  settings?: string,
): string[] {
  const marker = `Ralph iteration ${uuid}`;
  switch (id) {
    case "claude":
      return [
        "--session-id",
        uuid,
        "-n",
        input.sessionName,
        ...flag("--model", input.model),
        ...flag("--effort", input.effort),
        ...(input.tools === "none"
          ? [
              "--tools",
              "",
              "--strict-mcp-config",
              "--disable-slash-commands",
              "--permission-mode",
              "dontAsk",
            ]
          : ["--permission-mode", "bypassPermissions"]),
        "--settings",
        settings!,
        "--",
        input.prompt,
      ];
    case "codex":
      return [
        "--no-daemon",
        "--dangerously-bypass-approvals-and-sandbox",
        ...flag("-m", input.model),
        ...(input.effort === null
          ? []
          : ["-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`]),
        "--",
        `${marker}\n\n${input.prompt}`,
      ];
    case "opencode":
      return [
        "--auto",
        ...flag("--model", input.model),
        "--prompt",
        `${marker}\n\n${input.prompt}`,
      ];
    case "gh":
      return [
        "--session-id",
        uuid,
        "--name",
        input.sessionName,
        "--allow-all-tools",
        "--allow-all-paths",
        "--allow-all-urls",
        "--no-ask-user",
        "--add-dir",
        input.dir,
        ...flag("--model", input.model),
        ...flag("--reasoning-effort", input.effort),
        "-i",
        input.prompt,
      ];
  }
}

/** One plain JSON-RPC connection. Environment/credentials never enter argv or logs. */
class Rpc {
  child = spawn("hc", ["connect"], { stdio: ["pipe", "pipe", "ignore"] });
  sequence = 0;
  dead = false;
  pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
  onEvent: (value: any) => void = () => {};
  onFailure: () => void = () => {};
  constructor() {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        const request = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id);
          if (message.error)
            request.reject(new Error(`hc: ${message.error.data?.kind ?? "RPC error"}`));
          else request.resolve(message.result);
        } else if (message.method) this.onEvent(message);
      } catch {
        this.failed();
      }
    });
    this.child.on("error", () => this.failed());
    this.child.on("exit", () => this.failed());
    this.child.stdin.on("error", () => this.failed());
  }
  failed() {
    if (this.dead) return;
    this.dead = true;
    for (const request of this.pending.values()) request.reject(new Error("hc connection closed"));
    this.pending.clear();
    this.onFailure();
  }
  async call(method: string, params: object): Promise<any> {
    if (this.dead) throw new Error("hc connection closed");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hc ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close() {
    this.child.kill();
    this.failed();
  }
}

type Batch = { raw: string[]; events: HarnessEvent[]; done: boolean };

class Terminal {
  readonly uuid = randomUUID();
  readonly name: string;
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-hc-"));
  readonly eventFile = path.join(this.dir, "events.jsonl");
  readonly rpc = new Rpc();
  monitor: Rpc | undefined;
  watchers: fs.FSWatcher[] = [];
  candidates = new Set<string>();
  offsets = new Map<string, number>();
  rejected = new Set<string>();
  transcript: string | undefined;
  parse: ReturnType<typeof interactiveParser>;
  address: string | undefined;
  attachId: string | undefined;
  terminal: Record<string, any> = {};
  error: Error | undefined;
  closing = false;
  launched = false;
  pending = true;
  wake: (() => void) | undefined;
  session: string | undefined;
  readonly id: HarnessId;
  readonly input: IterationInput;
  constructor(id: HarnessId, input: IterationInput) {
    this.id = id;
    this.input = input;
    this.name = `r-${input.sessionName
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .slice(0, 16)}-${this.uuid.slice(0, 8)}`;
    this.parse = interactiveParser(id);
    this.rpc.onFailure = () => {
      if (!this.closing) {
        this.error = new Error("hc control connection closed");
        this.signal();
      }
    };
  }
  signal() {
    this.pending = true;
    this.wake?.();
  }
  watch(root: string, accepts: (file: string) => boolean, ignoreExisting = false) {
    fs.mkdirSync(root, { recursive: true });
    const existing = new Set<string>();
    for (const name of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const file = path.join(root, name);
      if (!accepts(file)) continue;
      if (ignoreExisting) existing.add(file);
      else this.candidates.add(file);
    }
    const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name) {
        this.error = new Error("session watcher lost a filename");
        this.signal();
        return;
      }
      const file = path.join(root, name);
      if (accepts(file) && !existing.has(file)) {
        this.candidates.add(file);
        this.signal();
      } else {
        // A program can create a directory and its transcript before the OS
        // installs a watch on that new directory. Rescan that subtree once.
        try {
          if (fs.statSync(file).isDirectory()) {
            for (const child of fs.readdirSync(file, { recursive: true, encoding: "utf8" })) {
              const candidate = path.join(file, child);
              if (accepts(candidate) && !existing.has(candidate)) this.candidates.add(candidate);
            }
            this.signal();
          }
        } catch {
          /* a transient directory was removed */
        }
      }
    });
    watcher.on("error", () => {
      this.error = new Error("session watcher failed");
      this.signal();
    });
    this.watchers.push(watcher);
  }
  async launch(settings?: string, overrides?: NodeJS.ProcessEnv) {
    const home = os.homedir();
    const claudeConfig =
      this.input.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
    if (this.id === "claude")
      this.watch(path.join(claudeConfig, "projects"), (file) =>
        file.endsWith(`/${this.uuid}.jsonl`),
      );
    if (this.id === "gh")
      this.watch(
        path.join(process.env.COPILOT_HOME ?? path.join(home, ".copilot"), "session-state"),
        (file) => file.endsWith(`/${this.uuid}/events.jsonl`),
      );
    if (this.id === "codex")
      this.watch(
        path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "sessions"),
        (file) => file.endsWith(".jsonl"),
        true,
      );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides ?? process.env))
      if (
        value !== undefined &&
        !key.startsWith("HC_") &&
        !["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"].includes(key)
      )
        env[key] = value;
    if (this.id === "claude") {
      env.CLAUDECODE = ""; // a separate hc terminal is not a nested Claude session
      if (this.input.claudeConfigDir !== undefined)
        env.CLAUDE_CONFIG_DIR = this.input.claudeConfigDir;
      // Markers inherited from a supervising Claude Code session (ralph started
      // from inside one). CLAUDE_CODE_CHILD_SESSION turns off transcript saving,
      // and the transcript is how ralph sees the iteration at all.
      for (const key of [
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_ENTRYPOINT",
      ])
        delete env[key];
    }
    if (this.id === "opencode") {
      fs.writeFileSync(this.eventFile, "", { mode: 0o600 });
      this.watch(this.dir, (file) => file === this.eventFile);
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
      config.plugin = [
        ...(config.plugin ?? []),
        pathToFileURL(fileURLToPath(new URL("./opencode-plugin.ts", import.meta.url))).href,
      ];
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      env.RALPH_EVENT_FILE = this.eventFile;
      env.RALPH_ITERATION_MARKER = `Ralph iteration ${this.uuid}`;
      env.RALPH_EFFORT = this.input.effort ?? "";
    }
    this.launched = true; // clean up by unique name even if launch reply is lost
    const terminal = await this.rpc.call("terminal.run", {
      name: this.name,
      cwd: this.input.dir,
      argv: [
        this.id === "gh" ? "copilot" : this.id,
        ...interactiveArgs(this.id, this.input, this.uuid, settings),
      ],
      env,
      no_parent: true,
      no_notify: true,
      wait: false,
    });
    if (typeof terminal.address !== "string")
      throw new Error("hc launch did not return an address");
    this.address = terminal.address;
    this.attachId = encodeAttach(terminal.address);
    this.terminal = terminal;
    this.monitor = new Rpc();
    this.monitor.onFailure = () => {
      if (!this.closing) {
        this.error = new Error("hc event connection closed");
        this.signal();
      }
    };
    const queued: any[] = [];
    let subscribed = false;
    const applyEvent = (message: any) => {
      const event = message.params ?? {};
      if (message.method === "missed") {
        const record = event.terminals?.find((t: any) => t.address === this.address);
        if (record) this.terminal = record;
        else this.error = new Error("hc terminal disappeared");
      } else if (message.method === "event" && event.terminal === this.address) {
        if (event.type === "removed") this.error = new Error("hc terminal removed");
        if (event.type === "lost") this.error = new Error("hc lost the terminal process");
        if (event.type === "finished")
          this.terminal = { ...this.terminal, ...event.data, state: "finished" };
        if (event.type === "status") this.terminal = { ...this.terminal, ...event.data };
      }
      this.signal();
    };
    this.monitor.onEvent = (message) => {
      if (subscribed) applyEvent(message);
      else queued.push(message);
    };
    const snapshot = await this.monitor.call("events.subscribe", { terminal: this.address });
    const current = snapshot.terminals?.find((t: any) => t.address === this.address);
    if (current) this.terminal = current;
    subscribed = true;
    for (const message of queued) applyEvent(message);
    this.signal();
  }
  read(file: string): string[] {
    try {
      const offset = this.offsets.get(file) ?? 0;
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size < offset) throw new Error("session transcript was truncated");
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        const end = buffer.lastIndexOf(10);
        if (end < 0) return [];
        this.offsets.set(file, offset + end + 1);
        return buffer.subarray(0, end).toString("utf8").split("\n");
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  /**
   * @cc [owner:ghuntley,label:product] root-session-isolation
   * Codex events MUST come only from a newly created CLI transcript in the
   * requested working directory containing this iteration's unique marker.
   * Pre-existing sessions, subagent sessions and other Ralphs MUST be ignored.
   */
  drain(): Batch {
    const batch: Batch = { raw: [], events: [], done: false };
    for (const file of this.transcript ? [this.transcript] : this.candidates) {
      if (this.rejected.has(file)) continue;
      // Codex has no session-id launch flag. Bind only a NEW root transcript
      // containing this iteration's unique prompt marker, never another worker.
      if (this.id === "codex" && !this.transcript) {
        let text: string;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n").slice(0, -1);
        const records = lines.flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
        const meta = records.find((e) => e.type === "session_meta")?.payload;
        if (
          meta &&
          (meta.source !== "cli" || fs.realpathSync(meta.cwd) !== fs.realpathSync(this.input.dir))
        ) {
          this.rejected.add(file);
          continue;
        }
        const user = records.find(
          (e) =>
            e.type === "response_item" &&
            e.payload?.type === "message" &&
            e.payload.role === "user" &&
            e.payload.content?.some((c: any) => c.text?.includes(`Ralph iteration ${this.uuid}`)),
        );
        if (!meta || !user) continue;
        this.transcript = file;
      }
      for (const line of this.read(file)) {
        if (!line.trim()) continue;
        batch.raw.push(line);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        for (const event of this.parse(value)) {
          if (event.type === "session") {
            if (this.session !== event.sessionId) {
              this.session = event.sessionId;
              batch.events.push({ ...event, attachId: this.attachId });
            }
          } else batch.events.push(event);
        }
      }
    }
    return batch;
  }
  async next(signal: AbortSignal): Promise<Batch> {
    if (!this.pending)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          this.wake = undefined;
          reject(new Error("interrupted"));
        };
        this.wake = () => {
          signal.removeEventListener("abort", abort);
          this.wake = undefined;
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    this.pending = false;
    if (this.error) throw this.error;
    const batch = this.drain();
    const has = (type: HarnessEvent["type"]) => batch.events.some((e) => e.type === type);
    if (has("harness_exit")) batch.done = true;
    else if (has("error") || has("needs_input") || has("turn_end")) {
      batch.events.push({
        type: "harness_exit",
        status: has("error") ? "failed" : has("needs_input") ? "blocked" : "ok",
      });
      batch.done = true;
    } else if (this.terminal.state === "finished") {
      // Even exit 0 without a native completion is not proof the task ran.
      batch.events.push({
        type: "harness_exit",
        status: "failed",
        detail: `hc terminal exited before turn completion (exit ${this.terminal.exit_code ?? "unknown"})`,
      });
      batch.done = true;
    } else {
      const status = object(this.terminal.status).state;
      if (status === "blocked" || status === "error") {
        if (status === "blocked")
          batch.events.push({
            type: "needs_input",
            reason: `hc terminal ${this.address} requests input`,
          });
        batch.events.push({
          type: "harness_exit",
          status: status === "blocked" ? "blocked" : "failed",
          detail: `hc status: ${status}`,
        });
        batch.done = true;
      }
    }
    return batch;
  }
  async close() {
    this.closing = true;
    for (const watcher of this.watchers) watcher.close();
    this.monitor?.close();
    let stopped = !this.launched;
    try {
      if (this.launched) {
        await exec("hc", ["kill", this.address ?? this.name, "--json"], { timeout: 15_000 });
        stopped = true;
      }
    } catch (error) {
      if ([3, 11].includes((error as { code?: number }).code ?? -1)) stopped = true;
      // Preserve files needed by a possibly surviving terminal. Never silently
      // delete its settings if hc could not confirm teardown.
      if (!stopped)
        console.error(
          `Ralph: could not stop hc terminal ${this.address ?? this.name}; inspect with hc get. Private files retained at ${this.dir}`,
        );
    } finally {
      this.rpc.close();
      if (stopped) fs.rmSync(this.dir, { recursive: true, force: true });
    }
    return stopped;
  }
}

/** Versioned attach locator preserves old Claude IDs and the selected hc endpoint. */
export function encodeAttach(address: string): string {
  return `hc:${JSON.stringify({ address, session: process.env.HC_SESSION, socket: process.env.HC_SOCKET, runtime: process.env.XDG_RUNTIME_DIR, stateHome: process.env.XDG_STATE_HOME })}`;
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function attachCommand(locator: string): string {
  if (!locator.startsWith("hc:")) return `claude attach ${quote(locator)}`;
  try {
    const data = JSON.parse(locator.slice(3));
    const env = [
      data.session && `HC_SESSION=${quote(data.session)}`,
      data.socket && `HC_SOCKET=${quote(data.socket)}`,
      data.runtime && `XDG_RUNTIME_DIR=${quote(data.runtime)}`,
      data.stateHome && `XDG_STATE_HOME=${quote(data.stateHome)}`,
    ]
      .filter(Boolean)
      .join(" ");
    return `${env ? `${env} ` : ""}hc attach ${quote(data.address)}`;
  } catch {
    return "hc attach";
  }
}

/**
 * @cc [owner:ghuntley,label:lifecycle] hc-iteration-ownership
 * Each iteration MUST own one fresh terminal. Scope exit (including timeout,
 * failure and interruption) MUST attempt to stop only that terminal. Startup
 * idle and absent status MUST NOT be treated as successful task completion.
 * Unconfirmed teardown MUST abort the run instead of starting another iteration.
 */
export const runHc = (id: HarnessId, input: IterationInput): HarnessStream =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connection = id === "claude" ? yield* claudeConnection() : undefined;
      const terminal = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Terminal(id, input),
          catch: () => fail(id, "Cannot prepare hc terminal"),
        }),
        (terminal) =>
          Effect.promise(async () => {
            const stopped = await terminal.close();
            if (!stopped && connection) {
              connection.retain = true;
              console.error(
                `Ralph: retained Claude settings at ${connection.settings} until the terminal is stopped`,
              );
            }
            // A surviving worker must never overlap the next iteration.
            if (!stopped)
              throw fail(
                id,
                "hc terminal cleanup failed; inspect the retained terminal before restarting Ralph",
              );
          }),
      );
      // A launch can succeed after its caller is cancelled. Wait for its bounded
      // acknowledgement before releasing ownership, then the finalizer stops it.
      yield* Effect.tryPromise({
        try: () => terminal.launch(connection?.settings, connection?.env),
        catch: (e) => fail(id, `hc launch: ${e instanceof Error ? e.message : "failed"}`),
      }).pipe(Effect.uninterruptible);
      terminal.session = id === "claude" || id === "gh" ? terminal.uuid : `hc:${terminal.address}`;
      const start: HarnessEvent = {
        type: "session",
        sessionId: terminal.session,
        attachId: terminal.attachId,
      };
      const events = Stream.paginate(undefined, () =>
        Effect.tryPromise({
          try: (signal) => terminal.next(signal),
          catch: (e) => fail(id, `hc session: ${e instanceof Error ? e.message : "failed"}`),
        }).pipe(
          Effect.flatMap((batch) =>
            Effect.gen(function* () {
              for (const line of batch.raw) yield* input.onRaw(line);
              return [batch.events, batch.done ? Option.none() : Option.some(undefined)] as const;
            }),
          ),
        ),
      );
      return Stream.concat(Stream.make(start), events);
    }),
  );
