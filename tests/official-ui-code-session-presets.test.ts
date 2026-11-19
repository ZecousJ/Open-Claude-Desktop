import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { registerCodeSessionPresets } from "../electron/official-ui/native/code-session-presets";
import type { NativeHandler } from "../electron/official-ui/native/host";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

function profile(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-presets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(root: string | undefined, initialOwner = first) {
  let owner: string | undefined = initialOwner;
  let current = true;
  const handlers = new Map<string, NativeHandler>();
  registerCodeSessionPresets({
    ctx: {
      account: () => (owner ? { id: owner, name: "", email: "" } : undefined),
      stateDirectory: () => root,
      isCurrent: () => current,
      log() {},
    },
    on: (op: string, handler: NativeHandler) => handlers.set(op, handler),
  } as never);
  return {
    load: (id: unknown) => handlers.get("LocalSessionPresets.load")!(id),
    replaceAll: (id: unknown, catalog: unknown) =>
      handlers.get("LocalSessionPresets.replaceAll")!(id, catalog),
    activate: (id: string | undefined) => {
      owner = id;
    },
    retire: () => {
      current = false;
    },
  };
}

test("native presets persist the canonical renderer payload before acknowledging", (t) => {
  const root = profile(t);
  const host = fixture(root);
  const catalog = {
    presets: [
      {
        id: "local",
        name: "Workspace",
        target: { kind: "local", cwd: "/work", additionalFolders: ["/shared"] },
        settings: { worktree: true, effort: "high" },
      },
      {
        id: "ssh",
        name: "Build host",
        target: { kind: "ssh", sshConfigId: "build-host", cwd: null },
      },
    ],
    builtIns: { local: { settings: { permissionMode: "acceptEdits" } } },
    seededFromDraft: false,
  };

  assert.deepEqual(host.load(first), { presets: [] });
  assert.deepEqual(
    host.replaceAll(first, { ...catalog, placeDefaults: { local: {} } }),
    { success: true },
  );
  const accounts = path.join(root, "official-ui", "accounts");
  const [accountFolder] = fs.readdirSync(accounts);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(accounts, accountFolder, "code-session-presets.json"),
        "utf8",
      ),
    ),
    catalog,
  );
  const restarted = fixture(root);
  assert.deepEqual(restarted.load(first), catalog);

  restarted.activate(second);
  assert.equal(restarted.load(first), null);
  assert.throws(
    () => restarted.replaceAll(first, { presets: [] }),
    /identity is unresolved/,
  );
  assert.deepEqual(restarted.load(second), { presets: [] });
  assert.deepEqual(
    restarted.replaceAll(second, { presets: [{ id: "second" }] }),
    { success: true },
  );

  restarted.activate(first);
  assert.deepEqual(restarted.load(first), catalog);
  assert.deepEqual(restarted.replaceAll(first, { presets: [] }), {
    success: true,
  });
  assert.deepEqual(fixture(root).load(first), { presets: [] });
  assert.deepEqual(fixture(root, second).load(second), {
    presets: [{ id: "second" }],
  });
});

test("native presets bound rows and UTF-8 bytes and retain the last accepted catalog", (t) => {
  const host = fixture(profile(t));
  const catalog = { presets: Array.from({ length: 200 }, () => ({})) };
  assert.deepEqual(host.replaceAll(first, catalog), { success: true });
  assert.throws(
    () => host.replaceAll(first, { presets: [...catalog.presets, {}] }),
    /Too many session presets/,
  );
  assert.throws(
    () => host.replaceAll(first, { presets: [{ name: "预".repeat(175_000) }] }),
    /catalog is too large/,
  );
  for (const invalid of [
    { presets: [null] },
    { presets: [], builtIns: [] },
    { presets: [], seededFromDraft: "true" },
  ])
    assert.throws(
      () => host.replaceAll(first, invalid),
      /Malformed session preset catalog/,
    );
  assert.deepEqual(host.load(first), catalog);
});

test("native presets never acknowledge a write without an active account and working storage", (t) => {
  const root = profile(t);
  const catalog = { presets: [] };
  const signedOut = fixture(root);
  signedOut.activate(undefined);
  const retired = fixture(root);
  retired.retire();
  for (const host of [signedOut, retired, fixture(undefined)]) {
    assert.equal(host.load(first), null);
    assert.throws(
      () => host.replaceAll(first, catalog),
      /identity is unresolved/,
    );
  }

  const unavailableRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(unavailableRoot, "unavailable");
  const blocked = fixture(unavailableRoot);
  assert.equal(blocked.load(first), null);
  assert.throws(() => blocked.replaceAll(first, catalog));
  assert.equal(fs.readFileSync(unavailableRoot, "utf8"), "unavailable");
});
