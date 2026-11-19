import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { createApiAdapter } from "../electron/official-ui/api";
import { bootstrapOf } from "../electron/official-ui/api/bootstrap";
import { persistEmptyChat } from "../electron/official-ui/api/chat-creation";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import { Store } from "../electron/store/store";

test("native Compare starts both saved Chats concurrently after reopening the Store and adapter", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compare-native-"));
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let store = new Store(root);
  const provider = { id: "p", model: "model" };
  store.settings.activeProviderId = provider.id;
  store.settings.providers = [provider as any];
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  store.projects = [projectId, otherProjectId].map(id => ({
    id, name: id, description: "", instructions: "", createdAt: 1,
  }));
  const first = randomUUID(), second = randomUUID();
  let startedFirst!: () => void, startedSecond!: () => void, finishFirstPreparation!: () => void;
  const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
  const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
  const holdPreparation = new Promise<void>((resolve) => { finishFirstPreparation = resolve; });
  let preparing = false;
  const sends: string[] = [];
  const ctx = {
    root,
    account: () => ({ id: "owner" }),
    settings: () => store.settings,
    sessionIdentity: () => store,
    stateDirectory: () => root,
    isCurrent: () => true,
    modelCatalog: async () => ({ items: [{ id: "model" }] }),
    loadConversation: async (id: string) => store.conversations.find((row) => row.id === id),
    listConversations: async () => store.conversations,
    snapshot: async () => ({ conversations: store.conversations, projects: store.projects }),
    onEvent: () => () => {},
    createEmptyChat: (input: Parameters<typeof persistEmptyChat>[0]) =>
      persistEmptyChat(input, store, () => true, () => ({ cwd: root }), () => {}),
    call: async (method: string, input: { conversationId: string; text: string; thinkingMode: string; projectId?: string }) => {
      assert.equal(method, "send");
      assert.equal(input.thinkingMode, "standard");
      assert.equal(preparing, false, "native engine preparation may not overlap");
      preparing = true;
      sends.push(input.conversationId);
      const conversation = store.conversation(input.conversationId);
      assert.equal(input.projectId, conversation.projectId);
      conversation.turns.push({
        id: randomUUID(), prompt: input.text, attachments: [], items: [],
        status: "inProgress", createdAt: Date.now(),
      });
      if (conversation.id === first) {
        startedFirst();
        await holdPreparation;
      } else {
        assert.equal(store.conversation(first).turns.at(-1)?.status, "inProgress");
        startedSecond();
      }
      preparing = false;
      return structuredClone(conversation);
    },
    log() {},
  } as unknown as AdapterContext;
  const bootstrapContext = { ...ctx, completionProtocol: "text-chat-v1" as const, call: async () => null };
  const memoryGate = async (host: AdapterContext) =>
    (await bootstrapOf(host)).org_growthbook.features["3082987388"].defaultValue;
  assert.equal(await memoryGate(bootstrapContext), true);
  assert.equal(await memoryGate({ ...bootstrapContext, createEmptyChat: undefined }), false);
  assert.equal(await memoryGate({ ...bootstrapContext, completionProtocol: undefined }), false);
  assert.equal((await bootstrapOf(bootstrapContext)).account?.claudex_comparison_supported, true);
  assert.equal((await bootstrapOf({ ...bootstrapContext, createEmptyChat: undefined })).account?.claudex_comparison_supported, undefined);
  const openAdapter = () => createApiAdapter(ctx, { scoped: true, migrateLegacy: false, restCompletion: true });
  let adapter = openAdapter();
  const base = `/api/organizations/${organizationUuid("owner")}/chat_conversations`;
  const post = async (route: string, value: object) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
      method: "POST", url: route, headers: { "content-type": "application/json" },
    });
    let status = 0, body = "";
    await adapter(req as any, {
      writeHead: (code: number) => { status = code; },
      end: (data: string) => { body = data; },
    } as any);
    return { status, body };
  };
  const create = (id: string, disabled = false) => post(base, {
    uuid: id, name: id === first ? "Compare 1" : "Compare 2", model: "model",
    ...(id === first ? { project_uuid: projectId, is_temporary: false } : {}),
    ...(disabled ? { chat_memory_mode: "disabled" } : {}),
  });
  for (const result of await Promise.all([create(first), create(second, true)]))
    assert.equal(result.status, 200, result.body);
  const projectBody = { uuid: first, name: "Compare 1", model: "model", project_uuid: projectId };
  const replay = await post(base, projectBody);
  assert.equal(replay.status, 200, replay.body);
  assert.equal(JSON.parse(replay.body).project_uuid, projectId);
  assert.equal((await post(base, { ...projectBody, project_uuid: otherProjectId })).status, 409);
  const foreignId = randomUUID();
  assert.equal((await post(base, { ...projectBody, uuid: foreignId, project_uuid: randomUUID() })).status, 404);
  assert.ok(!store.conversations.some(row => row.id === foreignId));
  assert.equal(store.conversations.length, 2);
  assert.deepEqual(sends, []);
  for (const id of [first, second]) {
    const conversation = store.conversation(id);
    assert.equal(conversation.turns.length, 0);
    conversation.turns.push({
      id: randomUUID(), prompt: "An earlier Compare turn", attachments: [], items: [],
      status: "completed", createdAt: Date.now(),
    });
  }
  store.flush();
  store = new Store(root);
  adapter = openAdapter();
  assert.equal(store.conversation(first).projectId, projectId);
  assert.equal(store.conversation(second).memoryDisabled, true);
  const send = (id: string) => post(`${base}/${id}/completion`, {
    prompt: "Compare prompt", model: "model", rendering_mode: "messages", thinking_mode: "off",
    turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() },
  });
  assert.equal((await send(first)).status, 200);
  await firstStarted;
  assert.equal((await send(second)).status, 200);
  assert.deepEqual(sends, [first]);
  finishFirstPreparation();
  await secondStarted;
  assert.deepEqual(sends, [first, second]);
});
