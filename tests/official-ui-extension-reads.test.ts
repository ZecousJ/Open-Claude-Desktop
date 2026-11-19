import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtensionReads } from "../electron/official-ui/native/extensions-read";
import { fixtureRoute } from "../electron/official-ui/api/fixtures";
import type http from "node:http";
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      name: "example",
      version: "1.2.3",
      description: "actual manifest",
    }),
  );
  let owner: string | undefined = "owner",
    identity = 1,
    current = true;
  const entry = { id: "example", name: "Example", enabled: true };
  let list: unknown = [entry];
  let detail: unknown = { ...entry, values: { visible: "value" } };
  let servers: Record<string, Record<string, unknown>> = { example: { claudex_extension: root } };
  let before = async (_name: string) => {};
  const calls: string[] = [];
  const read = createExtensionReads({
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => identity,
    isCurrent: () => current,
    settings: () => ({ mcpServers: servers }),
    call: async (name: string, ...args: unknown[]) => {
      calls.push(name);
      await before(name);
      if (name === "desktopExtensions") return list;
      if (name === "clientPolicy") return { localMcpEditing: true };
      assert.equal(name, "desktopExtension");
      assert.equal(args[0], "example");
      return detail;
    },
  } as never);
  return {
    read,
    calls,
    manifest,
    setList: (v: unknown) => (list = v),
    setDetail: (v: unknown) => (detail = v),
    setServers: (v: typeof servers) => (servers = v),
    before: (v: typeof before) => (before = v),
    switch: () => (owner = "other"),
    activate: () => identity++,
    retire: () => (current = false),
    logout: () => (owner = undefined),
    entry,
  };
}
test("real extension inventory and settings retain actual manifest version and nonsecret values", async (t) => {
  const f = fixture(t);
  f.setDetail({ ...f.entry, values: { visible: "value" }, savedSecrets: ["token"] });
  const rows = await f.read.installed();
  assert.equal(rows[0].manifest.version, "1.2.3");
  assert.deepEqual(rows[0].settings.userConfig, { visible: "value" });
  assert.deepEqual(rows[0].settings.savedSecrets, ["token"]);
  assert.deepEqual(await f.read.settings("example"), {
    isEnabled: true,
    userConfig: { visible: "value" },
    savedSecrets: ["token"],
  });
  f.setList([]);
  assert.deepEqual(await f.read.installed(), []);
});
test("self-hosted extension lists are empty and directory packages are unavailable", async () => {
  for (const suffix of ["extensions", "installable_extensions", "extensions/example", "extensions/example/versions", "extensions/example/download"]) {
    let status = 0;
    let body = "";
    const res = {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    } as unknown as http.ServerResponse;
    const handled = await fixtureRoute({ method: "GET" } as http.IncomingMessage, res, `/api/organizations/test/dxt/${suffix}`);
    assert.equal(handled, true);
    if (suffix === "extensions" || suffix === "installable_extensions") {
      assert.equal(status, 200);
      assert.deepEqual(JSON.parse(body), { entries: [], total: 0 });
    } else {
      assert.equal(status, 404);
      assert.equal(JSON.parse(body).error.type, "not_found_error");
    }
  }
});
test("extension inventory preserves multiple selected paths", async (t) => {
  const f = fixture(t);
  f.setDetail({ ...f.entry, values: { folders: ["/first", "/second"] } });
  const rows = await f.read.installed();
  assert.deepEqual(rows[0].settings.userConfig, {
    folders: ["/first", "/second"],
  });
  assert.deepEqual(await f.read.settings("example"), {
    isEnabled: true,
    userConfig: { folders: ["/first", "/second"] },
  });
});
test("official extension identity resolves to its installed MCP server", async (t) => {
  const f = fixture(t);
  f.setServers({ example: { claudex_extension: path.dirname(f.manifest), claudex_extension_id: "local.mcpb.author.example" } });
  const rows = await f.read.installed();
  assert.equal(rows[0].id, "local.mcpb.author.example");
  assert.equal(f.read.resolve("local.mcpb.author.example"), "example");
  assert.deepEqual(await f.read.settings("local.mcpb.author.example"), {
    isEnabled: true,
    userConfig: { visible: "value" },
  });
  assert.throws(() => f.read.resolve("example"));
});
test("catalog/detail failures are visible errors rather than cached or empty success", async (t) => {
  const f = fixture(t);
  await f.read.installed();
  for (const method of ["desktopExtensions", "desktopExtension"]) {
    f.before(async (n) => {
      if (n === method) throw Error("source offline");
    });
    await assert.rejects(f.read.installed(), /source offline/);
  }
  f.before(async () => {});
  assert.equal((await f.read.installed()).length, 1);
});
test("malformed and duplicate source entries and damaged manifests reject", async (t) => {
  const f = fixture(t);
  for (const v of [
    null,
    {},
    [f.entry, f.entry],
    [{ ...f.entry, error: "corrupt" }],
  ]) {
    f.setList(v);
    await assert.rejects(f.read.installed());
  }
  f.setList([f.entry]);
  for (const v of ["not JSON", "{}", JSON.stringify({ name: "example" })]) {
    fs.writeFileSync(f.manifest, v);
    await assert.rejects(f.read.installed(), /could not be read/);
  }
  fs.rmSync(f.manifest);
  await assert.rejects(f.read.installed(), /could not be read/);
});
test("missing configuration or identity mismatch never becomes empty userConfig", async (t) => {
  const f = fixture(t);
  for (const v of [
    { ...f.entry },
    { ...f.entry, values: {}, id: "another" },
    { ...f.entry, values: {}, configurationUnavailable: "locked" },
    { ...f.entry, values: {}, enabled: false },
  ]) {
    f.setDetail(v);
    await assert.rejects(f.read.installed());
  }
});
test("catalog and detail late results are retired across account, reactivation and host retirement", async (t) => {
  for (const method of ["desktopExtensions", "desktopExtension"])
    for (const change of ["switch", "activate", "retire"] as const) {
      const f = fixture(t);
      f.before(async (n) => {
        if (n === method) f[change]();
      });
      await assert.rejects(f.read.installed(), /account changed/);
    }
  const f = fixture(t);
  f.before(async () => {
    f.activate();
  });
  await assert.rejects(f.read.settings("example"), /account changed/);
});
test("signed out, bad arguments, symlink and oversized manifests fail before success", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.read.installed("forged"));
  await assert.rejects(f.read.settings());
  f.logout();
  await assert.rejects(f.read.installed(), /Sign in/);
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  fs.writeFileSync(g.manifest, "x".repeat(256 * 1024 + 1));
  await assert.rejects(g.read.installed(), /could not be read/);
  fs.rmSync(g.manifest);
  fs.symlinkSync("other.json", g.manifest);
  await assert.rejects(g.read.installed(), /could not be read/);
});

test("administrator-blocked extensions remain listed while read failures stay visible", async (t) => {
  const f = fixture(t);
  const blocked = { ...f.entry, blockedReason: "Disabled by administrator", values: {}, savedSecrets: [], configurationUnavailable: "unavailable" };
  f.setList([blocked]);
  f.setDetail(blocked);
  assert.equal((await f.read.installed())[0].settings.orgBlockedReason, "Disabled by administrator");
  f.setDetail({ ...blocked, error: "unavailable" });
  await assert.rejects(f.read.installed());
});
