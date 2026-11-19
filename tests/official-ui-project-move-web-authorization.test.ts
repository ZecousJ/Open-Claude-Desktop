/** Restricted Web host's exact project-move capability; real local handler, no network/model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Store } from "../electron/store/store";
import { conversationsRoute } from "../electron/official-ui/api/conversations";
import { organizationUuid } from "../electron/official-ui/api/context";
import { useElectronShim } from "./runner/runner-core-support.test";
useElectronShim();
const { registerConversationManageHandlers } =
  await import("../electron/ipc/conversation-manage-handlers");
function fixture(t: any, allowed?: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f029-web-capability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.projects = [
    {
      id: "owned-project",
      name: "Owned",
      description: "",
      kind: "chat",
      createdAt: 1,
      instructions: "",
    },
  ];
  store.conversations = [
    {
      id: "owned-chat",
      mode: "chat",
      title: "Owned chat",
      createdAt: 2,
      providerId: "inert",
      model: "inert",
      turns: [],
    } as any,
  ];
  store.flush();
  const identity = {},
    calls: any[] = [],
    handlers = new Map<string, Function>();
  registerConversationManageHandlers({
    context: {
      store,
      engine: {},
      accountGeneration: () => identity,
      push() {},
    },
    engineOf: () => undefined,
    handle: (name: string, fn: Function) => handlers.set(name, fn),
  } as any);
  const ctx: any = {
    root,
    stateDirectory: () => root,
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    isCurrent: () => true,
    readOnly: true,
    strictActionSemantics: true,
    ...(allowed === undefined ? {} : { allowConversationProjectMove: allowed }),
    snapshot: async () => ({ projects: structuredClone(store.projects) }),
    loadConversation: async (id: string) =>
      store.conversations.find((row) => row.id === id),
    listConversations: async () => store.conversations,
    call: async (name: string, ...args: any[]) => {
      calls.push({ name, args: structuredClone(args) });
      return handlers.get(name)!(...args);
    },
  };
  return {
    store,
    calls,
    async move(projectId: string | null = "owned-project", org = "owner") {
      const p = `/api/organizations/${organizationUuid(org)}/chat_conversations/move_many`;
      const req: any = Readable.from([
        Buffer.from(
          JSON.stringify({
            conversation_uuids: ["owned-chat"],
            project_uuid: projectId,
          }),
        ),
      ]);
      req.method = "POST";
      let status = 0,
        data: any;
      assert.equal(
        await conversationsRoute(
          req,
          {
            writeHead(n: number) {
              status = n;
            },
            end(value: any) {
              data = JSON.parse(String(value));
            },
          } as any,
          p,
          new URL(p, "http://fixture.invalid"),
          ctx,
        ),
        true,
      );
      return { status, data };
    },
    reopen: () => new Store(root),
  };
}
test("read-only project move stays denied when exact capability is absent or false", async (t) => {
  for (const allowed of [undefined, false]) {
    const f = fixture(t, allowed),
      result = await f.move();
    assert.equal(result.status, 501);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.conversation("owned-chat").projectId, undefined);
    assert.equal(f.reopen().conversation("owned-chat").projectId, undefined);
  }
});
test("read-only exact capability permits guarded move and removal through real native persistence", async (t) => {
  const f = fixture(t, true);
  assert.deepEqual(await f.move(), {
    status: 200,
    data: { moved: ["owned-chat"], failed: [] },
  });
  assert.equal(
    f.reopen().conversation("owned-chat").projectId,
    "owned-project",
  );
  assert.deepEqual(f.calls[0], {
    name: "updateConversation",
    args: [
      "owned-chat",
      {
        projectId: {
          version: 1,
          target: "owned-project",
          expected: {
            conversationId: "owned-chat",
            mode: "chat",
            createdAt: 2,
            sourceProjectId: null,
            destinationCreatedAt: 1,
          },
        },
      },
    ],
  });
  assert.deepEqual(await f.move(null), {
    status: 200,
    data: { moved: ["owned-chat"], failed: [] },
  });
  assert.equal(f.reopen().conversation("owned-chat").projectId, undefined);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args[1].projectId.target, null);
  assert.equal(
    f.calls[1].args[1].projectId.expected.sourceProjectId,
    "owned-project",
  );
});
test("exact Web capability does not permit foreign organization or unknown destination", async (t) => {
  for (const request of [
    { org: "foreign", project: "owned-project" },
    { org: "owner", project: "foreign-project" },
  ]) {
    const f = fixture(t, true),
      result = await f.move(request.project, request.org);
    assert.equal(result.status, 404);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.conversation("owned-chat").projectId, undefined);
    assert.equal(f.reopen().conversation("owned-chat").projectId, undefined);
  }
});
