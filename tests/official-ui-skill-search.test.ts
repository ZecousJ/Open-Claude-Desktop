/** Actual native adapter + original consumer functions. Synthetic skills only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Readable } from "node:stream";
import { createNativePluginReads } from "../electron/official-ui/native/plugin-reads";
import { installedSkillSearch } from "../electron/official-ui/api/skill-search";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import { organizationUuid } from "../electron/official-ui/api/context";
function fixture(t: any, readOnly = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let identity: unknown = {},
    owner = "synthetic",
    active = true,
    hook: undefined | (() => void),
    fail = false,
    reads = 0;
  const names = ["openai-docs", "中文技能", "alpha", "beta", "gamma", "delta"];
  const skills = names.map((name, i) => {
    const file = path.join(root, String(i), "SKILL.md");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      file,
      `---\nname: ${name}\n---\nInert instructions, never executed.\n`,
    );
    return {
      path: file,
      name,
      description: i === 1 ? "Unicode 搜索示例" : "Synthetic description",
      scope: "user",
      enabled: i !== 2,
    };
  });
  const api = createNativeAccountApi({
    root: path.resolve("build/official-ui"),
    readOnly,
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => active,
    log() {},
    call: async (method: string) => {
      if (method === "listPlugins")
        return { marketplaces: [], plugins: [], loadErrors: [] };
      assert.equal(method, "listSkills");
      reads++;
      hook?.();
      if (fail) throw Error("PRIVATE_SOURCE_ERROR");
      return [{ skills }];
    },
  } as any);
  return {
    skills,
    get reads() {
      return reads;
    },
    setHook(fn: () => void) {
      hook = fn;
    },
    retire() {
      identity = {};
    },
    switch() {
      owner = "other";
      identity = {};
    },
    fail() {
      fail = true;
    },
    async request(
      query: string,
      endpoint = "library/mine",
      org = organizationUuid("synthetic"),
    ) {
      const req: any = Readable.from([]);
      req.method = "GET";
      req.headers = {};
      req.url = `/api/organizations/${org}/${endpoint}${query}`;
      let status = 0,
        body: any;
      try {
        const handled = await api(req, {
          writeHead(n: number) {
            status = n;
          },
          end(v: any) {
            body = JSON.parse(String(v));
          },
        } as any);
        return { status: handled ? status : 501, body };
      } catch {
        return { status: 409, body: undefined };
      }
    },
  };
}
test("installed lists use the same original grouping and pagination on both hosts", async (t) => {
  for (const readOnly of [false, true]) {
    const f = fixture(t, readOnly);
    Object.assign(f.skills[0], { interface: { displayName: "Friendly skill title" } });
    f.skills[1].scope = "system";
    f.skills[2].scope = "admin";
    const first = await f.request("?kind=plugin&kind=skill&limit=1&group_by_kind=true");
    assert.equal(first.status, 200);
    assert.equal(first.body.total_count, 6);
    assert.equal(first.body.items[0].name, "openai-docs");
    assert.equal(first.body.items[0].display_name, "Friendly skill title");
    assert.equal(first.body.items[0].viewer.installed.can_toggle, !readOnly);
    const next = await f.request("?kind=plugin&kind=skill&limit=1&group_by_kind=true&cursor=" +
      encodeURIComponent(first.body.next_cursor));
    assert.equal(next.body.items[0].provenance.source, "default");
    assert.equal(next.body.items[0].provenance.creator_type, "anthropic");
    const managed = await f.request("?kind=skill&source=organization");
    assert.equal(managed.body.items[0].provenance.creator_type, "organization");
    const search = await f.request("?kind=skill&q=Friendly");
    assert.deepEqual(search.body.items.map((item: { name: string }) => item.name), ["openai-docs"]);
    f.fail();
    assert.equal((await f.request("?kind=skill")).status, 503);
  }
});
test("native installed search preserves real rows and supports case, spaces, Unicode and no match", async (t) => {
  const f = fixture(t);
  assert.equal((await f.request("?kind=skill")).body.items.length, 6);
  for (const q of ["openai-docs", "  OPENAI-DOCS  "]) {
    const r = await f.request("?q=" + encodeURIComponent(q) + "&limit=50");
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.items.map((i: any) => i.name),
      ["openai-docs"],
    );
    assert.equal(r.body.items[0].viewer.installed.can_toggle, true);
  }
  assert.equal(
    (await f.request("?kind=skill&q=" + encodeURIComponent("搜索"))).body
      .items[0].name,
    "中文技能",
  );
  assert.equal((await f.request("?q=missing")).body.items.length, 0);
  assert.equal((await f.request("?q=%20%20")).body.items.length, 6);
});
test("search pagination is bounded and scoped to actual query results", async (t) => {
  const f = fixture(t),
    r = await f.request("?q=&sort=name&limit=2");
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.total_count, 6);
  assert.ok(r.body.next_cursor);
  const updated = new Date(Date.now() + 30_000);
  fs.utimesSync(f.skills[0].path, updated, updated);
  const next = await f.request(
    "?q=&sort=name&limit=2&cursor=" + encodeURIComponent(r.body.next_cursor),
  );
  assert.equal(next.status, 200);
  assert.notEqual(next.body.items[0].id, r.body.items[0].id);
  assert.equal(
    (
      await f.request(
        "?q=alpha&sort=name&limit=2&cursor=" +
          encodeURIComponent(r.body.next_cursor),
      )
    ).status,
    409,
  );
});
test("invalid parameters and foreign organization cannot read skill inventory", async (t) => {
  const f = fixture(t);
  for (const q of [
    "?q=a&q=b",
    "?q=a&limit=0",
    "?q=a&limit=1001",
    "?q=a&sort=unknown",
    "?q=a&path=/tmp/private",
    "?q=a&source=unknown",
    "?q=" + "x".repeat(2001),
  ])
    assert.equal((await f.request(q)).status, 400, q);
  assert.equal((await f.request("?q=a&kind=unsupported")).status, 501);
  assert.equal(
    (await f.request("?q=a", "library/mine", organizationUuid("foreign")))
      .status,
    404,
  );
  assert.equal(f.reads, 0);
});
test("retirement and read failure remain errors, never successful empty search", async (t) => {
  for (const action of ["retire", "switch"] as const) {
    const f = fixture(t);
    f.setHook(() => f[action]());
    assert.equal((await f.request("?q=openai-docs")).status, 409);
  }
  const f = fixture(t);
  f.fail();
  const r = await f.request("?q=openai-docs");
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE_SOURCE_ERROR/);
});
function original(file: string, name: string) {
  const s = fs.readFileSync(
    path.join("build/official-ui/ui/assets/v1", file),
    "utf8",
  );
  const a = s.indexOf(`function ${name}(`),
    b = s.indexOf("\nfunction ", a + 1);
  assert.ok(a >= 0);
  return s.slice(a, b < 0 ? undefined : b).replace(/\nvar [\s\S]*$/, "");
}
test("actual original Skills search separates Discover from installed Yours; fixture is not real discovery", async (t) => {
  const f = fixture(t),
    builders: any = { URLSearchParams };
  vm.createContext(builders);
  vm.runInContext(
    original("shared-m-0-DnMCTYBX.js", "bf") +
      "\n" +
      original("shared-m-0-DnMCTYBX.js", "ZJ"),
    builders,
  );
  const org = organizationUuid("synthetic"),
    mine = builders.bf(org, { q: "openai-docs", limit: 50 }),
    discovery = builders.ZJ(org, { q: "openai-docs", limit: 50 });
  assert.equal(
    (await f.request(new URL(mine, "http://inert").search)).status,
    200,
  );
  const catalog = await f.request(
    new URL(discovery, "http://inert").search,
    "library/discover/browse",
  );
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body, { items: [], next_cursor: null });
  const stop = {},
    seen: any[] = [];
  const c: any = {
    J9: () => [],
    Oe: () => false,
    pe: () => false,
    Fa: (_q: any, opts: any) => {
      seen.push(opts.enabled);
      throw stop;
    },
  };
  for (let i = 0; i <= 5; i++) {
    c["J" + i] = () => true;
    c["K" + i] = (...args: any[]) => args.at(-1);
  }
  vm.createContext(c);
  vm.runInContext(original("c979ed9d0-C-llIJ0y.js", "La"), c);
  for (const capable of [true, false])
    try {
      c.La({
        search: {
          query: "openai-docs",
          serverQ: "openai-docs",
          settledQ: "openai-docs",
        },
        catalogCapable: capable,
      });
    } catch (e) {
      assert.equal(e, stop);
    }
  assert.deepEqual(seen, [true, false]);
});

test("search diagnostics contain fixed route/status only and cannot alter outcomes", async () => {
  const messages: unknown[][] = [],
    identity = {},
    ctx: any = {
      account: () => ({ id: "synthetic" }),
      sessionIdentity: () => identity,
      stateDirectory: () => "/inert",
      isCurrent: () => true,
      log: (...args: unknown[]) => messages.push(args),
    };
  let status = 0;
  const res: any = {
    writeHead(n: number) {
      status = n;
    },
    end() {},
  };
  await installedSkillSearch(
    res,
    new URL(
      `http://inert/api/organizations/${organizationUuid("synthetic")}/library/mine?q=PRIVATE_QUERY`,
    ),
    ctx,
    async () => [],
  );
  assert.equal(status, 200);
  const reads = createNativePluginReads(ctx, (code) =>
    Object.assign(new Error("Fixed refusal"), { code }),
  );
  assert.throws(() => reads.getPlugins(), {
    code: "plugin_inventory_unavailable",
  });
  assert.throws(() => reads.getDownloadedRemotePlugins(), {
    code: "remote_plugin_inventory_unavailable",
  });
  assert.deepEqual(messages, [
    ["[skill-search] library.mine", { status: 200 }],
    ["[skill-search] LocalPlugins.getPlugins", { outcome: "unsupported" }],
    [
      "[skill-search] LocalPlugins.getDownloadedRemotePlugins",
      { outcome: "unsupported" },
    ],
  ]);
  ctx.log = () => {
    throw Error("PRIVATE_LOG_FAILURE");
  };
  await installedSkillSearch(
    res,
    new URL(
      `http://inert/api/organizations/${organizationUuid("synthetic")}/library/mine?q=PRIVATE_QUERY`,
    ),
    ctx,
    async () => [],
  );
  assert.equal(status, 200);
  assert.throws(() => reads.getPlugins(), {
    code: "plugin_inventory_unavailable",
  });
});
