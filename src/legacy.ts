/**
 * Read-only view of the bash runner's `~/.ralph/pids/*.meta` files, so
 * `ralph status` shows every ralph on the machine during the migration.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAlive } from "./store.ts";

export interface LegacyRalph {
  readonly name: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly harness: string;
  readonly model: string;
  readonly dir: string;
  readonly prompt: string;
  readonly currentRun: number;
  readonly maxRuns: number;
  readonly started: string;
  readonly logPath: string;
}

export const parseMeta = (content: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

export const listLegacy = (
  root = path.join(os.homedir(), ".ralph"),
): ReadonlyArray<LegacyRalph> => {
  const pidDir = path.join(root, "pids");
  let files: Array<string>;
  try {
    files = fs.readdirSync(pidDir).filter((f) => f.endsWith(".meta"));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const m = parseMeta(fs.readFileSync(path.join(pidDir, f), "utf8"));
      const name = m.name ?? f.slice(0, -5);
      const pid = Number(m.pid ?? 0);
      return [
        {
          name,
          pid,
          alive: isAlive(pid),
          harness: m.harness || "claude",
          model: m.model ?? "",
          dir: m.work_dir ?? "",
          prompt: m.prompt ?? "",
          currentRun: Number(m.current_run ?? 0),
          maxRuns: Number(m.max_runs ?? 0),
          started: m.started ?? "",
          logPath: path.join(root, "logs", `${name}.log`),
        },
      ];
    } catch {
      return [];
    }
  });
};
