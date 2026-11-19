/** Real adapter routes and recovered protocol; synthetic conversation, no model or user data. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { toJson } from "@bufbuild/protobuf";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import {
  createRecentsRpc,
  LIST_RECENTS_PATH,
} from "../electron/official-ui/api/recents";
import {
  conversationAliases,
  conversationPageId,
  conversationRow,
  conversationsRoute,
  resolveConversationId,
} from "../electron/official-ui/api/conversations";
import {
  deepCreate,
  conversationUpdate,
  loadRegistry,
} from "../electron/official-ui/api/timeline";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
const registry = loadRegistry(
  "build/official-ui/data/conversation-protocol.json",
);
async function request(route: any, path: string, body?: any) {
  const req: any = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  );
  req.method = body === undefined ? "GET" : "POST";
  req.headers = { "content-type": "application/json" };
  let status = 0,
    value: any;
  const res: any = {
    writeHead: (s: number) => (status = s),
    end: (b: any) => (value = JSON.parse(String(b))),
  };
  await route(req, res, path, new URL(path, "http://synthetic.invalid"));
  return { status, value };
}
test("first send, repeated follow-ups, list refresh and restored aliases retain one page identity", async () => {
  const page = "11111111-1111-4111-8111-111111111111",
    real = "22222222-2222-4222-8222-222222222222";
  const identity = {},
    calls: any[] = [];
  let saved: any;
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    stateDirectory: () => "/synthetic/conversation-identity",
    isCurrent: () => true,
    settings: () => ({ providers: [{ id: "p", model: "m" }] }),
    log() {},
    listConversations: async () => (saved ? [saved] : []),
    loadConversation: async (id: string) => (id === real ? saved : undefined),
    call: async (method: string, input: any) => {
      assert.equal(method, "send");
      calls.push(input);
      saved = {
        id: real,
        title: "same title",
        mode: "chat",
        model: "m",
        providerId: "p",
        createdAt: 1,
        updatedAt: calls.length,
        turns: [
          ...(saved?.turns ?? []),
          {
            id: "turn-" + calls.length,
            prompt: input.text,
            status: "completed",
            createdAt: calls.length,
            attachments: [],
            items: [
              {
                id: "reply-" + calls.length,
                type: "agentMessage",
                text: "synthetic reply",
              },
            ],
          },
        ],
      };
      return saved;
    },
  };
  const run = async () => {
    const action = createActionRpc(ctx, registry),
      recents = createRecentsRpc(ctx, registry);
    const schema = registry.getMessage(
      "anthropic.bard.api.v1alpha.PerformActionRequest",
    )!;
    const firstSend = calls.length === 0;
    for (let i = 0; i < (firstSend ? 3 : 1); i++) {
      const payload = toJson(
        schema,
        deepCreate(schema, {
          header: { conversationId: page },
          action: {
            case: "sendMessage",
            value: {
              text: "synthetic prompt " + calls.length,
              messageId: "human-" + calls.length,
              assistantMessageId: "assistant-" + calls.length,
            },
          },
        }),
        { useProtoFieldName: true },
      );
      const ack = await request(action, PERFORM_ACTION_PATH, payload);
      assert.equal(ack.status, 200, JSON.stringify(ack.value));
      assert.equal(ack.value.ack.outcome.value, true);
      assert.equal(resolveConversationId(page), real);
      const path = `/api/organizations/${organizationUuid("owner")}/chat_conversations_v2`;
      const list = await request(
        (req: any, res: any, p: string, url: URL) =>
          conversationsRoute(req, res, p, url, ctx),
        path,
      );
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.value.data.map((r: any) => r.uuid),
        [page],
      );
      // The official consumer merges rows by UUID, retaining a streamed page row.
      const cache = new Map([[page, { uuid: page }]]);
      for (const row of list.value.data) cache.set(row.uuid, row);
      assert.equal(cache.size, 1);
      const response = await request(recents, LIST_RECENTS_PATH, {
        organization_uuid: organizationUuid("owner"),
        first: { query: "", surfaces: [1] },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.value.data.map((r: any) => r.chat.uuid),
        [page],
      );
      const frame = conversationUpdate({ ...saved, id: page }, false, {
        org: organizationUuid("owner"),
        conversationId: real,
      });
      assert.equal(frame.conversation.id, page);
      const detail = await request(
        (req: any, res: any, p: string, url: URL) =>
          conversationsRoute(req, res, p, url, ctx),
        `/api/organizations/${organizationUuid("owner")}/chat_conversations/${page}`,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail.value));
      assert.equal(detail.value.uuid, page);
      assert.equal(detail.value.chat_messages.length, saved.turns.length * 2);
    }
  };
  const scope = newAdapterScope("owner");
  await inAdapterScope(scope, run);
  assert.equal(calls[0].newConversationId, page);
  assert.ok(
    calls
      .slice(1)
      .every(
        (input) => input.conversationId === real && !input.newConversationId,
      ),
  );
  const aliases = inAdapterScope(scope, () => [...conversationAliases]);
  await inAdapterScope(newAdapterScope("owner"), async () => {
    for (const [p, r] of aliases) conversationAliases.restore(p, r);
    await run();
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].conversationId, real);
});
test("same titles remain independent, reverse index invalidates and account scopes never borrow aliases", () => {
  const scope = newAdapterScope("one");
  inAdapterScope(scope, () => {
    assert.equal(conversationPageId("real"), "real");
    conversationAliases.restore("page", "real");
    assert.equal(conversationPageId("real"), "page");
    conversationAliases.restore("second-page", "real");
    assert.equal(conversationPageId("real"), "page");
    conversationAliases.delete("page");
    assert.equal(conversationPageId("real"), "second-page");
    conversationAliases.restore("second-page", "different");
    assert.equal(conversationPageId("real"), "real");
    const rows = ["real", "different"].map((id) =>
      conversationRow({ id, title: "same title", turns: [] } as any),
    );
    assert.equal(new Set(rows.map((r) => r.uuid)).size, 2);
    inAdapterScope(newAdapterScope("two"), () =>
      assert.equal(conversationPageId("different"), "different"),
    );
    conversationAliases.clear();
    assert.equal(conversationPageId("different"), "different");
  });
});
