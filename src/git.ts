/** Small git helpers for the loop: HEAD, working-tree changes, commit ranges. */
import { Effect } from "effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { capture } from "./proc.ts";

const git = (dir: string, args: ReadonlyArray<string>) =>
  capture("git", args, { cwd: dir, timeoutMs: 60_000 });

export const head = (dir: string) =>
  git(dir, ["rev-parse", "HEAD"]).pipe(
    Effect.map((r) => {
      const sha = r.stdout.trim();
      return r.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }),
  );

const hashFile = (file: string): string => {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
};

/**
 * Dirty paths (modified, staged, untracked, deleted) mapped to a content hash,
 * so a later snapshot can tell which of them an iteration touched.
 */
export const dirty = (dir: string) =>
  git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).pipe(
    Effect.map((r) => {
      const out = new Map<string, string>();
      if (r.exitCode !== 0) return out;
      const parts = r.stdout.split("\0");
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i] ?? "";
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        const file = entry.slice(3);
        out.set(file, hashFile(path.join(dir, file)));
        if (status[0] === "R" || status[0] === "C") i++; // next entry is the source path
      }
      return out;
    }),
  );

/** Files changed between two commits. */
export const changedBetween = (dir: string, from: string, to: string) =>
  from === to
    ? Effect.succeed([] as ReadonlyArray<string>)
    : git(dir, ["diff", "--name-only", "-z", from, to]).pipe(
        Effect.map((r) => (r.exitCode === 0 ? r.stdout.split("\0").filter((f) => f !== "") : [])),
      );

/**
 * Files an iteration touched: committed between the two HEADs, plus working-tree
 * changes that were not already there (with the same content) before it.
 */
export const touched = (
  dir: string,
  before: { readonly head: string | null; readonly dirty: ReadonlyMap<string, string> },
  afterHead: string | null,
) =>
  Effect.gen(function* () {
    const files = new Set<string>();
    if (before.head !== null && afterHead !== null) {
      for (const f of yield* changedBetween(dir, before.head, afterHead)) files.add(f);
    }
    for (const [f, hash] of yield* dirty(dir)) {
      if (before.dirty.get(f) !== hash) files.add(f);
    }
    return [...files].sort();
  });

export const log = (dir: string, from: string, to: string) =>
  git(dir, ["log", "--oneline", "--no-decorate", `${from}..${to}`]).pipe(
    Effect.map((r) =>
      r.exitCode === 0
        ? r.stdout
            .trim()
            .split("\n")
            .filter((l) => l !== "")
        : [],
    ),
  );

export const diffStat = (dir: string, from: string, to: string) =>
  git(dir, ["diff", "--stat", from, to]).pipe(
    Effect.map((r) => (r.exitCode === 0 ? r.stdout.trimEnd() : "")),
  );

/** Unified diff of the given paths (working tree vs `base`, or HEAD). */
export const diffOf = (dir: string, base: string | null, files: ReadonlyArray<string>) =>
  git(dir, ["diff", base ?? "HEAD", "--", ...files]).pipe(Effect.map((r) => r.stdout));
