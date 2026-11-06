import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeConnection, resolveUnderclass } from "../src/underclass.ts";

const dirs: string[] = [];
const fixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-underclass-test-"));
  dirs.push(home);
  const configDir = path.join(home, ".config/underclass");
  const dataDir = path.join(home, ".local/share/underclass");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { home, configDir, dataDir };
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Underclass Claude connection", () => {
  it("uses config credentials and bind, with explicit env overrides taking precedence", () => {
    const { home, configDir } = fixture();
    fs.writeFileSync(
      path.join(configDir, "config.toml"),
      'bind = "0.0.0.0:9080"\nproxy_key = "config-secret"\n',
    );
    expect(resolveUnderclass({}, home)).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9080",
      CLAUDE_CODE_OAUTH_TOKEN: "config-secret",
    });
    expect(
      resolveUnderclass(
        {
          UNDERCLASS_URL: "https://proxy.example/v1/",
          UNDERCLASS_PROXY_KEY: "env-secret",
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          CLAUDE_CODE_OAUTH_TOKEN: "direct-secret",
          ANTHROPIC_API_KEY: "direct-key",
          CLAUDE_CODE_USE_VERTEX: "1",
        },
        home,
      ),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "env-secret",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_USE_VERTEX: "0",
    });
    expect(resolveUnderclass({ UNDERCLASS_BIND: "[::]:9081" }, home).ANTHROPIC_BASE_URL).toBe(
      "http://[::1]:9081",
    );
  });

  it("reads a minted proxy key from a custom data directory without modifying the database", () => {
    const { home, configDir, dataDir } = fixture();
    const dbPath = path.join(dataDir, "pool.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO config VALUES (?, ?)").run("proxy_key", "db-secret");
    db.close();
    const before = fs.readFileSync(dbPath);
    expect(
      resolveUnderclass(
        { UNDERCLASS_CONFIG_DIR: configDir, UNDERCLASS_DATA_DIR: dataDir },
        "/unused",
      ),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      CLAUDE_CODE_OAUTH_TOKEN: "db-secret",
    });
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(fs.existsSync(path.join(home, "pool.db"))).toBe(false);
  });

  it("fails closed without a key and does not create a database or disclose malformed config", () => {
    const { home, configDir, dataDir } = fixture();
    expect(() => resolveUnderclass({ CLAUDE_CODE_OAUTH_TOKEN: "direct-secret" }, home)).toThrow(
      /Underclass proxy key/,
    );
    expect(fs.existsSync(path.join(dataDir, "pool.db"))).toBe(false);
    fs.writeFileSync(path.join(configDir, "config.toml"), 'proxy_key = "secret-invalid');
    expect(() => resolveUnderclass({}, home)).toThrow(
      "Cannot read Underclass config.toml; check its syntax and permissions.",
    );
  });

  it("rejects malformed endpoints without echoing credentials", () => {
    const { home } = fixture();
    for (const url of [
      "file:///tmp/proxy",
      "http://user:secret@localhost",
      "http://localhost?key=secret",
    ])
      expect(() =>
        resolveUnderclass({ UNDERCLASS_URL: url, UNDERCLASS_PROXY_KEY: "secret" }, home),
      ).toThrow("Invalid Underclass endpoint; set UNDERCLASS_URL to an HTTP(S) base URL.");
  });

  it("keeps settings private and removes them on success, failure, and interruption", async () => {
    const { home } = fixture();
    for (const end of [Effect.void, Effect.fail("failure"), Effect.interrupt]) {
      let file = "";
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* claudeConnection(
              { UNDERCLASS_PROXY_KEY: "secret", PATH: "/bin" },
              home,
            );
            file = connection.settings;
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
            expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
              env: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
            });
            expect(connection.env.PATH).toBe("/bin");
            yield* end;
          }),
        ).pipe(Effect.exit),
      );
      expect(file).not.toBe("");
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    }
  });
});
