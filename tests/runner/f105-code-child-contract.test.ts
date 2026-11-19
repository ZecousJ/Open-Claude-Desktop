import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { officialCodeHistoryRequest } from "../../shared/official-code-history";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import type { Conversation, AppEvent } from "../../shared/types";
import { useElectronShim } from "./runner-core-support.test";

function parent(): Conversation {
  return { id: "parent", title: "Parent", mode: "code", providerId: "provider", model: "model",
    pinned: false, archived: false, createdAt: 1, updatedAt: 1,
    turns: [{ id: "turn", prompt: "Parent request", createdAt: 1, attachments: [], status: "completed",
      items: [{ id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
        receiverThreadIds: ["child"], agentPrompt: "Inspect the child", agentsStates: { child: { status: "running" } } },
      { id: "answer", type: "agentMessage", text: "Parent answer" }] }] };
}
const child = { model: "model", turns: [
  { id: "first", prompt: "Inspect the child", createdAt: 1000, status: "completed" as const, attachments: [],
    items: [{ id: "answer", type: "agentMessage", text: "Real child answer" }] },
] };

test("Web child history is owned, paginated, and preserves the original Agent association", async () => {
  const c = parent(), owner = { id: "owner" }, identity = {};
  const calls: string[] = [];
  c.turns[0].items[0].agentThreads = { child: { id: "child", ...child } };
  const adapter = createRunnerOfficialAdapter({ account: () => owner, settings: () => ({}), sessionIdentity: () => identity,
    stateDirectory: () => os.tmpdir(), onEvent: () => () => {}, log() {}, appVersion: "test",
    officialCodeAgentHistory(id: string, agent: string) {
      calls.push(agent);
      return id === c.id && agent === "child" ? c : undefined;
    },
  } as never, async (method) => {
    if (method === "snapshot") return { conversations: [c] };
    throw Error(`Unexpected ${method}`);
  }, path.resolve("build/official-ui"), { modes: ["code"] });
  const key = cloudCodeSessionKey(c, owner.id);
  const base = `/v1/code/sessions/session_${key}/teleport-events`;
  assert.equal(officialCodeHistoryRequest("GET", base, "?session_agent_id=child&limit=1&limit=2"), undefined);
  const first = await adapter({ method: "GET", path: base + "?session_agent_id=child&limit=1" });
  assert.equal(first.status, 200);
  const page = JSON.parse(Buffer.from(first.body).toString());
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].payload.agentId, "child");
  assert.equal(page.data[0].payload.parent_tool_use_id, "turn:agent:spawn:child");
  assert.equal(page.data[0].source, "worker");
  assert.equal(page.data[0].payload.claudexSourceItem, undefined);
  const next = await adapter({ method: "GET", path: base + `?session_agent_id=child&cursor=${page.next_cursor}` });
  assert.equal(next.status, 200);
  assert.match(Buffer.from(next.body).toString(), /Real child answer/);
  assert.equal((await adapter({ method: "GET", path: base + "?session_agent_id=foreign" })).status, 404);
  assert.deepEqual(calls, ["child", "child", "foreign"]);
});

test("late child settlement and later parent turns leave acknowledged Web cursors unchanged", async () => {
  const c = parent(), owner = { id: "owner" }, identity = {};
  const adapter = createRunnerOfficialAdapter({ account: () => owner, settings: () => ({}), sessionIdentity: () => identity,
    stateDirectory: () => os.tmpdir(), onEvent: () => () => {}, log() {}, appVersion: "test" } as never,
  async method => {
    if (method === "snapshot") return { conversations: [c] };
    if (method === "conversationTurns") return { turns: c.turns };
    throw Error(`Unexpected ${method}`);
  }, path.resolve("build/official-ui"), { modes: ["code"] });
  const base = `/v1/code/sessions/session_${cloudCodeSessionKey(c, owner.id)}/events`;
  const get = async (suffix: string) => {
    const response = await adapter({ method: "GET", path: base + suffix });
    assert.equal(response.status, 200, Buffer.from(response.body).toString());
    return JSON.parse(Buffer.from(response.body).toString());
  };
  const before = await get("/stream?from_sequence_num=0");
  const last = before.data.at(-1);
  c.turns[0].items[0].agentsStates.child.status = "completed";
  const resumed = await get(`/stream?from_sequence_num=${last.sequence_num}&after_event_id=${last.event_id}`);
  assert.deepEqual(resumed.data, []);
  assert.equal(resumed.task_updates[0].status, "completed");
  const replay = await get("?sort_order=asc");
  assert.equal(replay.resume_cursor, String(last.sequence_num));
  assert.equal(replay.claudex_task_updates.at(-1).subtype, "task_notification");
  c.turns.push({ id: "later", prompt: "Later input", createdAt: 2, attachments: [], status: "completed",
    items: [{ id: "later-answer", type: "agentMessage", text: "Later answer" }] });
  const later = await get(`/stream?from_sequence_num=${last.sequence_num}&after_event_id=${last.event_id}`);
  assert.equal(later.data[0].sequence_num, last.sequence_num + 1);
  assert.equal(later.data[0].payload.message.content, "Later input");
  const listeners = new Set<(event: AppEvent) => void>();
  const fetch = createOfficialReadFetch("https://fixture.invalid", adapter, async () => { throw Error("Unexpected network"); },
    listener => { listeners.add(listener); return () => listeners.delete(listener); });
  const response = await fetch(base + "/stream?from_sequence_num=0");
  const reader = response.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.indexOf('"subtype":"task_notification"') > text.indexOf('"subtype":"task_started"'));
  assert.match(text, /event: client_event\ndata: .*"subtype":"task_notification"/);
  await reader.cancel();
});

test("Web streams resume across compaction settlement after Codex completes the item", async () => {
  const conversation = parent();
  const owner = { id: "owner" };
  const identity = {};
  const requestId = "450e4d5a-dad4-488f-8b2a-5e1780e42de7";
  const compaction: Conversation["turns"][number] = {
    id: "compaction-turn", prompt: "", createdAt: 2, attachments: [], status: "inProgress",
    compaction: "manual", compactionRequestId: requestId,
    items: [{ id: "compaction-item", type: "contextCompaction", lifecycleStatus: "completed" }],
  };
  const adapter = createRunnerOfficialAdapter({ account: () => owner, settings: () => ({}), sessionIdentity: () => identity,
    stateDirectory: () => os.tmpdir(), onEvent: () => () => {}, log() {}, appVersion: "test" } as never,
  async (method) => {
    if (method === "snapshot") return { conversations: [conversation] };
    if (method === "conversationTurns") return { turns: conversation.turns };
    throw Error(`Unexpected ${method}`);
  }, path.resolve("build/official-ui"), { modes: ["code"] });
  const base = `/v1/code/sessions/session_${cloudCodeSessionKey(conversation, owner.id)}/events/stream`;
  const get = async (query: string) => {
    const response = await adapter({ method: "GET", path: base + query });
    assert.equal(response.status, 200, Buffer.from(response.body).toString());
    return JSON.parse(Buffer.from(response.body).toString());
  };

  conversation.turns.push(compaction);
  const inProgress = await get("?from_sequence_num=0");
  const last = inProgress.data.at(-1);
  compaction.status = "completed";
  const settled = await get(`?from_sequence_num=${last.sequence_num}&after_event_id=${last.event_id}`);

  assert.equal(settled.data[0].sequence_num, last.sequence_num + 1);
  assert.equal(settled.data[0].payload.subtype, "compact_boundary");
  assert.equal(settled.data[0].payload.uuid, `${requestId}:boundary`);
  assert.equal(settled.session.worker_status, "idle");
});

test("original Web child controls execute only the owned child and retain stop request identity", async t => {
  useElectronShim();
  const [{ Store }, { submitOfficialCodeFollowup }] = await Promise.all([
    import("../../electron/store/store"), import("../../runner/src/official-code-followup"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f105-child-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), c = parent(), identity = {}, account = { id: "owner" };
  store.conversations = [c];
  const calls: string[] = [];
  const engine = { elsewhereFor: () => undefined, state: { state: "ready" }, rpc: { call: async (method: string) => {
    calls.push(method);
    return { thread: { id: "child", createdAt: 1, status: { type: "active" },
      turns: [{ id: "child-turn", status: "inProgress", items: child.turns[0].items }] } };
  } } };
  const ctx = { store, activeAccount: account, officialSessionIdentity: () => identity, engineFor: () => engine, push() {} };
  const key = cloudCodeSessionKey(c, account.id);
  const send = (wrapped: boolean, subtype: string, taskId: string, requestId: string) => {
    const event = { type: "control_request", uuid: "b5427249-f9fc-450e-8f4e-0be76af3c41a", request_id: requestId,
      request: { subtype, task_id: taskId } };
    return submitOfficialCodeFollowup({} as never, {} as never, ctx as never, { key, wrapped },
      { contentType: "application/json", body: Buffer.from(JSON.stringify({ events: [wrapped ? { payload: event } : event] })) }, () => true);
  };
  const output = await send(true, "get_task_output", "child", "read-child");
  assert.equal(output.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(output.body).toString()).response, { output: "Real child answer", truncated: false });
  assert.equal((await send(false, "stop_task", "foreign", "stop-foreign")).status, 404);
  assert.deepEqual(calls, ["thread/read"]);
  assert.equal((await send(false, "stop_task", "child", "stop-child")).status, 200);
  assert.equal((await send(false, "stop_task", "child", "stop-child")).status, 200);
  assert.deepEqual(calls, ["thread/read", "thread/read", "turn/interrupt"]);
  c.sessionAuthors = { ownerAccountUuid: account.id, viewerAccountUuid: "foreign" };
  assert.equal((await send(true, "get_task_output", "child", "read-foreign-viewer")).status, 404);
  assert.equal((await send(false, "stop_task", "child", "stop-foreign-viewer")).status, 404);
  assert.equal(calls.length, 3);
});
