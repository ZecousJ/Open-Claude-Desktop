/** Adapter-only sharing tests; never create/revoke an external link. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { sharingRoute } from "../electron/official-ui/api/sharing";
import { organizationUuid } from "../electron/official-ui/api/context";
function fixture() {
  let owner = "a",
    identity = 1,
    current = true;
  let list: any = [
    { id: "snapshot-a", kind: "conversation", sourceKey: "conversation-a" },
    { id: "snapshot-b", kind: "conversation", sourceKey: "conversation-a" },
  ];
  let fail = "",
    retireOn = "";
  const calls: { method: string; args: unknown[] }[] = [];
  const ctx: any = {
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => identity,
    isCurrent: () => current,
    call: async (method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      if (retireOn === method) identity++;
      if (fail === method) throw Error("private key/path upstream failure");
      if (method === "hostedShares") return list;
      if (method === "revokeShare") {
        list = list.filter((s: any) => s.id !== args[0]);
        return;
      }
      throw Error("unexpected " + method);
    },
  };
  async function run(
    method = "DELETE",
    org = organizationUuid("a"),
    body = "",
    id = "snapshot-a",
    query = "",
  ) {
    const p = `/api/organizations/${org}/share/${id}`;
    const req: any = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = p + query;
    req.headers = {};
    let status = 0,
      data: any;
    const res: any = {
      writeHead(s: number) {
        status = s;
      },
      end(v?: string) {
        data = v ? JSON.parse(v) : undefined;
      },
    };
    await sharingRoute(req, res, p, ctx);
    return { status, data };
  }
  return {
    ctx,
    run,
    calls,
    list: () => list,
    setList(v: any) {
      list = v;
    },
    fail(v: string) {
      fail = v;
    },
    retire(v: string) {
      retireOn = v;
    },
    owner(v: string) {
      owner = v;
    },
    stale() {
      current = false;
    },
  };
}
test("successful revoke targets one owned snapshot and never conversation-wide unshare", async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 204);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["hostedShares", "revokeShare"],
  );
  assert.deepEqual(f.calls[1].args, ["snapshot-a"]);
  assert.deepEqual(
    f.list().map((s: any) => s.id),
    ["snapshot-b"],
  );
});
test("source failure, null/missing/ambiguous source never produces false204 or dispatches revoke", async () => {
  for (const kind of ["error", "null", "empty", "duplicate"]) {
    const f = fixture();
    if (kind === "error") f.fail("hostedShares");
    if (kind === "null") f.setList(null);
    if (kind === "empty") f.setList([]);
    if (kind === "duplicate")
      f.setList([{ id: "snapshot-a" }, { id: "snapshot-a" }]);
    const r = await f.run();
    assert.ok(r.status >= 400);
    assert.equal(f.calls.filter((c) => c.method === "revokeShare").length, 0);
    assert.doesNotMatch(JSON.stringify(r.data), /private key/);
  }
});
test("backend revoke failure keeps current link and never reports success", async () => {
  const f = fixture();
  f.fail("revokeShare");
  const r = await f.run();
  assert.equal(r.status, 503);
  assert.ok(f.list().some((s: any) => s.id === "snapshot-a"));
  assert.doesNotMatch(JSON.stringify(r.data), /private key/);
});
test("method org signed-out readonly query and malformed id refuse before source calls", async () => {
  for (const kind of [
    "method",
    "org",
    "logout",
    "readonly",
    "query",
    "id",
    "stale",
  ]) {
    const f = fixture();
    if (kind === "logout") f.owner("");
    if (kind === "readonly") f.ctx.readOnly = true;
    if (kind === "stale") f.stale();
    const r = await f.run(
      kind === "method" ? "GET" : "DELETE",
      kind === "org" ? organizationUuid("b") : organizationUuid("a"),
      "",
      kind === "id" ? "bad%2Fid" : "snapshot-a",
      kind === "query" ? "?all=true" : "",
    );
    assert.ok(r.status >= 400);
    assert.equal(f.calls.length, 0);
  }
});
test("unexpected body is rejected without source mutation", async () => {
  const f = fixture();
  assert.ok((await f.run("DELETE", undefined, "{}")).status >= 400);
  assert.equal(f.calls.length, 0);
});
test("activation retirement after list prevents revoke; after revoke reports unknown notsuccess", async () => {
  for (const at of ["hostedShares", "revokeShare"]) {
    const f = fixture();
    f.retire(at);
    const r = await f.run();
    assert.equal(r.status, 409);
    assert.equal(
      f.calls.filter((c) => c.method === "revokeShare").length,
      at === "hostedShares" ? 0 : 1,
    );
  }
});
test("original consumer snapshotUuid envelope revokes the exact URL snapshot", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.run(
        "DELETE",
        undefined,
        JSON.stringify({ snapshotUuid: "snapshot-a" }),
      )
    ).status,
    204,
  );
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["hostedShares", "revokeShare"],
  );
  assert.deepEqual(f.calls[1].args, ["snapshot-a"]);
});
test("mismatched, extended, malformed and oversized revoke envelopes never dispatch", async () => {
  for (const body of [
    JSON.stringify({ snapshotUuid: "snapshot-b" }),
    JSON.stringify({ snapshotUuid: "snapshot-a", all: true }),
    JSON.stringify({ snapshotUuid: 42 }),
    "null",
    "[]",
    "{",
    "x".repeat(257),
  ]) {
    const f = fixture();
    assert.ok((await f.run("DELETE", undefined, body)).status >= 400);
    assert.deepEqual(f.calls, []);
  }
});
