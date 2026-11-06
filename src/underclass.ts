/** Underclass connection settings for interactive Claude sessions. */
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import { HarnessFailed } from "./domain.ts";

const fail = (reason: string) => new HarnessFailed({ harness: "claude", reason });
const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * @cc [owner:ghuntley,label:security] underclass-credential-resolution
 * Resolve only Underclass credentials, in order: UNDERCLASS_PROXY_KEY, config.toml,
 * then the read-only pool.db. Missing or unreadable credentials MUST fail without
 * falling back to a Claude login or including configuration contents in errors.
 */
export const resolveUnderclass = (
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): Record<string, string> => {
  const configDir = env.UNDERCLASS_CONFIG_DIR ?? path.join(home, ".config/underclass");
  const dataDir = env.UNDERCLASS_DATA_DIR ?? path.join(home, ".local/share/underclass");
  let config: Record<string, unknown> = {};
  try {
    config = parseToml(fs.readFileSync(path.join(configDir, "config.toml"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw fail("Cannot read Underclass config.toml; check its syntax and permissions.");
  }
  const bind = nonempty(env.UNDERCLASS_BIND) ?? nonempty(config.bind) ?? "127.0.0.1:8080";
  let baseUrl: string;
  try {
    const url = new URL(nonempty(env.UNDERCLASS_URL) ?? `http://${bind}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid URL");
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (url.hostname === "[::]") url.hostname = "[::1]";
    baseUrl = url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
  } catch {
    throw fail("Invalid Underclass endpoint; set UNDERCLASS_URL to an HTTP(S) base URL.");
  }
  let key = nonempty(env.UNDERCLASS_PROXY_KEY) ?? nonempty(config.proxy_key);
  if (key === undefined) {
    const dbPath = path.join(dataDir, "pool.db");
    try {
      // DatabaseSync's readOnly option also prevents creating a missing database.
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        key = nonempty(db.prepare("SELECT value FROM config WHERE key = 'proxy_key'").get()?.value);
      } finally {
        db.close();
      }
    } catch {
      throw fail(
        "Cannot read Underclass proxy key; set UNDERCLASS_PROXY_KEY or start underclass serve locally.",
      );
    }
  }
  if (key === undefined)
    throw fail(
      "No Underclass proxy key; set UNDERCLASS_PROXY_KEY or start underclass serve locally.",
    );
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_OAUTH_TOKEN: key,
    // Prevent inherited API credentials or provider selection from bypassing the pool.
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
  };
};

/**
 * @cc [owner:ghuntley,label:security] private-claude-settings
 * The proxy credential MUST reach Claude through a 0600 settings file in a private
 * directory, never through command arguments. Keep that file until the session's
 * scope ends, then remove it, including on failure or interruption. If terminal
 * teardown cannot be confirmed, retain it for that surviving session.
 */
export const claudeConnection = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const overrides = resolveUnderclass(env, home);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-claude-"));
        try {
          const settings = path.join(dir, "settings.json");
          fs.writeFileSync(
            settings,
            JSON.stringify({
              env: overrides,
            }),
            { mode: 0o600 },
          );
          return { settings, env: { ...env, ...overrides }, dir, retain: false };
        } catch {
          fs.rmSync(dir, { recursive: true, force: true });
          throw fail("Cannot create private Claude settings for Underclass.");
        }
      },
      catch: (e) =>
        e instanceof HarnessFailed ? e : fail("Cannot prepare Claude's Underclass connection."),
    }),
    ({ dir, retain }) =>
      Effect.sync(() => {
        if (!retain) fs.rmSync(dir, { recursive: true, force: true });
      }),
  );
