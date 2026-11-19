import test from "node:test";
import assert from "node:assert/strict";
import {
  approvedDirectoryReadRoute,
  directoryReadRoute,
  runtimeMarketplaceId,
} from "../../electron/official-ui/api/directory-read";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { PluginCatalog } from "../../shared/collections-api";

test("approved connector directory separates published MCP entries from the private marketplace", async () => {
  const entry = {
    id: "af43b000-0000-4000-8000-000000000001", kind: "mcp", name: "Notebook", slug: "notebook",
    description: "Search reference notes", url: "https://mcp.example.com/notes", added: "2026-10-30T08:00:00Z",
    tools: ["search"], isAuthless: true,
  };
  const plugin = { ...entry, kind: "plugin", id: "plugin", slug: "notebook-plugin",
    url: "https://example.com/notebook-plugin", tools: null };
  let answer: unknown = [entry, plugin];
  let owner = "one", fail = false, retire = false;
  const ctx = {
    account: () => ({ id: owner }),
    call: async (method: string) => {
      assert.equal(method, "listApprovedDirectory");
      if (fail) throw Error("Confidential upstream detail");
      if (retire) owner = "two";
      return answer;
    },
  } as unknown as Parameters<typeof approvedDirectoryReadRoute>[3];
  const query = async (path: string) => {
    let status = 0, body = "";
    await approvedDirectoryReadRoute({ method: "GET" } as Parameters<typeof approvedDirectoryReadRoute>[0], {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    } as Parameters<typeof approvedDirectoryReadRoute>[1], new URL(path, "http://localhost"), ctx);
    return { status, body: JSON.parse(body), raw: body };
  };
  const servers = await query("/api/directory/servers?q=reference");
  assert.equal(servers.status, 200);
  assert.deepEqual(servers.body.servers.map((item: { id: string }) => item.id), [entry.id]);
  const detail = await query("/api/directory/plugins?slug=notebook");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data[0].checks.review.by.type, "your_admin");
  assert.equal(detail.body.data[0].components[0].endpoint.url, entry.url);
  const publishedPlugin = await query("/api/directory/plugins?slug=notebook-plugin");
  assert.equal(publishedPlugin.status, 200);
  assert.equal(publishedPlugin.body.data[0].id, plugin.id);
  assert.deepEqual(publishedPlugin.body.data[0].components, []);
  assert.equal(publishedPlugin.body.data[0].links.homepage, plugin.url);
  assert.equal(publishedPlugin.body.data[0].installation.actions.install, false);
  assert.equal((await query("/api/directory/plugins?slug=missing")).body.data.length, 0);
  assert.equal((await query("/api/organizations/" + organizationUuid("two") + "/directory/plugins")).status, 404);
  const workspace = {
    title: "Workspace",
    description: "Your workspace name",
    placeholder: "notes",
    pattern: "^[a-z]+$",
  };
  for (const template of [
    "https://mcp.example.com/{workspace}",
    "https://mcp.example.com/${user_config.workspace}",
  ]) {
    answer = [{ ...entry, serverUrlType: "template", remoteUrlTemplate: template, remoteUserConfig: workspace }];
    const { status, body } = await query("/api/directory/plugins?slug=notebook");
    assert.equal(status, 200);
    assert.deepEqual(body.data[0].legacy, {
      verified_tier: "community",
      url_template: "https://mcp.example.com/${user_config.workspace}",
      user_config: { workspace },
    });
    assert.deepEqual(body.data[0].components[0].endpoint, { type: "user_provided_any_host" });
  }
  answer = [];
  assert.deepEqual((await query("/api/directory/servers")).body, { servers: [], next_cursor: null });
  fail = true;
  const unavailable = await query("/api/directory/servers");
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(unavailable.raw, /Confidential/);
  fail = false;
  retire = true;
  assert.equal((await query("/api/directory/servers")).status, 409);
});
function fixture() {
  let owner = "one",
    session = 1,
    fail = false,
    retired = false,
    change = "";
  const calls: string[] = [];
  const catalog: PluginCatalog = {
    marketplaces: [
      { name: "personal", path: "/private/catalog", plugins: 3 },
      { name: "remote", path: "/private/remote", plugins: 1 },
    ],
    loadErrors: [],
    plugins: [
      {
        id: "alpha@personal",
        name: "alpha",
        title: "Alpha research",
        marketplace: "personal",
        marketplacePath: "/private/catalog",
        installed: false,
        enabled: false,
        installable: true,
        source: "local",
        personal: true,
        description: "Research notes",
        availableVersion: "2",
        category: "research",
      },
      {
        id: "beta@personal",
        name: "beta",
        title: "Beta",
        marketplace: "personal",
        marketplacePath: "/private/catalog",
        installed: true,
        enabled: false,
        installable: false,
        source: "local",
        personal: true,
        installedVersion: "1",
        availableVersion: "3",
        category: "research",
      },
      {
        id: "gamma@personal",
        name: "gamma",
        title: "Gamma",
        marketplace: "personal",
        marketplacePath: "/private/catalog",
        installed: false,
        enabled: false,
        installable: true,
        source: "local",
        personal: true,
      },
      {
        id: "unknown@remote",
        name: "unknown",
        title: "Other catalog",
        marketplace: "remote",
        marketplacePath: "/private/remote",
        installed: false,
        enabled: false,
        installable: true,
        source: "git",
      },
    ],
  };
  const ctx: any = {
    readOnly: true,
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => session,
    isCurrent: () => !retired,
    call: async (name: string) => {
      calls.push(name);
      assert.equal(name, "listPlugins");
      if (fail) throw Error("private /path credentials");
      if (change === "owner") owner = "two";
      if (change === "session") session++;
      if (change === "retired") retired = true;
      return catalog;
    },
  };
  const base = `/api/organizations/${organizationUuid("one")}/library/discover/browse`;
  const query = async (
    search = "kind=plugin&source=personal",
    method = "GET",
    url = base,
  ) => {
    let status = 0,
      body = "";
    const res: any = {
      writeHead(s: number) {
        status = s;
      },
      end(s: string) {
        body = s;
      },
    };
    const handled = await directoryReadRoute(
      { method } as any,
      res,
      url,
      new URL(url + "?" + search, "http://localhost"),
      ctx,
    );
    return { handled, status, body: body ? JSON.parse(body) : null, raw: body };
  };
  return {
    catalog,
    ctx,
    calls,
    query,
    base,
    fail() {
      fail = true;
    },
    change(v: string) {
      change = v;
    },
    signout() {
      owner = "";
    },
  };
}
test("explicit personal discovery shows real available entries, not remote catalogs or fake installed state", async () => {
  const f = fixture();
  const r = await f.query();
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.items.map((x: any) => x.name),
    ["alpha", "gamma"],
  );
  const a = r.body.items[0];
  assert.equal(a.version, "2");
  assert.equal(a.viewer.added, false);
  assert.equal(a.viewer.installed, null);
  assert.equal(a.content_scan, null);
  assert.equal(a.provenance.source, "personal");
  assert.equal(a.provenance.marketplace_id, runtimeMarketplaceId("personal"));
  assert.doesNotMatch(r.raw, /private\/|verified_tier|anthropic|partner/);
});
test("installed inclusion preserves disabled state and unavailable mutations", async () => {
  const f = fixture();
  const r = await f.query("kind=plugin&source=personal&include_added=true");
  assert.equal(r.status, 200);
  const b = r.body.items.find((x: any) => x.name === "beta");
  assert.equal(b.viewer.added, true);
  assert.equal(b.viewer.installed.enabled, false);
  assert.equal(b.viewer.installed.can_toggle, false);
  assert.equal(b.viewer.installed.installation_preference, null);
  assert.equal(b.version, "3");
});
test("query/category/marketplace and stable bounded pages preserve exact results", async () => {
  const f = fixture();
  let r = await f.query(
    "kind=plugin&source=personal&q=RESEARCH&category=research",
  );
  assert.deepEqual(
    r.body.items.map((x: any) => x.name),
    ["alpha"],
  );
  const q = "kind=plugin&source=personal&include_added=true&limit=1";
  r = await f.query(q);
  assert.equal(r.body.items[0].name, "alpha");
  const cursor = r.body.next_cursor;
  r = await f.query(q + "&cursor=" + cursor);
  assert.equal(r.body.items[0].name, "beta");
  f.catalog.plugins[0].title = "changed";
  assert.equal((await f.query(q + "&cursor=" + cursor)).status, 409);
  assert.equal(
    (
      await f.query(
        "kind=plugin&source=personal&marketplace_id=" +
          runtimeMarketplaceId("remote"),
      )
    ).status,
    404,
  );
});
test("generic provider/skill/tier/ranking queries are not silently answered with a local subset", async () => {
  const f = fixture();
  for (const q of [
    "q=research&limit=50",
    "kind=plugin",
    "kind=skill&source=personal",
    "kind=plugin&kind=skill&source=personal",
    "kind=plugin&source=organization",
    "kind=plugin&source=personal&sort=trending",
  ])
    assert.equal((await f.query(q)).status, 501, q);
  for (const q of [
    "kind=plugin&source=personal&verified_tier=community",
    "kind=plugin&source=personal&limit=0",
    "kind=plugin&source=personal&source=personal",
    "kind=plugin&source=personal&include_added=yes",
  ])
    assert.equal((await f.query(q)).status, 400, q);
  assert.equal(f.calls.length, 0);
});
test("wrong org, signed out and nonGET do not read catalogs", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.query(
        undefined,
        "GET",
        f.base.replace(organizationUuid("one"), organizationUuid("two")),
      )
    ).status,
    404,
  );
  assert.equal((await f.query(undefined, "POST")).status, 405);
  f.signout();
  assert.equal((await f.query()).status, 401);
  assert.equal(f.calls.length, 0);
});
test("late owner/session retirement never returns discovery content", async () => {
  for (const reason of ["owner", "session", "retired"]) {
    const f = fixture();
    f.change(reason);
    const r = await f.query();
    assert.equal(r.status, 409);
    assert.doesNotMatch(r.raw, /Alpha|Research notes/);
  }
});
test("source failures and partial catalogs are errors, never false empty success", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.fail(),
    (f: ReturnType<typeof fixture>) =>
      f.catalog.loadErrors.push("private error"),
    (f: ReturnType<typeof fixture>) =>
      f.catalog.plugins.push(f.catalog.plugins[0]),
  ]) {
    const f = fixture();
    mutate(f);
    const r = await f.query();
    assert.equal(r.status, 503);
    assert.doesNotMatch(r.raw, /private error|credentials|items/);
  }
});
test("malformed and oversized available metadata is rejected before serialization", async () => {
  const f = fixture();
  f.catalog.plugins[0].availableVersion = "x".repeat(257);
  assert.equal((await f.query()).status, 500);
  const g = fixture();
  g.catalog.plugins[0].installed = "yes" as never;
  assert.equal((await g.query()).status, 500);
  const h = fixture();
  h.catalog.plugins = Array(4097).fill(h.catalog.plugins[0]);
  assert.equal((await h.query()).status, 500);
});

test("encoded response bound accounts for JSON escaping, not only raw catalog bytes", async () => {
  const f = fixture();
  f.catalog.plugins = Array.from({ length: 50 }, (_, i) => ({
    ...f.catalog.plugins[0],
    id: `p${i}@personal`,
    name: `p${i}`,
    description: "\u0001".repeat(18000),
  }));
  const r = await f.query("kind=plugin&source=personal&limit=1000");
  assert.equal(r.status, 413);
  assert.equal("items" in r.body, false);
});

test("actual runner preserves explicit discovery, unknown scope rejection and owner retirement", async (t) => {
  const [{ createRunnerOfficialAdapter }, fs, os, path] = await Promise.all([
    import("../../runner/src/official-ui-adapter"),
    import("node:fs"),
    import("node:os"),
    import("node:path"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "directory-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  let identity = 1,
    retire = false;
  const calls: string[] = [];
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({ id: "one", email: "one@example.invalid", name: "One" }),
      settings: () => ({}),
      sessionIdentity: () => identity,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method) => {
      calls.push(method);
      assert.equal(method, "listPlugins");
      if (retire) identity++;
      return f.catalog;
    },
    root,
    { modes: ["chat"] },
  );
  const personal = f.base + "?kind=plugin&source=personal";
  const result = await run({ method: "GET", path: personal });
  assert.equal(result.status, 200);
  assert.deepEqual(
    JSON.parse(Buffer.from(result.body).toString()).items.map(
      (x: any) => x.name,
    ),
    ["alpha", "gamma"],
  );
  const before = calls.length;
  assert.equal(
    (await run({ method: "GET", path: f.base + "?q=research&limit=50" }))
      .status,
    501,
  );
  assert.equal(calls.length, before);
  assert.equal(
    (
      await run({
        method: "GET",
        path: personal.replace(
          organizationUuid("one"),
          organizationUuid("two"),
        ),
      })
    ).status,
    404,
  );
  assert.equal(calls.length, before);
  retire = true;
  const changed = await run({ method: "GET", path: personal });
  assert.ok(changed.status >= 400);
  assert.doesNotMatch(
    Buffer.from(changed.body).toString(),
    /Alpha research|Research notes/,
  );
});
