import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalMcpReview,
  localMcpSources,
} from "../../electron/connectors/local-mcp-import";
import {
  McpConnectionLogs,
  redactMcpText,
} from "../../electron/connectors/mcp-connection-logs";
import { registerMcpSettingsHandlers } from "../../electron/ipc/settings-mcp";
import { openPolicy } from "../../shared/client-policy";

test("MCP connection logs redact credentials before retention and bound each server's history", () => {
  let config: Record<string, unknown> = {
    docs: {
      command: "mcp",
      args: ["--token", "arg-secret"],
      env: { KEY: "env-secret" },
    },
    other: { command: "other", client_secret: "other-secret" },
  };
  const logs = new McpConnectionLogs(() => config);
  logs.record(
    "docs",
    "failed",
    "env-secret arg-secret other-secret Bearer some-token token=example https://user:password@example.com/x?key=hidden",
  );
  const first = logs.read("docs");
  for (const secret of [
    "env-secret",
    "arg-secret",
    "other-secret",
    "some-token",
    "example ",
    "password",
    "hidden",
  ])
    assert.ok(!first.lines.join("\n").includes(secret), secret);
  assert.match(first.lines[0], /failed:/);
  assert.match(first.lines[0], /\[redacted\]/);
  logs.record("docs", "failed", "😀".repeat(5000));
  assert.ok(Buffer.byteLength(logs.read("docs").lines.at(-1)!) <= 4096);
  for (let i = 0; i < 350; i++)
    logs.record("docs", "failed", `event-${i} ${"x".repeat(4000)}`);
  const latest = logs.read("docs");
  assert.ok(latest.lines.length <= 200);
  assert.ok(Buffer.byteLength(latest.lines.join("")) <= 64 * 1024);
  assert.equal(latest.truncated, true);
  assert.match(latest.lines.at(-1)!, /event-349/);
  assert.equal(logs.read("other").lines.length, 0);
  logs.record("unknown", "failed", "not retained");
  assert.throws(() => logs.read("unknown"), /no longer exists/);
  const isolated = new McpConnectionLogs(() => config);
  assert.equal(isolated.read("docs").lines.length, 0);
  config = {};
  assert.throws(() => logs.read("docs"));
  assert.equal(redactMcpText('API_KEY="secret value"'), "API_KEY=[redacted]");
});

test("MCP import reviews supported sources, keeps credentials private, detects collisions, and adds disabled without execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-mcp-review-"));
  try {
    const source = path.join(root, "source.json");
    const original = {
      command: "never-run-import-fixture",
      args: ["--token", "arg-credential"],
      env: { PRIVATE: "credential-to-preserve" },
      type: "stdio",
    };
    await fs.writeFile(
      source,
      JSON.stringify({
        mcpServers: {
          fresh: original,
          duplicate: { command: "existing" },
          taken: { command: "different" },
          builtIn: { command: "reserved" },
          extension: { command: "extension-command" },
          remote: { url: "https://example.com" },
          malformed: { command: "x", args: [1] },
          __proto__: undefined,
        },
      }),
    );
    let current: Record<string, unknown> = {
      duplicate: { command: "existing", enabled: false },
      taken: { command: "original", env: { TOKEN: "unchanged" } },
      extension: {
        command: "extension-command",
        claudex_extension: "managed-extension",
      },
    };
    let writes = 0;
    let owner = "account-a";
    let now = 1;
    const review = new LocalMcpReview({
      owner: () => owner,
      current: () => current,
      managedNames: () => ["builtIn"],
      allowed: () => true,
      update: (next) => {
        current = next;
        writes++;
      },
      sources: () => [
        { name: "Fixture", path: source },
        { name: "Missing", path: path.join(root, "missing") },
      ],
      now: () => now,
    });
    const discovery = await review.discover();
    const byName = Object.fromEntries(
      discovery.candidates.map((item) => [item.name, item]),
    );
    assert.equal(byName.fresh.state, "available");
    assert.equal(byName.duplicate.state, "duplicate");
    assert.equal(byName.taken.state, "name-in-use");
    assert.equal(byName.builtIn.state, "managed");
    assert.equal(byName.extension.state, "managed");
    assert.equal(byName.remote.state, "unsupported");
    assert.equal(byName.malformed.state, "unsupported");
    assert.equal(discovery.sources[1].state, "missing");
    assert.ok(!JSON.stringify(discovery).includes("credential-to-preserve"));
    assert.ok(!JSON.stringify(discovery).includes("arg-credential"));
    assert.equal(writes, 0);
    assert.throws(
      () => review.import({ token: discovery.token, ids: [byName.taken.id] }),
      /name is now in use/,
    );
    assert.equal(writes, 0);
    assert.deepEqual(
      review.import({ token: discovery.token, ids: [byName.fresh.id] }),
      { imported: ["fresh"], disabled: true },
    );
    assert.equal(writes, 1);
    assert.deepEqual(current.fresh, {
      command: original.command,
      args: original.args,
      env: original.env,
      enabled: false,
    });
    assert.deepEqual(current.taken, {
      command: "original",
      env: { TOKEN: "unchanged" },
    });
    assert.throws(
      () => review.import({ token: discovery.token, ids: [byName.fresh.id] }),
      /expired/,
    );
    const next = await review.discover();
    owner = "account-b";
    assert.throws(
      () => review.import({ token: next.token, ids: [next.candidates[0].id] }),
      /expired/,
    );
    owner = "account-a";
    const expiring = await review.discover();
    now += 600_001;
    assert.throws(
      () =>
        review.import({
          token: expiring.token,
          ids: [expiring.candidates[0].id],
        }),
      /expired/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP import rejects changed names/policy, oversize files and symlinks; malformed source does not hide healthy sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-mcp-edges-"));
  try {
    const valid = path.join(root, "valid.json");
    const bad = path.join(root, "bad.json");
    const huge = path.join(root, "huge.json");
    const link = path.join(root, "link.json");
    await fs.writeFile(
      valid,
      JSON.stringify({ mcpServers: { fresh: { command: "mcp" } } }),
    );
    await fs.writeFile(bad, "not json");
    await fs.writeFile(huge, " ".repeat(1024 * 1024 + 1));
    await fs.symlink(valid, link);
    let current: Record<string, unknown> = {};
    let allowed = true;
    const review = new LocalMcpReview({
      owner: () => "owner",
      current: () => current,
      managedNames: () => [],
      allowed: () => allowed,
      update: () => assert.fail("unexpected write"),
      sources: () =>
        [bad, huge, link, valid].map((file) => ({
          name: path.basename(file),
          path: file,
        })),
    });
    const discovery = await review.discover();
    assert.deepEqual(
      discovery.sources.map((source) => source.state),
      ["error", "error", "error", "read"],
    );
    assert.equal(discovery.candidates.length, 1);
    current = { FRESH: { command: "new-config" } };
    assert.throws(
      () =>
        review.import({
          token: discovery.token,
          ids: [discovery.candidates[0].id],
        }),
      /name is now in use/,
    );
    current = {};
    allowed = false;
    assert.throws(
      () =>
        review.import({
          token: discovery.token,
          ids: [discovery.candidates[0].id],
        }),
      /changed/,
    );
    assert.equal((await review.discover()).candidates[0].state, "managed");
    assert.equal(localMcpSources(root, "darwin").length, 3);
    assert.equal(
      localMcpSources(root, "darwin")[1].path,
      path.join(root, ".claude.json"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP log endpoint is name scoped to its owner and policy; hosted discovery never reads local files", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const config = { docs: { command: "mcp" } };
  const logs = new McpConnectionLogs(() => config);
  logs.record("docs", "ready");
  let policy = openPolicy;
  registerMcpSettingsHandlers(
    ((name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler)) as never,
    {
      store: { root: "/owner-a", settings: { mcpServers: config } },
      engine: {
        mcpLogs: logs,
        extensions: { reservedMcpServerNames: () => [] },
      },
      policy: () => policy,
      window: undefined,
    } as never,
  );
  const read = handlers.get("readMcpLogs")!;
  assert.equal((read("docs") as { lines: string[] }).lines.length, 1);
  assert.throws(() => read("../../secret"));
  assert.throws(() => read("missing"), /unavailable/);
  policy = { ...openPolicy, developerMcpEnabled: false };
  assert.throws(() => read("docs"), /unavailable/);
  assert.throws(() => handlers.get("discoverLocalMcp")!(), /desktop app/);
  assert.throws(() => handlers.get("importLocalMcp")!({}), /desktop app/);
});

test("MCP import refuses unapplied external config edits before merging a review", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const config = {
    error: undefined as string | undefined,
    reload() {
      this.error = "invalid external edit";
    },
    update() {
      assert.fail("must not overwrite unapplied edits");
    },
  };
  registerMcpSettingsHandlers(
    ((name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler)) as never,
    {
      store: { root: "/owner", settings: { mcpServers: {} } },
      engine: { extensions: { reservedMcpServerNames: () => [] } },
      policy: () => openPolicy,
      window: {},
      mcpConfig: config,
    } as never,
  );
  assert.throws(
    () =>
      handlers.get("importLocalMcp")!({
        token: "123e4567-e89b-42d3-a456-426614174000",
        ids: ["123e4567-e89b-42d3-a456-426614174001"],
      }),
    /unapplied changes/,
  );
});
