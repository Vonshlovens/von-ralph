/**
 * Scheduled runs as systemd user units: `ralph schedule add nightly --cron
 * "0 2 * * *" -- build -d ~/repo -N 5` writes `ralph-sched-nightly.timer` and a
 * oneshot `ralph-sched-nightly.service` that runs `ralph build …` in the
 * foreground, so systemd sees the real exit code (0 done, 3 needs a human,
 * 1 failed). The unit files are the source of truth; each service carries a
 * `# ralph-schedule: {json}` line with what `schedule list` shows.
 */
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCRIPT } from "./cli/shared.ts";
import { StateError } from "./domain.ts";
import { NAME_RE, defaultRoot } from "./store.ts";

export const UNIT_PREFIX = "ralph-sched-";
const META = "# ralph-schedule: ";

export interface ScheduleMeta {
  readonly name: string;
  /** systemd OnCalendar expression (normalized) */
  readonly calendar: string;
  /** the cron expression it came from, if any */
  readonly cron: string | null;
  /** ralph CLI args, e.g. ["build", "-d", "/home/me/repo", "-N", "5"] */
  readonly args: ReadonlyArray<string>;
  readonly dir: string;
  readonly persistent: boolean;
  readonly createdAt: string;
}

export interface ScheduleInfo extends ScheduleMeta {
  readonly enabled: boolean;
  readonly nextRun: string | null;
  readonly lastRun: string | null;
  /** service Result= (success, exit-code, …) of the last run */
  readonly lastResult: string | null;
  readonly lastExitCode: number | null;
  readonly running: boolean;
}

export const unitDir = () =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "systemd", "user");

const fail = (where: string, reason: string) => new StateError({ path: where, reason });

// ------------------------------------------------------------------ cron → OnCalendar

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_NAMES: Record<string, number> = Object.fromEntries(
  DOW.map((d, i) => [d.toLowerCase(), i]),
);
const MON_NAMES: Record<string, number> = Object.fromEntries(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (m, i) => [m, i + 1],
  ),
);
const MACROS: Record<string, string> = {
  "@hourly": "hourly",
  "@daily": "daily",
  "@midnight": "daily",
  "@weekly": "weekly",
  "@monthly": "monthly",
  "@yearly": "yearly",
  "@annually": "yearly",
};

const range = (a: number, b: number, step = 1) => {
  const out: Array<number> = [];
  for (let v = a; v <= b; v += step) out.push(v);
  return out;
};

/** One cron field → values (null = `*`). */
const field = (
  spec: string,
  min: number,
  max: number,
  names: Record<string, number> = {},
): Array<number> | null | { every: number } => {
  const num = (s: string) => {
    const v = names[s.toLowerCase()] ?? Number(s);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`'${s}' is out of range`);
    return v;
  };
  if (spec === "*") return null;
  if (/^\*\/\d+$/.test(spec)) return { every: Number(spec.slice(2)) };
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const [r, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in '${part}'`);
    if (r === undefined || r === "") throw new Error(`empty field in '${spec}'`);
    if (r === "*") {
      for (const v of range(min, max, step)) values.add(v);
    } else if (r.includes("-")) {
      const [a, b] = r.split("-");
      for (const v of range(num(a ?? ""), num(b ?? ""), step)) values.add(v);
    } else if (stepS !== undefined) {
      for (const v of range(num(r), max, step)) values.add(v);
    } else {
      values.add(num(r));
    }
  }
  return [...values].sort((x, y) => x - y);
};

const pad2 = (n: number) => String(n).padStart(2, "0");

const calField = (f: Array<number> | null | { every: number }, start: number, padded: boolean) => {
  if (f === null) return "*";
  if (!Array.isArray(f)) return `${padded ? pad2(start) : start}/${f.every}`;
  return f.map((v) => (padded ? pad2(v) : String(v))).join(",");
};

/**
 * Convert a 5-field cron expression (or @daily etc.) to a systemd OnCalendar
 * expression. Rejects what systemd cannot express the same way (day-of-month
 * AND day-of-week both restricted: cron ORs them, systemd ANDs them).
 */
export const cronToCalendar = (cron: string): string => {
  const c = cron.trim();
  const macro = MACROS[c.toLowerCase()];
  if (macro !== undefined) return macro;
  const parts = c.split(/\s+/);
  if (parts.length !== 5)
    throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const fm = field(m, 0, 59);
  const fh = field(h, 0, 23);
  const fdom = field(dom, 1, 31);
  const fmon = field(mon, 1, 12, MON_NAMES);
  const fdow = field(dow, 0, 7, DOW_NAMES);
  if (fdom !== null && fdow !== null) {
    throw new Error(
      "cron ORs day-of-month and day-of-week but systemd ANDs them; use --at with an OnCalendar expression",
    );
  }
  let days = "";
  if (fdow !== null) {
    const list = Array.isArray(fdow) ? fdow : range(0, 7, fdow.every);
    const uniq = [...new Set(list.map((d) => d % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    days = `${uniq.map((d) => DOW[d]).join(",")} `;
  }
  return `${days}*-${calField(fmon, 1, true)}-${calField(fdom, 1, true)} ${calField(fh, 0, true)}:${calField(fm, 0, true)}:00`;
};

/** Validate/normalize with `systemd-analyze calendar` when available. */
export const normalizeCalendar = (expr: string) =>
  Effect.try({
    try: () => {
      const out = execFileSync("systemd-analyze", ["calendar", expr], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return /Normalized form:\s*(.+)/.exec(out)?.[1]?.trim() ?? expr;
    },
    catch: (e) => {
      const err = e as { stderr?: string; code?: string };
      if (err.code === "ENOENT") return null;
      return fail(expr, `invalid calendar expression: ${(err.stderr ?? String(e)).trim()}`);
    },
  }).pipe(Effect.catch((e) => (e === null ? Effect.succeed(expr) : Effect.fail(e as StateError))));

// ------------------------------------------------------------------ unit files

/** Quote one ExecStart argument for systemd (it expands %, $ and splits on spaces). */
export const quoteArg = (a: string) => {
  const escaped = a.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) && a !== ""
    ? escaped
    : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
};

const envLine = (k: string, v: string) => `Environment=${quoteArg(`${k}=${v}`)}`;

export const renderUnits = (meta: ScheduleMeta, env: Record<string, string>) => {
  const exec = [process.execPath, SCRIPT, ...meta.args].map(quoteArg).join(" ");
  const label = `ralph schedule ${meta.name}: ralph ${meta.args.join(" ")}`.replace(/\n/g, " ");
  const service = [
    "[Unit]",
    `Description=${label.replace(/%/g, "%%")}`,
    `${META}${JSON.stringify(meta)}`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${quoteArg(meta.dir)}`,
    ...Object.entries(env).map(([k, v]) => envLine(k, v)),
    `ExecStart=${exec}`,
    "TimeoutStartSec=infinity",
    // SIGTERM to ralph only: it stops its own agent terminal and records the run.
    "KillMode=mixed",
    "TimeoutStopSec=60",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    `Description=${label.replace(/%/g, "%%")}`,
    "",
    "[Timer]",
    `OnCalendar=${meta.calendar}`,
    `Persistent=${meta.persistent ? "true" : "false"}`,
    `Unit=${UNIT_PREFIX}${meta.name}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
};

const systemctl = (...args: Array<string>) =>
  Effect.try({
    try: () =>
      execFileSync("systemctl", ["--user", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    catch: (e) =>
      fail(
        `systemctl --user ${args.join(" ")}`,
        ((e as { stderr?: string }).stderr ?? String(e)).trim() || String(e),
      ),
  });

const unitPath = (name: string, kind: "service" | "timer") =>
  path.join(unitDir(), `${UNIT_PREFIX}${name}.${kind}`);

const readMeta = (name: string): ScheduleMeta | null => {
  const file = unitPath(name, "service");
  if (!fs.existsSync(file)) return null;
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(META));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(META.length)) as ScheduleMeta;
  } catch {
    return null;
  }
};

export interface AddOptions {
  readonly name: string;
  readonly cron: string | null;
  readonly at: string | null;
  readonly args: ReadonlyArray<string>;
  readonly persistent: boolean;
  readonly replace: boolean;
  /** Write the files but do not touch systemd (tests). */
  readonly dryRun?: boolean;
}

const MODES = new Set(["run", "plan", "build", "reverse"]);

/** Index of a flag's value in args (`--dir x`, `-d x`), or -1. */
const flagIndex = (args: ReadonlyArray<string>, long: string, short: string) => {
  const i = args.findIndex((a) => a === long || a === short);
  return i >= 0 && i + 1 < args.length ? i + 1 : -1;
};

export const add = (o: AddOptions) =>
  Effect.gen(function* () {
    if (!NAME_RE.test(o.name)) return yield* fail(o.name, "name must match [A-Za-z0-9._-]{1,100}");
    if ((o.cron === null) === (o.at === null)) {
      return yield* fail(o.name, "give exactly one of --cron or --at");
    }
    const mode = o.args[0];
    if (mode === undefined || !MODES.has(mode)) {
      return yield* fail(o.name, "after --, give a ralph command: run, plan, build or reverse");
    }
    if (o.args.includes("--detach")) {
      return yield* fail(o.name, "scheduled runs stay in the foreground; drop --detach");
    }
    if (!o.replace && fs.existsSync(unitPath(o.name, "service"))) {
      return yield* fail(o.name, "schedule exists (use --replace)");
    }
    const raw =
      o.cron !== null
        ? yield* Effect.try({
            try: () => cronToCalendar(o.cron ?? ""),
            catch: (e) => fail(o.cron ?? "", `bad cron: ${(e as Error).message}`),
          })
        : (o.at ?? "");
    const calendar = o.dryRun === true ? raw : yield* normalizeCalendar(raw);
    if (o.args.some((a) => a.startsWith("--dir=") || a.startsWith("--name="))) {
      return yield* fail(o.name, "use `--dir x` / `--name x` (not --flag=x) in the ralph args");
    }
    // Absolute dir and a default run name, so the unit does not depend on where it was added.
    const args = [...o.args];
    const di = flagIndex(args, "--dir", "-d");
    const dir = path.resolve(
      di < 0 ? process.cwd() : (args[di] ?? "").replace(/^~(?=\/|$)/, os.homedir()),
    );
    if (di < 0) args.splice(1, 0, "--dir", dir);
    else args[di] = dir;
    if (flagIndex(args, "--name", "-n") < 0) args.splice(1, 0, "--name", o.name);
    if (!args.includes("--quiet") && !args.includes("-q")) {
      // `run` takes its prompt last; keep it there.
      args.splice(mode === "run" ? args.length - 1 : args.length, 0, "--quiet");
    }
    const meta: ScheduleMeta = {
      name: o.name,
      calendar,
      cron: o.cron,
      args,
      dir,
      persistent: o.persistent,
      createdAt: new Date().toISOString(),
    };
    // systemd user services get a minimal PATH; the harness CLIs and hc must resolve.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      RALPH_HOME: defaultRoot(),
    };
    for (const k of ["RALPH_CALLBACK_SECRET_FILE", "UNDERCLASS_URL", "UNDERCLASS_CONFIG_DIR"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    const { service, timer } = renderUnits(meta, env);
    fs.mkdirSync(unitDir(), { recursive: true });
    fs.writeFileSync(unitPath(o.name, "service"), service);
    fs.writeFileSync(unitPath(o.name, "timer"), timer);
    if (o.dryRun !== true) {
      yield* systemctl("daemon-reload");
      yield* systemctl("enable", "--now", `${UNIT_PREFIX}${o.name}.timer`);
    }
    return meta;
  });

const showProps = (unit: string, props: ReadonlyArray<string>) =>
  systemctl("show", unit, "--timestamp=utc", ...props.map((p) => `--property=${p}`)).pipe(
    Effect.map((out) =>
      Object.fromEntries(
        out
          .split("\n")
          .filter((l) => l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      ),
    ),
    Effect.orElseSucceed(() => ({}) as Record<string, string>),
  );

const ts = (v: string | undefined) => {
  if (v === undefined || v === "" || v === "n/a" || v === "0") return null;
  const d = new Date(
    v
      .replace(/^\w{3} /, "")
      .replace(" UTC", "Z")
      .replace(" ", "T"),
  );
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

export const names = () =>
  fs.existsSync(unitDir())
    ? fs
        .readdirSync(unitDir())
        .filter((f) => f.startsWith(UNIT_PREFIX) && f.endsWith(".service"))
        .map((f) => f.slice(UNIT_PREFIX.length, -".service".length))
        .sort()
    : [];

export const info = (name: string) =>
  Effect.gen(function* () {
    const meta = readMeta(name);
    if (meta === null) return yield* fail(name, "no such schedule");
    const t = yield* showProps(`${UNIT_PREFIX}${name}.timer`, [
      "UnitFileState",
      "NextElapseUSecRealtime",
      "LastTriggerUSec",
    ]);
    // The service's own timestamps also cover `schedule run` (not only timer triggers).
    const s = yield* showProps(`${UNIT_PREFIX}${name}.service`, [
      "ActiveState",
      "Result",
      "ExecMainStatus",
      "ExecMainStartTimestamp",
    ]);
    const exit = Number.parseInt(s.ExecMainStatus ?? "", 10);
    const lastRun = ts(s.ExecMainStartTimestamp) ?? ts(t.LastTriggerUSec);
    return {
      ...meta,
      enabled: t.UnitFileState === "enabled",
      nextRun: ts(t.NextElapseUSecRealtime),
      lastRun,
      lastResult: lastRun === null ? null : (s.Result ?? null),
      lastExitCode: lastRun === null || !Number.isFinite(exit) ? null : exit,
      running: s.ActiveState === "activating" || s.ActiveState === "active",
    } satisfies ScheduleInfo;
  });

export const list = () => Effect.forEach(names(), info);

export const remove = (name: string) =>
  Effect.gen(function* () {
    if (readMeta(name) === null) return yield* fail(name, "no such schedule");
    yield* systemctl("disable", "--now", `${UNIT_PREFIX}${name}.timer`).pipe(Effect.ignore);
    fs.rmSync(unitPath(name, "timer"), { force: true });
    fs.rmSync(unitPath(name, "service"), { force: true });
    yield* systemctl("daemon-reload").pipe(Effect.ignore);
  });

/** Start the service now (does not wait); the run shows up in `ralph status`. */
export const runNow = (name: string) =>
  Effect.gen(function* () {
    if (readMeta(name) === null) return yield* fail(name, "no such schedule");
    yield* systemctl("start", "--no-block", `${UNIT_PREFIX}${name}.service`);
  });

export const setEnabled = (name: string, enabled: boolean) =>
  Effect.gen(function* () {
    if (readMeta(name) === null) return yield* fail(name, "no such schedule");
    yield* systemctl(enabled ? "enable" : "disable", "--now", `${UNIT_PREFIX}${name}.timer`);
  });
