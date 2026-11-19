/** Actual native HTTP adapter and PluginService, with inert RPC only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import vm from "node:vm";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import { organizationUuid } from "../electron/official-ui/api/context";
import { PluginService } from "../electron/plugins/plugins";
function fixture(t: any, desktop = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-library-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let identity = {},
    owner = "synthetic",
    mode = "normal";
  const calls: string[] = [];
  const mutations: unknown[][] = [];
  let availableInstalled = false,
    availableEnabled = false;
  const service = new PluginService(
    async () => ({
      async call(method: string) {
        calls.push(method);
        if (mode === "fail") throw Error("PRIVATE_ERROR");
        if (mode === "retire") identity = {};
        if (mode === "switch") {
          owner = "other";
          identity = {};
        }
        if (method === "plugin/list")
          return {
            marketplaces: [
              {
                name: "inert-market",
                path: desktop
                  ? path.join(root, ".agents/plugins/marketplace.json")
                  : "/synthetic/marketplace.json",
                plugins:
                  mode === "empty"
                    ? []
                    : [
                        {
                          id: "alpha@inert-market",
                          name: "alpha",
                          installed: true,
                          enabled: true,
                          interface: { shortDescription: "Synthetic alpha" },
                        },
                        {
                          id: "beta@inert-market",
                          name: "beta",
                          installed: true,
                          enabled: false,
                        },
                        {
                          id: "available@inert-market",
                          name: "available",
                          installed: availableInstalled,
                          enabled: availableEnabled,
                          ...(desktop ? { source: { type: "local" } } : {}),
                        },
                      ],
              },
            ],
            marketplaceLoadErrors:
              mode === "partial" ? [{ message: "PRIVATE_PATH" }] : [],
          };
        assert.equal(method, "plugin/read");
        return {
          plugin: {
            description: "Inert details",
            skills: [{ name: "sample", description: "Read only" }],
            apps: [],
            mcpServers: [{ name: "inert-mcp" }],
            hooks: [],
          },
        };
      },
    }),
    desktop ? () => root : undefined,
  );
  const api = createNativeAccountApi({
    root: path.resolve("build/official-ui"),
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => true,
    log() {},
    ...(desktop
      ? {
          localCall: async (method: string, id: string, enabled?: boolean) => {
            mutations.push([method, id, enabled]);
            assert.equal(id, "available@inert-market");
            if (method === "installPlugin") {
              availableInstalled = true;
              availableEnabled = true;
            } else {
              assert.equal(method, "setNativePluginEnabled");
              assert.equal(availableInstalled, true);
              availableEnabled = enabled === true;
            }
          },
        }
      : {}),
    call: async (method: string, ...args: unknown[]) => {
      if (method === "listPlugins") return service.list();
      if (method === "readPlugin") return service.read(String(args[0]));
      assert.equal(method, "listSkills");
      return [];
    },
  } as any);
  return {
    calls,
    mutations,
    setMode(value: string) {
      mode = value;
    },
    async get(
      endpoint: string,
      org = organizationUuid("synthetic"),
      input?: unknown,
    ) {
      const req: any = Readable.from(
        input === undefined ? [] : [Buffer.from(JSON.stringify(input))],
      );
      req.method = input === undefined ? "GET" : "PUT";
      req.url = `/api/organizations/${org}/${endpoint}`;
      req.headers = {};
      let status = 0,
        body: any;
      try {
        assert.equal(
          await api(req, {
            writeHead(n: number) {
              status = n;
            },
            end(v: any) {
              body = JSON.parse(String(v));
            },
          } as any),
          true,
        );
      } catch {
        status = 409;
      }
      return { status, body };
    },
  };
}
function original(name: string) {
  const src = fs.readFileSync(
      "build/official-ui/ui/assets/v1/shared-m-0-DnMCTYBX.js",
      "utf8",
    ),
    a = src.indexOf(`function ${name}(`),
    b = src.indexOf("\nfunction ", a + 1);
  assert.ok(a >= 0);
  return src.slice(a, b).replace(/\nvar [\s\S]*$/, "");
}
test("native installed summary uses actual service membership including disabled, never available entries or private paths", async (t) => {
  const f = fixture(t),
    r = await f.get("library/mine?kind=plugin&limit=1000");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.items.map((x: any) => [x.name, x.viewer.installed.enabled]),
    [
      ["alpha", true],
      ["beta", false],
    ],
  );
  for (const row of r.body.items) {
    assert.equal(row.viewer.installed.can_toggle, false);
    assert.equal(row.components, undefined);
    assert.equal(row.version, null);
  }
  assert.doesNotMatch(
    JSON.stringify(r.body),
    /synthetic\/marketplace|installPath/,
  );
  assert.deepEqual(f.calls, ["plugin/list"]);
  const search = await f.get("library/mine?q=BETA&limit=50");
  assert.equal(search.status, 200);
  assert.equal(search.body.items[0].name, "beta");
  const grouped = await f.get(
    "library/mine?kind=skill&kind=plugin&limit=1000&group_by_kind=true",
  );
  assert.equal(grouped.status, 200);
  assert.equal(grouped.body.items.length, 2);
});
test("desktop Discover and Yours operate on the same local marketplace identity", async (t) => {
  const f = fixture(t, true);
  const org = organizationUuid("synthetic");
  const browse = await f.get(
    "library/discover/browse?sort=installs&include_added=true&limit=100",
  );
  assert.equal(browse.status, 200);
  assert.equal(browse.body.items.length, 1);
  const [item] = browse.body.items;
  assert.equal(item.name, "available");
  assert.equal(item.claudex_local_marketplace, true);
  assert.equal(item.viewer.installed, null);
  assert.equal(item.install_count, null);
  const detail = `plugins/${item.plugin.backend_id}`;
  assert.equal((await f.get(detail)).status, 200);
  assert.equal(
    (
      await f.get(detail + "/enabled", organizationUuid("other"), {
        enabled: true,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.get(detail + "/enabled", org, {
        enabled: true,
        pluginId: "outside",
      })
    ).status,
    400,
  );
  assert.deepEqual(f.mutations, []);
  const installed = await f.get(detail + "/enabled", org, { enabled: true });
  assert.equal(installed.status, 200);
  assert.equal(installed.body.id, item.id);
  assert.equal(installed.body.claudex_local_marketplace, true);
  const disabled = await f.get(detail + "/enabled", org, { enabled: false });
  assert.equal(disabled.body.enabled, false);
  const mine = await f.get("library/mine?kind=plugin");
  const row = mine.body.items.find(
    (entry: { id: string }) => entry.id === item.id,
  );
  assert.equal(row.viewer.installed.enabled, false);
  assert.equal(row.viewer.installed.can_remove, true);
  assert.equal(
    (await f.get(detail + "/enabled", org, { enabled: true })).body.enabled,
    true,
  );
  assert.equal(f.mutations.length, 3);
});
test("native detail uses original JP/H4 consumer contract and real readPlugin names only", async (t) => {
  const f = fixture(t),
    list = await f.get("library/mine?kind=plugin");
  const id = list.body.items[0].id;
  const c: any = { GS: () => false, ph: (e: any) => e };
  vm.createContext(c);
  for (const name of ["JP", "lT", "H4"]) vm.runInContext(original(name), c);
  const url = c.JP(organizationUuid("synthetic"), id);
  const result = await f.get(url.split("/").slice(4).join("/"));
  assert.equal(result.status, 200);
  assert.equal(c.H4(id)(result.body), result.body);
  assert.deepEqual(result.body.skills, [
    { name: "sample", description: "Read only" },
  ]);
  assert.deepEqual(result.body.mcp_servers, { "inert-mcp": null });
  assert.equal(result.body.can_toggle, false);
  assert.equal(result.body.can_remove, false);
  assert.deepEqual(f.calls, [
    "plugin/list",
    "plugin/list",
    "plugin/list",
    "plugin/read",
  ]);
});
test("empty inventory is real success; failure/partial catalog/retirement remain errors", async (t) => {
  for (const mode of ["empty", "fail", "partial", "retire", "switch"]) {
    const f = fixture(t);
    f.setMode(mode);
    const r = await f.get("library/mine?kind=plugin");
    assert.equal(
      r.status,
      mode === "empty"
        ? 200
        : mode === "retire" || mode === "switch"
          ? 409
          : 503,
    );
    if (mode === "empty") assert.deepEqual(r.body.items, []);
    else assert.doesNotMatch(JSON.stringify(r.body) ?? "", /PRIVATE/);
  }
  const f = fixture(t);
  assert.equal(
    (await f.get("library/mine?kind=plugin", organizationUuid("foreign")))
      .status,
    404,
  );
  assert.deepEqual(f.calls, []);
});
