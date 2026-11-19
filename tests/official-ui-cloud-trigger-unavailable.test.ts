import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fixtureRoute } from "../electron/official-ui/api/fixtures";
import { cloudCodeTriggerRoute } from "../electron/official-ui/api/code-triggers";
import { organizationUuid } from "../electron/official-ui/api/context";
const sourceRoot =
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ??
  ".restore/archive-extracted/claude-frontend-4.4212.0";
const base = path.resolve(
  sourceRoot,
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE
    ? "src/cloud/assets/v1"
    : "dist/assets/v1",
);
const raw = (f: string) => fs.readFileSync(path.join(base, f), "utf8");
function fn(f: string, name: string) {
  const s = raw(f),
    a = s.search(new RegExp("(?:async )?function " + name + "\\("));
  assert.ok(a >= 0);
  const b = s.indexOf("\nfunction ", a + 1),
    c = s.indexOf("\nasync function ", a + 1);
  let end = Math.min(...[b, c].filter((x) => x >= 0));
  return s.slice(a, end).replace(/\nvar [\s\S]*$/, "");
}
async function response(p: string, method = "GET") {
  let status = 0,
    body = "",
    headers: any = {};
  const res: any = {
    writeHead(s: number, h: any) {
      status = s;
      headers = h;
    },
    end(b: any) {
      body = b ?? "";
    },
  };
  const url = new URL(p, "http://localhost");
  const req = {
    method,
    headers: { "x-organization-uuid": organizationUuid("inert") },
  } as any;
  const handled =
    (await cloudCodeTriggerRoute(req, res, url, {
      account: () => ({ id: "inert" }),
    } as any)) || (await fixtureRoute(req, res, url.pathname));
  return { handled, status, body, headers };
}
test("cloud trigger routes report an unavailable scheduler without returning fabricated rows", async () => {
  for (const [method, p] of [
    ["GET", "/v1/code/triggers"],
    ["POST", "/v1/code/triggers"],
    ["GET", "/v1/code/triggers/example"],
  ]) {
    const r = await response(p, method);
    assert.equal(r.status, 501);
    assert.equal(JSON.parse(r.body).error.type, "api_error");
    assert.equal("data" in JSON.parse(r.body), false);
  }
  const r = await response("/v1/code/sessions");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { data: [], has_more: false });
});
async function producer() {
  const c: any = {
    URLSearchParams,
    Set,
    Map,
    Promise,
    yn: () => ({}),
    LD: () => "/v1/code/triggers",
    L8: "cowork",
    ZR: (e: any) => e,
    dr: async () => ({}),
    v$: (e: any) => e,
    xT: class extends Error {
      status: number;
      constructor(_n: string, s: number, o: any) {
        super(o.serverMessage);
        this.status = s;
      }
    },
    mV: new WeakMap(),
    xC: new WeakMap(),
    A7: new WeakSet(),
    OC: { failed: false },
  };
  vm.createContext(c);
  for (const [f, names] of [
    ["shared-2-CuvP2TaI.js", ["Q2", "zu", "_e", "Ri"]],
    ["shared-4-Kt-jV-IU.js", ["p3", "OA", "DF"]],
  ] as const)
    for (const name of names) vm.runInContext(fn(f, name), c);
  const source = raw("shared-4-Kt-jV-IU.js");
  const block = source.match(
    /getAllScheduledTasks: async \(\) => \{[\s\S]*?\n        \},/,
  );
  assert.ok(block);
  vm.runInContext("combined=({" + block[0] + "}).getAllScheduledTasks", c);
  let calls = 0;
  c.o = () =>
    c.Q2({
      orgUuid: "inert",
      rawFetch: async (url: string) => {
        calls++;
        const u = new URL(url, "http://localhost");
        assert.equal(u.pathname, "/v1/code/triggers");
        assert.equal(u.searchParams.get("limit"), "100");
        const r = await response(url);
        return new Response(r.body, { status: r.status, headers: r.headers });
      },
    });
  return { c, calls: () => calls };
}
const captured = {
  skip:
    !fs.existsSync(path.join(base, "shared-2-CuvP2TaI.js")) &&
    "Pinned frontend assets are required.",
};
test(
  "actual pinned Q2 and combination reject remote failure with empty local list, not false No tasks",
  captured,
  async () => {
    const f = await producer();
    f.c.a = async () => [];
    await assert.rejects(f.c.combined(), (e: any) => e.status === 501);
    assert.equal(f.calls(), 1);
    const source = raw("shared-4-Kt-jV-IU.js");
    assert.match(source, /didFail: !x && h.failed/);
    assert.match(source, /Hy\(e, Sk, !0, e.hiddenFrom\)/);
  },
);
test(
  "actual pinned combination preserves valid local tasks and marks remote list partial",
  captured,
  async () => {
    const f = await producer();
    const local = { id: "synthetic-local", enabled: true, source: "local" };
    f.c.a = async () => [local];
    const rows = await f.c.combined();
    assert.equal(rows.length, 1);
    assert.equal(rows[0], local);
    assert.equal(f.c.A7.has(rows), true);
    assert.equal(f.c.DF(rows, "inert").cloudFailed, true);
    assert.equal(f.calls(), 1);
    assert.ok(
      raw("ccd3f68fe-DT9Tj03J.js").includes("load cloud scheduled tasks."),
    );
  },
);
