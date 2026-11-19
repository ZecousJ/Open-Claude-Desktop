/** Mocked source only; actual recovered descriptor encode/decode, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fromJson, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { loadRegistry } from "../electron/official-ui/api/timeline";
import {
  createRecentsRpc,
  LIST_RECENTS_PATH,
  recentsJson,
  recentsMatches,
} from "../electron/official-ui/api/recents";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";
import { cloudCodeSessionKey } from "../electron/official-ui/api/cloud-code-history";
import type { Approval } from "../shared/types";
import { searchLocalConversations } from "../electron/conversations/history-search";
const registry = loadRegistry(
    "build/official-ui/data/conversation-protocol.json",
  ),
  pkg = "anthropic.claudeai_chats.api.v1alpha";
const input = registry.getMessage(pkg + ".ListRecentsRequest")!,
  output = registry.getMessage(pkg + ".ListRecentsResponse")!;
function fixture(
  host: Partial<
    Pick<
      AdapterContext,
      | "readOnly"
      | "officialCodeHistory"
      | "officialCoworkHistory"
      | "localListConversations"
      | "localLoadConversation"
    >
  > & {
    projectCatalog?: Awaited<
      ReturnType<AdapterContext["snapshot"]>
    >["projectCatalog"];
  } = {},
) {
  const { projectCatalog, ...capabilities } = host;
  let identity = {},
    calls = 0;
  const approvals: Approval[] = [];
  const rows: any[] = Array.from({ length: 4 }, (_, i) => ({
    id: "chat-" + i,
    mode: "chat",
    title: "Title " + i,
    createdAt: 1,
    updatedAt: 10 - i,
    turns: [{ id: "turn-" + i, createdAt: 1, prompt: "needle", items: [] }],
  }));
  let search: any = async (q: string, o: any) =>
    searchLocalConversations(rows, q, o);
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    listConversations: async () => rows,
    snapshot: async () => ({
      conversations: rows,
      approvals,
      projectCatalog,
      projects: [{ id: "project", name: "Project title" }],
    }),
    call: async (_n: string, q: string, o: any) => {
      calls++;
      return search(q, o);
    },
    ...capabilities,
  };
  const route = createRecentsRpc(ctx, registry);
  return {
    get calls() {
      return calls;
    },
    rows: () => rows,
    approvals,
    retire: () => {
      identity = {};
    },
    setSearch: (s: any) => (search = s),
    async run(
      body: any = { first: { query: "needle", surfaces: [1, 2] } },
      binary = false,
    ) {
      let status = 0,
        result: any;
      const value = { organizationUuid: organizationUuid("owner"), ...body };
      const req: any = Readable.from([
        binary
          ? Buffer.from(
              toBinary(input, fromJson(input, recentsJson(input, value))),
            )
          : Buffer.from(JSON.stringify(value)),
      ]);
      req.method = "POST";
      req.headers = {
        "content-type": binary ? "application/proto" : "application/json",
      };
      const res: any = {
        writeHead: (n: number) => (status = n),
        end: (x: any) =>
          (result =
            status === 200 && binary
              ? toJson(output, fromBinary(output, x), {
                  useProtoFieldName: true,
                })
              : JSON.parse(String(x))),
      };
      assert.equal(await route(req, res, LIST_RECENTS_PATH), true);
      return { status, result };
    },
  };
}
test("actual descriptor protobuf and JSON requests return Chat and explicit incomplete other surfaces", async () => {
  for (const binary of [false, true]) {
    const f = fixture(),
      r = await f.run(undefined, binary);
    assert.equal(r.status, 200);
    assert.equal(r.result.data.length, 4);
    assert.equal(r.result.data[0].chat.uuid, "chat-0");
    assert.ok(r.result.surfaces[0].state.includes("OK"));
    assert.ok(r.result.surfaces[1].state.includes("INCOMPLETE"));
    assert.equal(f.calls, 1);
  }
});
test("opaque cursor pages actual fixed results, rejects history mutation and account reactivation", async () => {
  const f = fixture(),
    first = await f.run({
      limit: 2,
      first: { query: "needle", surfaces: [1] },
    });
  assert.equal(first.status, 200);
  assert.ok(first.result.cursor);
  const second = await f.run({ limit: 2, cursor: first.result.cursor });
  assert.equal(second.status, 200);
  assert.equal(second.result.page_offset, 2);
  assert.equal(second.result.data[0].chat.uuid, "chat-2");
  assert.equal(second.result.cursor, undefined);
  f.rows()[0].title = "changed";
  assert.equal((await f.run({ cursor: first.result.cursor })).status, 400);
  f.retire();
  assert.equal((await f.run({ cursor: first.result.cursor })).status, 400);
});
test("foreign org, unknown scope, invalid bounds and forged cursor fail", async () => {
  const f = fixture();
  assert.equal(
    (await f.run({ organizationUuid: organizationUuid("other"), first: {} }))
      .status,
    404,
  );
  for (const body of [
    { limit: 0, first: {} },
    { first: { query: "x".repeat(201) } },
    { cursor: "forged" },
  ])
    assert.equal((await f.run(body)).status, 400);
  assert.equal((await f.run({ first: { routineId: "routine" } })).status, 501);
  assert.equal(f.calls, 0);
});
test("invalid hits and source failures never become success-empty, late activation cannot publish", async () => {
  const f = fixture();
  f.setSearch(async () => ({
    results: Array.from({ length: 50 }, (_, i) => ({
      conversationId: String(i),
      mode: "chat",
      title: "x",
      archived: false,
      updatedAt: 1,
    })),
  }));
  assert.equal((await f.run()).status, 503);
  f.setSearch(async () => {
    throw Error("private-token");
  });
  const r = await f.run();
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.result).includes("private-token"));
  f.setSearch(async () => {
    f.retire();
    return { results: [] };
  });
  assert.equal((await f.run()).status, 409);
});
test("temporary and non-Chat records never spoof remote Code/Cowork; names-only remains explicit", async () => {
  const f = fixture();
  f.rows().push(
    { ...f.rows()[0], id: "secret", incognito: true },
    { ...f.rows()[0], id: "code", mode: "code" },
  );
  const r = await f.run({
    first: { namesOnly: true, query: "Title", surfaces: [1, 2, 3] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.result.data.length, 4);
  assert.equal(f.calls, 0);
  const empty = await f.run({ first: { query: "not-matched", surfaces: [1] } });
  assert.equal(empty.status, 200);
  assert.equal(empty.result.data, undefined);
});

test("Unicode matches use code-point offsets and cursor replay does not create new continuations", async () => {
  assert.deepEqual(recentsMatches("😀 Needle needle", "needle"), [
    { start: 2, end: 8 },
    { start: 9, end: 15 },
  ]);
  const f = fixture(),
    first = await f.run({ limit: 1, first: { surfaces: [1] } });
  const a = await f.run({ limit: 1, cursor: first.result.cursor }),
    b = await f.run({ limit: 1, cursor: first.result.cursor });
  assert.equal(a.status, 200);
  assert.deepEqual(a.result, b.result);
});
test("unknown JSON fields and aliases of same field cannot bypass strict request contract", async () => {
  const f = fixture();
  assert.equal(
    (await f.run({ first: { query: "x", unknownFlag: true } })).status,
    400,
  );
  assert.equal(
    (await f.run({ organization_uuid: organizationUuid("owner"), first: {} }))
      .status,
    400,
  );
});

test("original protocol returns openable cloud Code and Cowork sessions with status, project and excerpts", async () => {
  for (const binary of [false, true]) {
    const f = fixture({
      readOnly: true,
      officialCodeHistory: true,
      officialCoworkHistory: true,
    });
    const add = (
      id: string,
      mode: "code" | "cowork",
      updatedAt: number,
      overrides: Record<string, unknown> = {},
    ) => {
      const row = {
        ...f.rows()[0],
        id,
        mode,
        updatedAt,
        title: "😀 needle",
        environment: { kind: "space", spaceId: id },
        projectId: "project",
        turns: [
          { id: "turn-" + id, createdAt: 1, prompt: "x needle y", items: [] },
        ],
        ...overrides,
      };
      f.rows().push(row);
      return row;
    };
    const running = add("running", "code", 40, {
      unread: true,
      pinned: true,
      turns: [
        { id: "active", status: "inProgress", prompt: "x needle y", items: [] },
      ],
    });
    const waiting = add("waiting", "cowork", 30, {
      threadId: "thread",
      pinned: true,
      turns: [
        {
          id: "waiting",
          status: "inProgress",
          prompt: "x needle y",
          items: [],
        },
      ],
    });
    f.approvals.push({
      id: "approval",
      conversationId: waiting.id,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "waiting" },
    });
    add("failed", "code", 20, {
      pinned: true,
      turns: [
        { id: "failed", status: "failed", prompt: "x needle y", items: [] },
      ],
    });
    add("archived", "cowork", 50, { archived: true, pinned: true });
    add("unpinned", "code", 60);
    add("private", "code", 70, { incognito: true, pinned: true });
    add("foreign", "cowork", 80, {
      pinned: true,
      sessionAuthors: { ownerAccountUuid: "other", viewerAccountUuid: "owner" },
    });
    add("mirrored", "code", 90, { cloudHosted: true, pinned: true });
    const request = {
      first: {
        query: "needle",
        surfaces: [2],
        include: [3, 6, 8],
        projectUuid: "project",
        starredOnly: true,
      },
    };
    const { status, result } = await f.run(request, binary);
    assert.equal(status, 200);
    assert.deepEqual(
      result.surfaces.map(({ state }: { state: string }) => state),
      [
        "SURFACE_STATE_OK",
        "SURFACE_STATE_INCOMPLETE",
        "SURFACE_STATE_INCOMPLETE",
        "SURFACE_STATE_INCOMPLETE",
      ],
    );
    assert.equal(result.data.length, 3);
    assert.deepEqual(
      result.data.map(
        ({ code_session, cowork_session }: any) =>
          (code_session ?? cowork_session).id,
      ),
      [
        "session_" + cloudCodeSessionKey(running, "owner"),
        "session_" + cloudCodeSessionKey(waiting, "owner"),
        "session_" + cloudCodeSessionKey({ id: "failed" }, "owner"),
      ],
    );
    const [first, second, third] = result.data;
    assert.deepEqual(first.code_session.running, {});
    assert.equal(first.code_session.unread, true);
    assert.equal(first.code_session.is_starred, true);
    assert.deepEqual(second.cowork_session.project, {
      uuid: "project",
      name: "Project title",
    });
    assert.deepEqual(second.cowork_session.needs_input, {
      kind: "NEEDS_INPUT_KIND_QUESTION",
    });
    assert.deepEqual(third.code_session.failed, {});
    assert.deepEqual(first.title_matches, [{ start: 2, end: 8 }]);
    assert.deepEqual(first.matched_snippet, {
      text: "x needle y",
      matches: [{ start: 2, end: 8 }],
    });

    const archived = await f.run(
      { first: { ...request.first, archivedOnly: true } },
      binary,
    );
    assert.equal(archived.status, 200);
    assert.equal(archived.result.data.length, 1);
    assert.equal(
      archived.result.data[0].cowork_session.status,
      "RECENT_SESSION_STATUS_ARCHIVED",
    );
    assert.deepEqual(archived.result.data[0].cowork_session.idle, {});
  }
});

test("desktop search keeps the canonical native IDs and skips sessions the host cannot open", async () => {
  const f = fixture({
    localListConversations: async () => [],
    localLoadConversation: async () => undefined,
  });
  const add = (
    id: string,
    mode: "code" | "cowork",
    overrides: Record<string, unknown> = {},
  ) =>
    f
      .rows()
      .push({ ...f.rows()[0], id, mode, cwd: "/workspace", ...overrides });
  add("cowork", "cowork");
  add("code", "code");
  add("mirrored", "cowork", { cloudHosted: true });
  add("remote", "code", { environment: { kind: "space", spaceId: "remote" } });
  add("unrecognized/path", "code");
  const { status, result } = await f.run({
    first: { query: "needle", surfaces: [2, 3] },
  });
  assert.equal(status, 200);
  assert.deepEqual(
    result.data.map(
      ({ code_session, cowork_session }: any) =>
        (code_session ?? cowork_session).id,
    ),
    ["local_code", "local_cowork"],
  );
  assert.deepEqual(
    result.surfaces.map(({ state }: { state: string }) => state),
    ["SURFACE_STATE_INCOMPLETE", "SURFACE_STATE_INCOMPLETE"],
  );
});

test("search uses more than one source page and cursor replay preserves a fixed mixed snapshot", async () => {
  const f = fixture({
    readOnly: true,
    officialCodeHistory: true,
    officialCoworkHistory: true,
  });
  f.rows().splice(
    0,
    f.rows().length,
    ...Array.from({ length: 71 }, (_, i) => ({
      id: "code-" + i,
      mode: "code",
      title: "Saved " + i,
      createdAt: 1,
      updatedAt: 200 - i,
      turns: [{ id: "turn-" + i, prompt: "some body needle", items: [] }],
    })),
  );
  f.rows().push({
    id: "cowork",
    mode: "cowork",
    title: "Saved cowork",
    createdAt: 1,
    updatedAt: 190.5,
    environment: { kind: "space", spaceId: "space" },
    turns: [{ id: "turn", prompt: "needle", items: [] }],
  });
  const first = await f.run({
    limit: 30,
    first: { query: "needle", surfaces: [2, 3] },
  });
  assert.equal(first.status, 200);
  assert.equal(f.calls, 3);
  assert.equal(first.result.data.length, 30);
  assert.equal(first.result.data[10].cowork_session.title, "Saved cowork");
  const second = await f.run({ limit: 30, cursor: first.result.cursor });
  assert.equal(second.status, 200);
  assert.equal(second.result.page_offset, 30);
  const third = await f.run({ limit: 30, cursor: second.result.cursor });
  assert.equal(third.status, 200);
  assert.equal(third.result.page_offset, 60);
  assert.equal(third.result.data.at(-1).code_session.title, "Saved 70");
  assert.equal(third.result.cursor, undefined);
  assert.equal(third.result.search_id, first.result.search_id);
  assert.equal(f.calls, 3);
  f.rows().at(-1).projectId = "moved";
  assert.equal((await f.run({ cursor: first.result.cursor })).status, 400);
});

test("search rejects a repeated source page and a hit with no matching title or excerpt", async () => {
  const f = fixture();
  const first = f.rows()[0];
  for (let i = 0; i < 50; i++) {
    f.rows().push({ ...first, id: "more-" + i, updatedAt: 20 + i });
  }
  f.setSearch(async (query: string, options: any) =>
    searchLocalConversations(f.rows(), query, {
      ...options,
      page: { ...options.page, offset: 0 },
    }),
  );
  assert.equal((await f.run()).status, 503);
  f.setSearch(async () => ({
    results: [
      {
        conversationId: first.id,
        mode: first.mode,
        title: first.title,
        updatedAt: first.updatedAt,
        archived: false,
      },
    ],
  }));
  assert.equal((await f.run()).status, 503);
});

test("one search snapshot supports more than 32 continuation pages", async () => {
  const f = fixture();
  const first = f.rows()[0];
  for (let i = 0; i < 35; i++)
    f.rows().push({ ...first, id: "cursor-" + i, updatedAt: 100 + i });
  let answer = await f.run({
    limit: 1,
    first: { surfaces: [1], query: "needle" },
  });
  for (let i = 0; i < 39; i++) {
    assert.equal(answer.status, 200);
    assert.equal(answer.result.page_offset, i);
    if (i < 38)
      answer = await f.run({ limit: 1, cursor: answer.result.cursor });
  }
  assert.equal(answer.result.cursor, undefined);
  assert.equal(f.calls, 1);
});

test("failed cloud inventory surfaces an error for full text and preserves navigation", async () => {
  const f = fixture({ projectCatalog: { status: "failed", cached: false } });
  assert.equal((await f.run()).status, 503);
  assert.equal((await f.run({ first: { surfaces: [1] } })).status, 200);
  assert.equal(f.calls, 0);
});
