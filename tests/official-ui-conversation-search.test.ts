/** REST adapter fixtures only: no actual account search or external requests. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  conversationSearchRoute,
  conversationSearchMatches,
} from "../electron/official-ui/api/conversation-search";
import { organizationUuid } from "../electron/official-ui/api/context";
function fixture() {
  let owner = "a",
    activation = 1,
    current = true;
  let inventory: any = [
    {
      id: "chat-a",
      mode: "chat",
      title: "😀 Search title",
      createdAt: 1,
      updatedAt: 2,
      turns: [],
      model: "model-a",
    },
  ];
  let source: any = {
    results: [
      {
        conversationId: "chat-a",
        mode: "chat",
        title: "😀 Search title",
        updatedAt: 2,
        archived: false,
        snippet: "😀 Search body",
      },
    ],
  };
  let fail = "",
    retire = "";
  const calls: any[] = [];
  const ctx: any = {
    readOnly: true,
    account: () => (owner ? { id: owner } : undefined),
    sessionIdentity: () => activation,
    isCurrent: () => current,
    listConversations: async () => {
      calls.push(["inventory"]);
      if (retire === "inventory") activation++;
      if (fail === "inventory") throw Error("private source detail");
      return inventory;
    },
    call: async (method: string, ...args: any[]) => {
      calls.push([method, ...args]);
      assert.equal(method, "searchConversations");
      if (retire === "search") activation++;
      if (fail === "search") throw Error("private source detail");
      return source;
    },
  };
  async function run(
    body: any = { query: "Search", n: 50, target_snippet_size: 200 },
    method = "POST",
    org = organizationUuid("a"),
    query = "",
  ) {
    const p = `/api/organizations/${org}/conversation/search/v2`;
    const req: any = Readable.from([
      Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    ]);
    req.method = method;
    req.url = p + query;
    req.headers = {};
    let status = 0,
      data: any;
    const res: any = {
      writeHead: (s: number) => (status = s),
      end: (s: string) => (data = JSON.parse(s)),
    };
    assert.equal(await conversationSearchRoute(req, res, p, ctx), true);
    return { status, data };
  }
  return {
    run,
    ctx,
    calls,
    source: () => source,
    inventory: () => inventory,
    setSource: (v: any) => (source = v),
    setInventory: (v: any) => (inventory = v),
    fail: (v: string) => (fail = v),
    retire: (v: string) => (retire = v),
    signout: () => (owner = ""),
    stale: () => (current = false),
  };
}
test("actual REST shape, UTF16 ranges, read-only source and archive option", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.status, 200);
  assert.equal(result.data.data[0].conversation.uuid, "chat-a");
  assert.deepEqual(result.data.data[0].title_matches, [{ start: 3, end: 9 }]);
  assert.deepEqual(result.data.data[0].matched_snippet, {
    text: "😀 Search body",
    matches: [{ start: 3, end: 9 }],
  });
  assert.equal(result.data.search_id, null);
  assert.equal(result.data.executed_mode, null);
  assert.equal("has_more" in result.data, false);
  assert.deepEqual(f.calls[1], [
    "searchConversations",
    "Search",
    { mode: "chat", includeArchived: true, limit: 50 },
  ]);
  assert.deepEqual(conversationSearchMatches("İ 😀 Search", "Search"), [
    { start: 5, end: 11 },
  ]);
});
test("method/org/logout/stale/query reject before reading sources", async () => {
  for (const variant of ["method", "org", "out", "stale", "query"]) {
    const f = fixture();
    if (variant === "out") f.signout();
    if (variant === "stale") f.stale();
    const r = await f.run(
      undefined,
      variant === "method" ? "GET" : "POST",
      variant === "org" ? organizationUuid("b") : organizationUuid("a"),
      variant === "query" ? "?mode=code" : "",
    );
    assert.ok([400, 401, 404, 405, 409].includes(r.status));
    assert.equal(f.calls.length, 0);
  }
});
test("strict bounded payload rejects unsupported fields, types and large bodies", async () => {
  for (const body of [
    {},
    { query: "" },
    { query: "a".repeat(201) },
    { query: "a\nb" },
    { query: "x", mode: "code" },
    { query: "x", n: 0 },
    { query: "x", n: 201 },
    { query: "x", n: "50" },
    { query: "x", target_snippet_size: 0 },
    { query: "x", project_uuid: null },
    "[]",
    "not json",
    " ".repeat(4097),
  ]) {
    const f = fixture(),
      r = await f.run(body);
    assert.ok([400, 413].includes(r.status), JSON.stringify(body).slice(0, 80));
    assert.equal(f.calls.length, 0);
  }
});
test("project join, incognito exclusion, target snippet does not split surrogate", async () => {
  const f = fixture();
  f.inventory()[0].projectId = "project-a";
  f.source().results[0].projectId = "project-a";
  let r = await f.run({
    query: "Search",
    project_uuid: "project-a",
    target_snippet_size: 1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.data[0].matched_snippet.text, "");
  assert.equal(f.calls[1][2].projectId, "project-a");
  f.inventory()[0].incognito = true;
  r = await f.run({ query: "Search", project_uuid: "project-a" });
  assert.deepEqual(r.data.data, []);
});
test("wrong mode/owner/project/duplicate and malformed source never become fake empty success", async () => {
  for (const variant of [
    "unknown",
    "code",
    "project",
    "duplicate",
    "null",
    "bad",
    "inventory",
    "archive",
  ]) {
    const f = fixture();
    if (variant === "unknown")
      f.source().results[0].conversationId = "other-account";
    if (variant === "code") f.source().results[0].mode = "code";
    if (variant === "project") f.source().results[0].projectId = "foreign";
    if (variant === "duplicate") f.source().results.push(f.source().results[0]);
    if (variant === "null") f.setSource(null);
    if (variant === "bad") f.source().results[0].snippet = 42;
    if (variant === "inventory") f.setInventory(null);
    if (variant === "archive") f.source().results[0].archived = true;
    assert.equal((await f.run()).status, 503, variant);
  }
});
test("top-n accepts a full source cap, larger truncated requests still refuse", async () => {
  const f = fixture();
  const rows = Array.from({ length: 50 }, (_, n) => ({
    ...f.inventory()[0],
    id: `chat-${n}`,
  }));
  f.setInventory(rows);
  f.setSource({
    results: rows.map((c) => ({
      ...f.source().results[0],
      conversationId: c.id,
    })),
  });
  const full = await f.run();
  assert.equal(full.status, 200);
  assert.equal(full.data.data.length, 50);
  assert.equal((await f.run({ query: "Search", n: 200 })).status, 413);
  f.source().results.pop();
  const r = await f.run({ query: "Search", n: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.data.length, 2);
  assert.equal("cursor" in r.data, false);
});
test("source errors sanitized; activation retirement after each await prevents data return", async () => {
  for (const step of ["inventory", "search"]) {
    const f = fixture();
    f.fail(step);
    const r = await f.run();
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(r), /private/);
    const g = fixture();
    g.retire(step);
    const stale = await g.run();
    assert.equal(stale.status, 409);
    assert.equal(stale.data.data, undefined);
    if (step === "inventory") assert.equal(g.calls.length, 1);
  }
});
