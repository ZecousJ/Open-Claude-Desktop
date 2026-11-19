import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { installedPluginLibrary } from "../../electron/official-ui/api/library-plugins";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { PluginCatalog } from "../../shared/collections-api";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-plugin-detail-"));
  const catalog: PluginCatalog = {
    marketplaces: [],
    loadErrors: [],
    plugins: [true, true, false].map((installed, index) => ({
      id: `notes-${index}@local`,
      name: `notes-${index}`,
      title: `Notes ${index}`,
      marketplace: "local",
      marketplacePath: root,
      installed,
      enabled: index === 0,
      installable: true,
      source: "local",
    })),
  };
  const rows = installedPluginLibrary(catalog);
  let owner = "owner",
    identity = 1,
    fail = false,
    malformed = false,
    changeAccount = false,
    changeSession = false;
  const calls: [string, unknown[]][] = [];
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({
        id: owner,
        email: "owner@example.invalid",
        name: "Owner",
      }),
      settings: () => ({}),
      sessionIdentity: () => identity,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method, args) => {
      calls.push([method, args]);
      if (method === "listPlugins") return catalog;
      assert.equal(method, "readPlugin");
      assert.equal(
        args[0],
        catalog.plugins[0].id,
        "resolve opaque id from owned installed catalog, never forward browser-supplied raw ids",
      );
      if (fail) throw Error("read failed /private/path");
      if (malformed) return { skills: [] };
      if (changeAccount) owner = "other";
      if (changeSession) identity++;
      return {
        description: "Full runtime description",
        skills: [{ name: "Research", description: "Find notes" }],
        apps: [],
        mcpServers: [{ name: "notes-server" }],
        hooks: 2,
      };
    },
    root,
    { modes: ["chat"] },
  );
  const base = `/api/organizations/${organizationUuid("owner")}/plugins`;
  return {
    run,
    calls,
    base,
    id: rows[0].id,
    catalog,
    query: (suffix = "/" + rows[0].id) =>
      run({ method: "GET", path: base + suffix }),
    fail() {
      fail = true;
    },
    malformed() {
      malformed = true;
    },
    changeAccount() {
      changeAccount = true;
    },
    changeSession() {
      changeSession = true;
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const json = (r: { body: Uint8Array }) =>
  JSON.parse(Buffer.from(r.body).toString());

test("plugin enabled list and installed detail use real runtime metadata without filesystem/config fabrication", async () => {
  const f = fixture();
  try {
    const list = await f.query("/list-plugins?enabled_only=true&limit=1000");
    assert.equal(list.status, 200);
    assert.equal(json(list).plugins.length, 1);
    assert.equal(json(list).plugins[0].id, f.id);
    assert.equal(json(list).has_more, false);
    const response = await f.query();
    assert.equal(response.status, 200);
    const data = json(response);
    assert.equal(data.id, f.id);
    assert.equal(data.enabled, true);
    for (const value of [data, json(list).plugins[0]]) {
      assert.equal(value.can_edit, false);
      assert.equal(value.can_toggle, false);
      assert.equal(value.can_remove, false);
      assert.equal("claudex_read_only" in value, false);
    }
    assert.equal(data.description, "Full runtime description");
    assert.deepEqual(data.skills, [
      { name: "Research", description: "Find notes" },
    ]);
    assert.deepEqual(data.mcp_servers, { "notes-server": null });
    assert.equal(data.version, null);
    assert.equal(data.updated_at, null);
    assert.equal(
      "hooks" in data,
      false,
      "count alone is not actual hook configurations",
    );
    assert.equal(
      Buffer.from(response.body).toString().includes("/private"),
      false,
    );
    assert.deepEqual(
      f.calls.map(([method]) => method),
      ["listPlugins", "listPlugins", "readPlugin"],
    );
  } finally {
    f.close();
  }
});

test("plugin metadata list pages installed entries and handles actual disabled state", async () => {
  const f = fixture();
  try {
    const first = await f.query("/list-plugins?limit=1");
    assert.equal(first.status, 200);
    assert.equal(json(first).has_more, true);
    const second = await f.query("/list-plugins?limit=1&offset=1");
    assert.equal(second.status, 200);
    assert.equal(json(second).has_more, false);
    assert.equal(json(second).plugins[0].enabled, false);
    assert.notEqual(json(first).plugins[0].id, json(second).plugins[0].id);
  } finally {
    f.close();
  }
});

test("plugin detail refuses foreign org, unknown IDs, unsupported queries and download/version/scan fabrication", async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await f.run({
          method: "GET",
          path: `${f.base.replace(organizationUuid("owner"), organizationUuid("other"))}/${f.id}`,
        })
      ).status,
      404,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.query("/plugin_000000000000000000000000")).status,
      404,
    );
    assert.equal(
      f.calls.some(([method]) => method === "readPlugin"),
      false,
    );
    for (const suffix of [
      "/list-plugins?limit=0",
      "/list-plugins?limit=1&limit=2",
      "/list-plugins?enabled_only=wrong",
      "/list-plugins?offset=-1",
      "/list-plugins?shared_only=true",
      `/${f.id}?partition_by=organization`,
    ])
      assert.ok((await f.query(suffix)).status >= 400);
    for (const suffix of [
      "/versions?page_size=100",
      "/scan-status",
      "/download?include_blocked=true&trigger=view",
    ])
      assert.equal((await f.query(`/${f.id}${suffix}`)).status, 501);
  } finally {
    f.close();
  }
});

for (const mode of [
  "fail",
  "malformed",
  "changeAccount",
  "changeSession",
] as const) {
  test(`plugin detail ${mode} does not return empty or stale success`, async () => {
    const f = fixture();
    try {
      f[mode]();
      const response = await f.query();
      assert.equal(response.status, 500);
      assert.equal(
        Buffer.from(response.body)
          .toString()
          .includes("Full runtime description"),
        false,
      );
      assert.equal(
        Buffer.from(response.body).toString().includes("/private"),
        false,
      );
    } finally {
      f.close();
    }
  });
}

test("plugin read module itself enforces owner/session and bounds without relying on runner wrapper", async () => {
  const { pluginReadRoute } =
    await import("../../electron/official-ui/api/plugin-read");
  const catalog: PluginCatalog = {
    marketplaces: [],
    loadErrors: [],
    plugins: [
      {
        id: "owned@local",
        name: "owned",
        title: "Owned",
        marketplace: "local",
        marketplacePath: "/private",
        installed: true,
        enabled: true,
        installable: true,
        source: "local",
      },
    ],
  };
  const id = installedPluginLibrary(catalog)[0].id;
  const base = `/api/organizations/${organizationUuid("owner")}/plugins/${id}`;
  const ordinary = {
    description: "private owned details",
    skills: [],
    apps: [],
    mcpServers: [],
    hooks: 0,
  };
  for (const mode of [
    "foreign",
    "signout",
    "account",
    "session",
    "retired",
    "large-catalog",
    "large-detail",
    "large-count",
    "bad-hooks",
    "aggregate",
    "encoded-size",
  ] as const) {
    let owner: string | undefined = "owner",
      identity = 1,
      current = true,
      calls = 0,
      status = 0,
      body = "";
    const ctx = {
      readOnly: true,
      account: () => (owner ? { id: owner } : undefined),
      sessionIdentity: () => identity,
      isCurrent: () => current,
      call: async (method: string) => {
        calls++;
        if (method === "listPlugins")
          return mode === "large-catalog"
            ? { ...catalog, plugins: Array(4097).fill(catalog.plugins[0]) }
            : catalog;
        if (mode === "account") owner = "other";
        if (mode === "session") identity++;
        if (mode === "retired") current = false;
        if (mode === "large-detail")
          return { ...ordinary, description: "x".repeat(20001) };
        if (mode === "large-count")
          return { ...ordinary, skills: Array(1001).fill({ name: "a" }) };
        if (mode === "bad-hooks") return { ...ordinary, hooks: -1 };
        if (mode === "aggregate")
          return {
            ...ordinary,
            skills: Array(100).fill({
              name: "a",
              description: "x".repeat(20000),
            }),
          };
        if (mode === "encoded-size")
          return {
            ...ordinary,
            skills: Array.from({ length: 50 }, (_, i) => ({
              name: String(i),
              description: "\u0001".repeat(16000),
            })),
          };
        return ordinary;
      },
    };
    if (mode === "signout") owner = undefined;
    const p =
      mode === "foreign"
        ? base.replace(organizationUuid("owner"), organizationUuid("other"))
        : base;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    };
    await pluginReadRoute(
      { method: "GET" } as any,
      res as any,
      p,
      new URL(p, "http://localhost"),
      ctx as any,
    );
    assert.equal(
      status,
      mode === "foreign"
        ? 404
        : mode === "signout"
          ? 401
          : mode === "encoded-size"
            ? 413
            : 500,
      mode,
    );
    assert.equal(body.includes("private owned details"), false, mode);
    if (mode === "foreign" || mode === "signout") assert.equal(calls, 0);
  }
});
