import { artifactNoteKey } from "../shared/artifact-notes";
import test from "node:test";
import assert from "node:assert/strict";
import {
  artifactsRoute,
  conversationSnippets,
} from "../electron/official-ui/api/artifacts";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";
import type { Conversation } from "../shared/types";
import type http from "node:http";

function conversation(
  id = "chat-one",
  text = "```html\n<h1>Real saved content</h1>\n```\n```js\nconst a = 1;\n```",
): Conversation {
  return {
    id,
    mode: "chat",
    title: "My artifact",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: "turn",
        prompt: "make",
        attachments: [],
        status: "completed",
        createdAt: 2,
        items: [{ id: "answer", type: "agentMessage", text }],
      },
    ],
  };
}
function fixture(chats = [conversation()]) {
  let owner = "account-a",
    activation = 1;
  let reads = 0;
  const metadata = {
    notes: {} as any,
    pinned: [] as string[],
    fail: false,
    onRead: undefined as (() => void) | undefined,
  };
  let onLoad: (() => void) | undefined;
  // Deliberately scoped route stub: only methods exercised by artifactsRoute.
  const ctx = {
    snapshot: async () => ({
      artifactLibrary: { version: 1, copies: [], pinned: metadata.pinned },
    }),
    call: async (method: string) => {
      assert.equal(method, "artifactNotes");
      metadata.onRead?.();
      if (metadata.fail) throw Error("Source error");
      return metadata.notes;
    },
    account: () => ({ id: owner }),
    sessionIdentity: () => activation,
    listConversations: async () => chats,
    loadConversation: async (id: string) => {
      reads++;
      onLoad?.();
      return chats.find((c) => c.id === id);
    },
  } as unknown as AdapterContext;
  return {
    ctx,
    chats,
    metadata,
    get reads() {
      return reads;
    },
    setLoad(fn: () => void) {
      onLoad = fn;
    },
    switchAccount() {
      owner = "account-b";
    },
    reactivate() {
      activation++;
    },
    async run(path: string, method = "GET") {
      let status = 200,
        body = "";
      const res = {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = value;
        },
      } as unknown as http.ServerResponse;
      const url = new URL(path, "http://localhost");
      const handled = await artifactsRoute(
        { method } as http.IncomingMessage,
        res,
        url.pathname,
        url,
        ctx,
      );
      return { handled, status, data: body ? JSON.parse(body) : undefined };
    },
  };
}
const list = `/api/frame/artifacts?org=${organizationUuid("account-a")}`;
const versions = (id = "chat-one") =>
  `/api/organizations/${organizationUuid("account-a")}/artifacts/${id}/versions`;

test("real conversation snippet list/version contract keeps exact content and stable IDs", async () => {
  const f = fixture();
  const a = await f.run(`${list}&rel=all&limit=1&empty=exclude`);
  assert.equal(a.status, 200);
  assert.equal(a.data.artifacts.length, 1);
  const row = a.data.artifacts[0];
  const v = await f.run(versions());
  const detail = v.data.artifact_versions.find(
    (v: any) => v.uuid === row.latest_artifact_version_uuid,
  );
  assert.equal(detail.artifact_uuid, row.artifact_identifier);
  assert.equal(detail.conversation_uuid, row.conversation_uuid);
  assert.equal(detail.source, "w");
  assert.ok(
    ["<h1>Real saved content</h1>\n", "const a = 1;\n"].includes(
      detail.result_state,
    ),
  );
  assert.deepEqual((await f.run(versions())).data, v.data);
  const next = await f.run(
    `${list}&rel=all&limit=1&empty=exclude&page_token=${encodeURIComponent(a.data.next_page_token)}`,
  );
  assert.equal(next.data.artifacts.length, 1);
  assert.notEqual(next.data.artifacts[0].id, row.id);
  assert.equal(next.data.next_page_token, null);
  assert.equal(
    (await f.run(`${list}&ids=${row.id}&view=lean`)).data.artifacts[0].id,
    row.id,
  );
});

test("artifact listing reads independent conversations in one batch", { timeout: 2000 }, async () => {
  const f = fixture([conversation("first"), conversation("second"), conversation("third")]);
  const read = f.ctx.loadConversation;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.ctx.loadConversation = async id => {
    const row = await read(id);
    if (f.reads === f.chats.length) release();
    await pending;
    return row;
  };
  const response = await f.run(list);
  assert.equal(response.status, 200);
  assert.equal(response.data.artifacts.length, 6);
});

test("Chat reads each saved revision and keeps fenced snippets separate", async () => {
  const firstBody = "  # Original\n\nOld revision body";
  const secondBody = "# Updated\n\nNew revision body";
  const tag = (body: string) =>
    `<antArtifact identifier="widget" type="text/markdown" title="Widget">${body}</antArtifact>`;
  const c = conversation(
    "chat-one",
    `${tag(firstBody)}\n\n\`\`\`js\nconst unrelated = 42;\n\`\`\`\n\n\`\`\`html\n${tag("Example, not a revision")}\n\`\`\``,
  );
  const firstMessage = c.turns[0].items[0];
  const split = firstMessage.text!.indexOf(firstBody) + 5;
  c.turns[0].items.push({
    ...firstMessage,
    id: "answer-rest",
    text: firstMessage.text!.slice(split),
  });
  firstMessage.text = firstMessage.text!.slice(0, split);
  c.turns.push({
    ...c.turns[0],
    id: "next-turn",
    createdAt: 3,
    items: [{ id: "answer", type: "agentMessage", text: tag(secondBody) }],
  });
  const f = fixture([c]);
  const first = await f.run(versions());
  assert.equal(first.status, 200);
  const rows = first.data.artifact_versions;
  const widget = rows.filter(
    (row: any) => row.artifact_identifier === "widget",
  );
  assert.deepEqual(
    widget.map((row: any) => [
      row.version_number,
      row.message_uuid,
      row.result_state,
    ]),
    [
      [2, "next-turn:assistant", secondBody],
      [1, "turn:assistant", firstBody],
    ],
  );
  assert.equal(widget[0].artifact_uuid, widget[1].artifact_uuid);
  assert.notEqual(widget[0].uuid, widget[1].uuid);
  const snippetRows = rows.filter((row: any) => !row.artifact_identifier);
  assert.equal(snippetRows.length, 2);
  const gallery = await f.run(list);
  assert.deepEqual(
    gallery.data.artifacts.map((row: any) => row.latest_artifact_version_uuid),
    snippetRows.map((row: any) => row.uuid),
  );
  assert.deepEqual((await f.run(versions())).data, first.data);
  assert.deepEqual(
    (await f.run(versions() + "?latest_only=true")).data.artifact_versions,
    [widget[0], ...snippetRows],
  );
});

test("wrong organization, unknown source and writes cannot read any content", async () => {
  const f = fixture();
  for (const path of [
    "/api/frame/artifacts",
    `${list.replace(organizationUuid("account-a"), organizationUuid("other"))}`,
    versions().replace(
      organizationUuid("account-a"),
      organizationUuid("other"),
    ),
  ])
    assert.equal((await f.run(path)).status, 404);
  assert.equal(f.reads, 0);
  assert.equal((await f.run(versions("missing"))).status, 404);
  assert.equal((await f.run(list, "POST")).status, 405);
});

test("switching account or activation during asynchronous source load fails closed", async () => {
  for (const change of ["switchAccount", "reactivate"] as const) {
    const f = fixture();
    f.setLoad(() => f[change]());
    const result = await f.run(list);
    assert.equal(result.status, 409);
    assert.equal(result.data.artifacts, undefined);
  }
});

test("strict bounded queries reject unsupported semantics and replayed changed cursors", async () => {
  const f = fixture();
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=1&limit=2",
    "rel=unknown",
    "view=other",
    "ids=../../secret",
    "empty=include",
    "q=" + "x".repeat(201),
    "unknown=true",
    "type=design-system",
    "kind=page,document",
    "rel=shared",
  ]) {
    assert.ok(
      [400, 501].includes((await f.run(`${list}&${query}`)).status),
      query,
    );
  }
  const a = await f.run(`${list}&limit=1`);
  f.chats[0].turns[0].items[0].text += "\n```text\nnew\n```";
  assert.equal(
    (
      await f.run(
        `${list}&limit=1&page_token=${encodeURIComponent(a.data.next_page_token)}`,
      )
    ).status,
    409,
  );
});

test("incognito, native and other-owner sources are not relabeled as own chat snippets", async () => {
  const hidden = conversation("private");
  hidden.incognito = true;
  const native = conversation("cowork");
  native.mode = "cowork";
  const shared = conversation("shared");
  shared.sessionAuthors = { viewerAccountUuid: "a", ownerAccountUuid: "b" };
  const f = fixture([hidden, native, shared]);
  assert.deepEqual((await f.run(list)).data.artifacts, []);
  assert.equal(f.reads, 0);
  assert.equal((await f.run(versions("private"))).status, 404);
});

test("IDs isolate accounts; content edits change version without changing artifact identity", () => {
  const c = conversation();
  const first = conversationSnippets("a", c)[0];
  assert.notEqual(
    conversationSnippets("b", c)[0].artifact_uuid,
    first.artifact_uuid,
  );
  c.turns[0].items[0].text = "```html\nnew content\n```";
  const second = conversationSnippets("a", c)[0];
  assert.equal(second.artifact_uuid, first.artifact_uuid);
  assert.notEqual(second.uuid, first.uuid);
});

test("source, count and response limits report failures rather than silently truncating", async () => {
  assert.equal(
    (
      await fixture(
        Array.from({ length: 201 }, (_, i) => conversation(String(i))),
      ).run(list)
    ).status,
    413,
  );
  assert.equal(
    (
      await fixture([
        conversation(
          "large",
          "```text\n" + "a".repeat(2 * 1024 * 1024 + 1) + "\n```",
        ),
      ]).run(list)
    ).status,
    413,
  );
  const escaped = "\\".repeat(900_000);
  const c = conversation(
    "large",
    Array.from({ length: 3 }, () => "```text\n" + escaped + "\n```").join("\n"),
  );
  assert.equal((await fixture([c]).run(versions("large"))).status, 413);
});

test("missing or failed history is an explicit failure, never an empty successful gallery", async () => {
  const f = fixture();
  f.ctx.loadConversation = async () => undefined;
  assert.equal((await f.run(list)).status, 404);
  f.ctx.loadConversation = async () => {
    throw Error("private upstream detail");
  };
  const result = await f.run(list);
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result.data).includes("private upstream detail"));
});

test("same item IDs in different turns remain distinct and huge empty history is bounded", () => {
  const c = conversation();
  c.turns.push({ ...structuredClone(c.turns[0]), id: "other-turn" });
  const rows = conversationSnippets("account", c);
  assert.equal(new Set(rows.map((r) => r.artifact_uuid)).size, 4);
  c.turns = Array.from({ length: 10_001 }, () => ({
    ...structuredClone(c.turns[0]),
    items: [],
  }));
  assert.throws(() => conversationSnippets("account", c), /history limit/);
});

test("native viewed timestamps and pins map to snippet rows without invented dates", async () => {
  const f = fixture();
  const rows = conversationSnippets("account-a", f.chats[0]);
  const identity = (r: (typeof rows)[number]) =>
    JSON.stringify([r.conversation_uuid, r.result_state]);
  f.metadata.notes[artifactNoteKey(identity(rows[1]))] = { viewedAt: 123456 };
  f.metadata.pinned.push(identity(rows[1]));
  const response = await f.run(
    `${list}&sort=last_viewed&with_last_viewed=true`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.sort, "last_viewed");
  assert.equal(response.data.last_viewed_filled, true);
  assert.equal(response.data.artifacts[0].id, rows[1].artifact_uuid);
  assert.equal(
    response.data.artifacts[0].last_viewed_at,
    new Date(123456).toISOString(),
  );
  assert.equal(response.data.artifacts[0].starred, true);
  assert.equal(response.data.artifacts[1].last_viewed_at, null);
  assert.equal(response.data.artifacts[1].sort_time, null);
  assert.equal(response.data.artifacts[1].starred, false);
  const favorites = await f.run(`${list}&rel=favorited&limit=500`);
  assert.equal(favorites.status, 200);
  assert.deepEqual(
    favorites.data.artifacts.map((r: any) => r.id),
    [rows[1].artifact_uuid],
  );
  assert.equal((await f.run(`${list}&rel=favorited&limit=501`)).status, 400);
});
test("view and favorite metadata changes invalidate old pagination cursors", async () => {
  const f = fixture();
  const rows = conversationSnippets("account-a", f.chats[0]);
  const first = await f.run(`${list}&sort=last_viewed&limit=1`);
  const key = artifactNoteKey(
    JSON.stringify([rows[1].conversation_uuid, rows[1].result_state]),
  );
  f.metadata.notes[key] = { viewedAt: 123 };
  assert.equal(
    (
      await f.run(
        `${list}&sort=last_viewed&limit=1&page_token=${first.data.next_page_token}`,
      )
    ).status,
    409,
  );
  assert.equal((await f.run(`${list}&sort=created`)).status, 400);
});
test("metadata service failure, malformed history and changed identity never become empty success", async () => {
  const f = fixture();
  f.metadata.fail = true;
  assert.equal((await f.run(`${list}&sort=last_viewed`)).status, 503);
  f.metadata.fail = false;
  f.metadata.pinned = undefined as any;
  assert.equal((await f.run(`${list}&rel=favorited`)).status, 503);
  f.metadata.pinned = [];
  f.metadata.notes = null;
  assert.equal((await f.run(`${list}&sort=last_viewed`)).status, 503);
  f.metadata.notes = { ["0".repeat(32)]: { viewedAt: NaN } };
  assert.equal((await f.run(`${list}&sort=last_viewed`)).status, 503);
  f.metadata.notes = {};
  f.metadata.onRead = () => f.reactivate();
  assert.equal((await f.run(`${list}&rel=favorited`)).status, 409);
});
