import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installedPluginLibrary } from "../../electron/official-ui/api/library-plugins";
import type { PluginCatalog, PluginEntry } from "../../shared/collections-api";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";

function catalog(): PluginCatalog {
  const plugin: PluginEntry = {
    id: "notes@community",
    name: "notes",
    title: "Team notes",
    marketplace: "community",
    marketplacePath: "/private/marketplace",
    installed: true,
    enabled: false,
    installable: true,
    source: "git",
    description: "Search work notes",
    developer: "Community author",
    availableVersion: "99",
    installedVersion: "2",
  };
  return {
    marketplaces: [
      {
        name: "community",
        path: "/private/marketplace",
        plugins: 3,
        title: "Community catalog",
        lastUpdated: 999999,
      },
    ],
    plugins: [
      plugin,
      {
        ...plugin,
        id: "my-notes@personal",
        name: "my-notes",
        marketplace: "personal",
        personal: true,
        source: "local",
        enabled: true,
      },
      {
        ...plugin,
        id: "available@community",
        name: "available",
        installed: false,
      },
    ],
    loadErrors: [],
  };
}

test("plugin library exposes only actually installed entries, stable IDs and readonly state", () => {
  const input = catalog(),
    before = structuredClone(input);
  const rows = installedPluginLibrary(input);
  assert.equal(rows.length, 2);
  assert.deepEqual(input, before, "mapping must not mutate runtime catalog");
  assert.deepEqual(installedPluginLibrary(input), rows);
  for (const row of rows) {
    assert.match(row.id, /^plugin_[a-f0-9]{24}$/);
    assert.equal(row.plugin.backend_id, row.id);
    assert.equal(row.skill, null);
    assert.equal(row.viewer.added, true);
    assert.equal(row.viewer.installed.can_edit, false);
    assert.equal(row.viewer.installed.can_remove, false);
    assert.equal(row.viewer.installed.can_toggle, false);
  }
  assert.equal(rows[0].viewer.installed.enabled, false);
  assert.equal(rows[1].viewer.installed.enabled, true);
  assert.equal(JSON.stringify(rows).includes("/private"), false);
  assert.equal(
    rows.some((row) => row.name === "available"),
    false,
  );
});

test("plugin library preserves marketplace provenance without fabricating organization/author/timestamps", () => {
  const rows = installedPluginLibrary(catalog());
  assert.deepEqual(rows[0].plugin.partition_by, "marketplace");
  assert.equal(rows[0].provenance.source, "default");
  assert.equal(rows[0].provenance.marketplace_kind, "other_catalog");
  assert.equal(rows[0].provenance.author, "Community author");
  assert.equal(rows[0].provenance.marketplace_name, "community");
  assert.equal(rows[1].provenance.source, "personal");
  assert.equal(rows[1].plugin.partition_by, "account");
  for (const row of rows) {
    assert.equal(row.created_at, null);
    assert.equal(row.updated_at, null);
    assert.equal(row.version, "2");
    assert.equal(row.install_count, null);
    assert.equal(row.content_scan, null);
    assert.equal("components" in row, false);
  }
  const missing = catalog();
  delete missing.plugins[0].installedVersion;
  delete missing.plugins[0].developer;
  const row = installedPluginLibrary(missing)[0];
  assert.equal(row.version, null, "available version is not installed version");
  assert.equal(row.provenance.author, null);
});

test("plugin catalog load errors, malformed state and duplicate identities fail rather than pretend empty", () => {
  const broken = catalog();
  broken.loadErrors = ["cannot read /private/file"];
  assert.throws(
    () => installedPluginLibrary(broken),
    (error) => error instanceof Error && !error.message.includes("/private"),
  );
  assert.throws(() => installedPluginLibrary({} as PluginCatalog));
  const duplicate = catalog();
  duplicate.plugins.push({ ...duplicate.plugins[0] });
  assert.throws(() => installedPluginLibrary(duplicate), /duplicate/);
  const malformed = catalog();
  (malformed.plugins[0] as any).installed = "yes";
  assert.throws(() => installedPluginLibrary(malformed), /installation state/);
  assert.deepEqual(
    installedPluginLibrary({ marketplaces: [], plugins: [], loadErrors: [] }),
    [],
  );
});

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-plugin-library-"),
  );
  let inventory = catalog(),
    account = "owner",
    identity = 1,
    switchAccount = false,
    switchSession = false,
    failed = false;
  const calls: string[] = [];
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({
        id: account,
        name: "Owner",
        email: "owner@example.invalid",
      }),
      settings: () => ({}),
      sessionIdentity: () => identity,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method) => {
      calls.push(method);
      if (method === "listSkills") return [];
      assert.equal(method, "listPlugins");
      if (failed) throw Error("catalog service offline");
      if (switchAccount) account = "other";
      if (switchSession) identity++;
      return inventory;
    },
    root,
    { modes: ["chat"] },
  );
  const base = `/api/organizations/${organizationUuid("owner")}/library/mine`;
  return {
    run,
    calls,
    base,
    query: (query = "?kind=plugin&limit=1000") =>
      run({ method: "GET", path: base + query }),
    fail() {
      failed = true;
    },
    loadError() {
      inventory.loadErrors.push("offline");
    },
    switchAccount() {
      switchAccount = true;
    },
    switchSession() {
      switchSession = true;
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const json = (response: { body: Uint8Array }) =>
  JSON.parse(Buffer.from(response.body).toString());

test("actual runner plugin library reads installed catalog, filters q and pages stable identities", async () => {
  const f = fixture();
  try {
    const full = await f.query();
    assert.equal(full.status, 200);
    const all = json(full).items;
    assert.equal(all.length, 2);
    assert.ok(f.calls.includes("listPlugins"));
    const first = await f.query("?kind=plugin&limit=1");
    assert.equal(first.status, 200);
    const page = json(first);
    assert.equal(page.items.length, 1);
    assert.ok(page.next_cursor);
    const second = await f.query(
      `?kind=plugin&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,
    );
    assert.equal(second.status, 200);
    assert.deepEqual(
      [...page.items, ...json(second).items].map((row) => row.id),
      all.map((row: any) => row.id),
    );
    assert.equal(json(second).next_cursor, null);
    const searched = await f.query("?kind=plugin&q=my-notes");
    assert.equal(searched.status, 200);
    assert.deepEqual(
      json(searched).items.map((row: any) => row.name),
      ["my-notes"],
    );
    const recent = await f.query("?kind=plugin&sort=recent");
    assert.ok(
      recent.status >= 400,
      "installation date unknown: must not fabricate recent ordering",
    );
  } finally {
    f.close();
  }
});

test("actual runner plugin library rejects foreign org before catalog access", async () => {
  const f = fixture();
  try {
    const response = await f.run({
      method: "GET",
      path:
        f.base.replace(organizationUuid("owner"), organizationUuid("other")) +
        "?kind=plugin",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(f.calls, []);
  } finally {
    f.close();
  }
});

for (const change of [
  "fail",
  "loadError",
  "switchAccount",
  "switchSession",
] as const) {
  test(`actual runner plugin library ${change} cannot leak stale rows or return empty success`, async () => {
    const f = fixture();
    try {
      f[change]();
      const response = await f.query();
      assert.equal(response.status, change === "fail" || change === "loadError" ? 503 : 409);
      assert.equal(Array.isArray(json(response).items), false);
      assert.equal(
        Buffer.from(response.body).toString().includes("Team notes"),
        false,
      );
    } finally {
      f.close();
    }
  });
}

test("combined and untyped mine queries use real installed plugin inventory instead of dropping it", async () => {
  const f = fixture();
  try {
    for (const query of [
      "",
      "?kind=skill&kind=plugin&limit=1000",
      "?q=notes&limit=50",
    ]) {
      const response = await f.query(query);
      assert.equal(response.status, 200);
      assert.deepEqual(
        json(response).items.map((row: any) => row.name),
        ["notes", "my-notes"],
      );
    }
    assert.ok(f.calls.includes("listSkills"));
    assert.ok(f.calls.includes("listPlugins"));
    const shared = await f.query("?kind=plugin&source=organization");
    assert.equal(shared.status, 200);
    assert.deepEqual(
      json(shared).items,
      [],
      "third party must never become organization content",
    );
    const external = await f.query("?kind=plugin&source=default");
    assert.equal(external.status, 200);
    assert.deepEqual(
      json(external).items.map((row: any) => row.name),
      ["notes"],
    );
  } finally {
    f.close();
  }
});
