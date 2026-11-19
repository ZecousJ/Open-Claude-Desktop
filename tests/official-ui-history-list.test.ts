/** In-memory account inventory and pure search implementation only. */
import test from "node:test";
import assert from "node:assert/strict";
import { historyListRoute } from "../electron/official-ui/api/history-list";
import { assistantMessageId, conversationsRoute } from "../electron/official-ui/api/conversations";
import { organizationUuid } from "../electron/official-ui/api/context";
import { searchLocalConversations } from "../electron/conversations/history-search";
import { splitConversation } from "../shared/web-docs";
function fixture() {
  let identity = {},
    owner = "owner",
    calls = 0;
  const row = (id: string, mode = "chat", text = "", extra: object = {}) => ({
    id,
    mode,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    turns: [{ id: id + "turn", createdAt: 1, prompt: text, items: [] }],
    ...extra,
  });
  let rows: any[] = [
    row("first", "chat", "needle"),
    row("other"),
    row("cowork", "cowork", "needle"),
    row("private", "chat", "needle", { incognito: true }),
    row("code", "code", "needle"),
  ];
  let search: (q: string, o: any) => Promise<unknown> = async (q, o) =>
    searchLocalConversations(rows, q, o);
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    listConversations: async () => {
      calls++;
      return rows;
    },
    call: async (n: string, q: string, o: any) => {
      assert.equal(n, "searchConversations");
      calls++;
      return search(q, o);
    },
  };
  return {
    ctx,
    get calls() {
      return calls;
    },
    setRows: (r: any[]) => (rows = r),
    rows: () => rows,
    retire: () => {
      identity = {};
    },
    setSearch: (s: typeof search) => (search = s),
    async run(
      query = "",
      org = organizationUuid(owner),
      method = "GET",
      viaRoute = false,
    ) {
      const p = `/api/organizations/${org}/chat_conversations_v2`,
        url = new URL(p + query, "http://local");
      let status = 0,
        body: any;
      const res: any = {
        writeHead: (n: number) => (status = n),
        end: (s: string) => (body = JSON.parse(s)),
      };
      const handler = viaRoute ? conversationsRoute : historyListRoute;
      await handler({ method } as any, res, p, url, ctx);
      return { status, body };
    },
  };
}
test("actual list branch searches full prompt text, not title-only or unfiltered rows", async () => {
  const f = fixture();
  const r = await f.run("?searchQuery=needle", undefined, "GET", true);
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.data.map((r: any) => r.uuid),
    ["cowork", "first"],
  );
  assert.equal(r.body.has_more, false);
  assert.equal(f.calls, 3);
});
test("desktop Cowork tasks do not also appear as selectable legacy Chat rows", async () => {
  const f = fixture();
  f.ctx.localListConversations = f.ctx.listConversations;
  f.ctx.localLoadConversation = async (id: string) => f.rows().find(row => row.id === id);
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.map((row: { uuid: string }) => row.uuid), ["first", "other"]);
});
test("list pagination is deterministic and preserves archived/project/starred/incognito filters", async () => {
  const f = fixture();
  f.setRows([
    ...f.rows(),
    {
      ...f.rows()[0],
      id: "arch",
      archived: true,
      pinned: true,
      projectId: "project",
    },
  ]);
  const a = await f.run("?limit=1");
  assert.equal(a.body.data.length, 1);
  assert.equal(a.body.has_more, true);
  const b = await f.run("?limit=1&offset=1");
  assert.notEqual(a.body.data[0].uuid, b.body.data[0].uuid);
  const c = await f.run(
    "?archived=true&starred=true&project_uuid=project&searchQuery=needle",
  );
  assert.deepEqual(
    c.body.data.map((r: any) => r.uuid),
    ["arch"],
  );
});
test("cold recents reads real settled and leaf state for the page while other turns are unavailable", async () => {
  const f = fixture();
  const newer = {
    ...f.rows()[0], id: "newer", projectId: "project", pinned: true, updatedAt: 30,
    turns: [{ id: "live-turn", status: "inProgress", createdAt: 30 }],
  };
  const older = {
    ...newer, id: "older", updatedAt: 0,
    turns: [{ id: "settled-turn", status: "completed", createdAt: 20 }],
  };
  const unrelated = { ...older, id: "unrelated", updatedAt: 10 };
  const archived = { ...newer, id: "archived", archived: true, updatedAt: 40 };
  f.ctx.conversationInventory = () => [older, unrelated, archived, newer].map(row => splitConversation(row).doc.conversation);
  f.ctx.listConversations = async () => { throw Error("Full history is still loading."); };
  const loaded = new Set<string>();
  f.ctx.loadConversation = async (id: string) => {
    loaded.add(id);
    if (id === newer.id) return newer;
    if (id === older.id) return older;
    throw Error("Other turns are unavailable.");
  };
  const first = await f.run("?limit=1&project_uuid=project&starred=true");
  assert.equal(first.status, 200);
  assert.equal(first.body.has_more, true);
  assert.equal(first.body.data[0].uuid, newer.id);
  assert.equal(first.body.data[0].has_settled, false);
  assert.equal(first.body.data[0].current_leaf_message_uuid, assistantMessageId(newer.turns[0]));
  const second = await f.run("?limit=1&offset=1&project_uuid=project&starred=true");
  assert.equal(second.status, 200);
  assert.equal(second.body.has_more, true);
  assert.equal(second.body.data[0].uuid, older.id);
  assert.equal(second.body.data[0].has_settled, true);
  assert.equal(second.body.data[0].current_leaf_message_uuid, assistantMessageId(older.turns[0]));
  assert.deepEqual(loaded, new Set([newer.id, older.id]));
});
test("foreign organizations and malformed query bounds fail before any source access", async () => {
  const f = fixture();
  assert.equal((await f.run("", organizationUuid("other"))).status, 404);
  for (const q of [
    "?limit=-1",
    "?offset=-2",
    "?limit=0",
    "?limit=201",
    "?starred=1",
    "?offset=1&offset=2",
    "?unknown=1",
    "?searchQuery=" + "x".repeat(201),
  ])
    assert.equal((await f.run(q)).status, 400);
  assert.equal((await f.run("", undefined, "POST")).status, 405);
  assert.equal(f.calls, 0);
});
test("paged search reaches the 51st hit and rejects an invalid source", async () => {
  const f = fixture();
  f.setRows(Array.from({ length: 61 }, (_, index) => ({
    ...f.rows()[0], id: `page-${index}`, updatedAt: 100 - index,
  })));
  const page = await f.run("?searchQuery=needle&offset=50&limit=10");
  assert.equal(page.status, 200);
  assert.equal(page.body.data[0].uuid, "page-50");
  assert.equal(page.body.has_more, true);
  const final = await f.run("?searchQuery=needle&offset=60&limit=10");
  assert.equal(final.body.data[0].uuid, "page-60");
  assert.equal(final.body.has_more, false);
  f.setSearch(async () => ({
    results: Array.from({ length: 50 }, (_, i) => ({
      conversationId: String(i),
      title: "x",
      mode: "chat",
      archived: false,
      updatedAt: 1,
    })),
  }));
  assert.equal((await f.run("?searchQuery=x")).status, 503);
  f.setSearch(async () => ({
    results: [
      {
        conversationId: "first",
        title: "x",
        mode: "code",
        archived: false,
        updatedAt: 1,
      },
    ],
  }));
  assert.equal((await f.run("?searchQuery=x")).status, 503);
});
test("late same-account activation and source rejection never return old rows or fake empty", async () => {
  const f = fixture();
  f.setSearch(async () => {
    f.retire();
    return { results: [] };
  });
  assert.equal((await f.run("?searchQuery=x")).status, 409);
  f.setSearch(async () => {
    throw Error("private source credential");
  });
  const r = await f.run("?searchQuery=x");
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes("credential"));
});
test("foreign source hits reject inconsistent search without exposing their titles", async () => {
  const f = fixture();
  f.setSearch(async (_q, o) => ({
    results: [
      {
        conversationId: "foreign",
        title: "private",
        mode: o.mode,
        archived: false,
        updatedAt: 1,
      },
    ],
  }));
  const r = await f.run("?searchQuery=x");
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes("private"));
});
test("list completion is activation-bound and duplicate source identities fail visibly", async () => {
  const f = fixture();
  f.ctx.listConversations = async () => {
    f.retire();
    return f.rows();
  };
  assert.equal((await f.run()).status, 409);
  f.ctx.listConversations = async () => [...f.rows(), f.rows()[0]];
  assert.equal((await f.run()).status, 503);
});
test("legitimate no-match is empty and reply text participates in full-text search", async () => {
  const f = fixture();
  const c = f.rows()[1];
  c.turns[0].items = [{ type: "agentMessage", text: "reply-only-token" }];
  assert.deepEqual(
    (await f.run("?searchQuery=reply-only-token")).body.data.map(
      (r: any) => r.uuid,
    ),
    ["other"],
  );
  const empty = await f.run("?searchQuery=not-found-token");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);
  assert.equal(empty.body.has_more, false);
});
