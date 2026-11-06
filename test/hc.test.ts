import { NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCommand, interactiveArgs } from "../src/hc.ts";
import { RalphEvents } from "../src/opencode-plugin.ts";
import { harnesses } from "../src/registry.ts";
import { interactiveParser } from "../src/interactive.ts";
import type { HarnessId } from "../src/domain.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const input = {
  prompt: "do it",
  model: null,
  effort: null,
  dir: "/tmp",
  sessionName: "worker",
  onRaw: () => Effect.void,
};

function fixture(mode = "complete") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-hc-test-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "hc"),
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const root = ${JSON.stringify(dir)}; const mode = ${JSON.stringify(mode)};
const launch = path.join(root, 'launch.json');
if (process.argv[2] === 'kill') {
  if (mode === 'kill-failed') process.exit(1);
  const data = JSON.parse(fs.readFileSync(launch, 'utf8'));
  data.stopped = true; data.settingsPresentAtStop = !data.settings || fs.existsSync(data.settings);
  fs.writeFileSync(launch, JSON.stringify(data)); console.log('{}'); process.exit(0);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
 const req = JSON.parse(line); let result = {};
 if (req.method === 'terminal.run') {
  const p = req.params; const args = p.argv; const binary = args[0];
  const uuid = args.includes('--session-id') ? args[args.indexOf('--session-id')+1] : /Ralph iteration ([a-f0-9-]+)/.exec(args.join(' '))[1];
  const settings = args.includes('--settings') ? args[args.indexOf('--settings')+1] : undefined;
  fs.writeFileSync(launch, JSON.stringify({ args, settings, name:p.name, cwd:p.cwd,
    keyOK: !settings || JSON.parse(fs.readFileSync(settings)).env.CLAUDE_CODE_OAUTH_TOKEN === 'test-key' }));
  let file, events;
  if(binary === 'claude') {
    file = path.join(p.env.CLAUDE_CONFIG_DIR, 'projects', 'test', uuid+'.jsonl');
    events = [{type:'assistant',sessionId:uuid,message:{content:[{type:'text',text:'complete'}]}}, {type:'system',subtype:'turn_duration'}];
  } else if(binary === 'copilot') {
    file = path.join(p.env.COPILOT_HOME, 'session-state', uuid, 'events.jsonl');
    events = [{type:'session.start',data:{sessionId:uuid}}, {type:'assistant.turn_start'}, {type:'assistant.message',data:{content:'complete'}},{type:'assistant.turn_end'}];
  } else if(binary === 'codex') {
    file = path.join(p.env.CODEX_HOME, 'sessions', '2026', '11', '06', uuid+'.jsonl');
    const meta = {type:'session_meta',payload:{id:uuid,source:'cli',cwd:p.cwd}};
    const unrelated = path.join(path.dirname(file), 'unrelated.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(unrelated, JSON.stringify(meta)+'\\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})+'\\n');
    events = [meta,{type:'response_item',payload:{type:'message',role:'user',content:[{text:args.at(-1)}]}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{text:'complete'}]}},{type:'event_msg',payload:{type:'task_complete'}}];
  } else {
    file = p.env.RALPH_EVENT_FILE;
    events = [{type:'ralph.session',properties:{sessionID:uuid}},{type:'message.part.updated',properties:{part:{id:'p1',sessionID:uuid,type:'text',text:'complete',time:{end:1}}}},{type:'session.idle',properties:{sessionID:uuid}}];
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(mode === 'complete' || mode === 'kill-failed') fs.writeFileSync(file, events.map(e=>JSON.stringify(e)).join('\\n')+'\\n');
  if(mode === 'error') fs.writeFileSync(file, JSON.stringify({type:'assistant',isApiErrorMessage:true,error:'authentication_failed',message:{content:[{type:'text',text:'401 login required'}]}})+'\\n');
  result = {address:'t1',state:'live'};
 } else if(req.method === 'events.subscribe') {
  result = {seq:1,terminals:[{address:'t1',state:mode === 'exit' ? 'finished' : 'live',exit_code:0,status:{state:mode === 'blocked'?'blocked':'idle'}}]};
 }
 if (mode === 'slow-launch' && req.method === 'terminal.run') setTimeout(() => console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result})), 250);
 else console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
});
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "claude"));
  vi.stubEnv("COPILOT_HOME", path.join(dir, "copilot"));
  vi.stubEnv("CODEX_HOME", path.join(dir, "codex"));
  vi.stubEnv("UNDERCLASS_CONFIG_DIR", path.join(dir, "underclass"));
  vi.stubEnv("UNDERCLASS_PROXY_KEY", "test-key");
  return { dir, record: () => JSON.parse(fs.readFileSync(path.join(dir, "launch.json"), "utf8")) };
}

const collect = (id: HarnessId, dir: string) =>
  harnesses[id]
    .run({ ...input, dir })
    .pipe(Stream.runCollect, Effect.scoped, Effect.provide(NodeServices.layer));

describe("hc lifecycle", () => {
  for (const id of ["claude", "codex", "opencode", "gh"] as const) {
    it(`${id}: uses interactive launch, consumes its own transcript, and stops the terminal`, async () => {
      const { dir, record } = fixture();
      const events = await Effect.runPromise(collect(id, dir));
      expect(events).toContainEqual({ type: "assistant", text: "complete" });
      expect(events.at(-1)).toEqual({ type: "harness_exit", status: "ok" });
      expect(events[0]).toMatchObject({
        type: "session",
        attachId: expect.stringContaining("hc:"),
      });
      const launch = record();
      expect(launch.stopped).toBe(true);
      expect(launch.settingsPresentAtStop).toBe(true);
      expect(launch.args).not.toContain("--bg");
      expect(launch.args).not.toContain("-p");
      expect(launch.args).not.toContain("exec");
      expect(JSON.stringify(launch.args)).not.toContain("test-key");
      if (id === "claude") {
        expect(launch.keyOK).toBe(true);
        expect(fs.existsSync(launch.settings)).toBe(false);
      }
    });
  }
  it("failed cleanup aborts the stream and retains credentials for the surviving terminal", async () => {
    const { dir, record } = fixture("kill-failed");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      const exit = await Effect.runPromise(collect("claude", dir).pipe(Effect.exit));
      expect(exit._tag).toBe("Failure");
      expect(fs.existsSync(record().settings)).toBe(true);
      dirs.push(path.dirname(record().settings));
      const retained = logs.join("\n").match(/Private files retained at (\S+)/)?.[1];
      expect(retained).toBeDefined();
      if (retained) dirs.push(retained);
    } finally {
      spy.mockRestore();
    }
  });
  it("startup idle does not finish; timeout stops the terminal before removing settings", async () => {
    const { dir, record } = fixture("idle");
    const exit = await Effect.runPromise(
      collect("claude", dir).pipe(Effect.timeout("350 millis"), Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    expect(record().stopped).toBe(true);
    expect(record().settingsPresentAtStop).toBe(true);
    expect(fs.existsSync(record().settings)).toBe(false);
  });
  it("cancellation during launch waits for ownership before teardown", async () => {
    const { dir, record } = fixture("slow-launch");
    const exit = await Effect.runPromise(
      collect("claude", dir).pipe(Effect.timeout("100 millis"), Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    expect(record().stopped).toBe(true);
    expect(record().settingsPresentAtStop).toBe(true);
    expect(fs.existsSync(record().settings)).toBe(false);
  });
  for (const [mode, status] of [
    ["blocked", "blocked"],
    ["error", "failed"],
    ["exit", "failed"],
  ] as const)
    it(`handles ${mode} without mistaking it for success`, async () => {
      const { dir, record } = fixture(mode);
      const events = await Effect.runPromise(collect("claude", dir));
      expect(events.at(-1)).toMatchObject({ type: "harness_exit", status });
      expect(record().stopped).toBe(true);
    });
});

describe("interactive event boundaries", () => {
  it("Copilot tool turns do not end the user task", () => {
    const parse = interactiveParser("gh");
    parse({ type: "assistant.turn_start" });
    parse({
      type: "assistant.message",
      data: { content: "checking", toolRequests: [{ name: "shell", arguments: {} }] },
    });
    expect(parse({ type: "assistant.turn_end" })).toEqual([]);
    parse({ type: "assistant.turn_start" });
    parse({ type: "assistant.message", data: { content: "done" } });
    expect(parse({ type: "assistant.turn_end" })).toEqual([{ type: "turn_end" }]);
  });
  it("the OpenCode plugin binds only the marked root and preserves effort", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-plugin-test-"));
    dirs.push(dir);
    const file = path.join(dir, "events.jsonl");
    vi.stubEnv("RALPH_EVENT_FILE", file);
    vi.stubEnv("RALPH_ITERATION_MARKER", "unique-marker");
    vi.stubEnv("RALPH_EFFORT", "xhigh");
    const hooks = await RalphEvents();
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    expect(fs.existsSync(file)).toBe(false);
    const output = {
      parts: [{ type: "text", text: "unique-marker task" }],
      message: {} as { variant?: string },
    };
    await hooks["chat.message"]({ sessionID: "root" }, output);
    expect(output.message.variant).toBe("xhigh");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    const events = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["ralph.session", "session.idle"]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it("OpenCode ignores startup idle, child sessions and duplicate finished parts", () => {
    const parse = interactiveParser("opencode");
    expect(parse({ type: "session.idle", properties: { sessionID: "root" } })).toEqual([]);
    parse({ type: "ralph.session", properties: { sessionID: "root" } });
    expect(parse({ type: "session.idle", properties: { sessionID: "child" } })).toEqual([]);
    const part = {
      type: "message.part.updated",
      properties: {
        part: { id: "p", sessionID: "root", type: "text", text: "hello", time: { end: 1 } },
      },
    };
    expect(parse(part)).toContainEqual({ type: "assistant", text: "hello" });
    expect(parse(part)).toEqual([]);
    expect(parse({ type: "session.idle", properties: { sessionID: "root" } })).toEqual([
      { type: "turn_end" },
    ]);
  });
  it("keeps hc locators distinct from old Claude IDs", () => {
    expect(attachCommand("abcdef12")).toBe("claude attach 'abcdef12'");
    expect(attachCommand('hc:{"address":"t7","session":"ralph"}')).toBe(
      "HC_SESSION='ralph' hc attach 't7'",
    );
    expect(interactiveArgs("codex", input, "uuid")).toContain("--no-daemon");
  });
});
