import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openPolicy } from "../../shared/client-policy";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { deepCreate, registryFor } from "../../electron/official-ui/api/timeline";
import { researchTaskId } from "../../electron/official-ui/api/research-projection";
import { officialUiActionPath, isOfficialUiAction, isOfficialUiQuery } from "../../shared/official-ui-web";

test("Research settings, status and exact Stop cross the Runner gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-gate-"));
  try {
    const id = "11111111-1111-4111-8111-111111111111", org = organizationUuid("a");
    const turn = { id: "turn", createdAt: 10, status: "inProgress", prompt: "x", items: [], attachments: [], research: { state: "gathering", startedAt: 11, sourceCount: 2 } };
    const conversation = { id, mode: "chat", model: "m", providerId: "p", createdAt: 9, turns: [turn] };
    const calls: string[] = [];
    let sent: any;
    let policy = openPolicy;
    const host = { account: () => ({ id: "a" }), settings: () => ({ activeProviderId: "p", providers: [{ id: "p", model: "m", protocol: "responses" }] }), sessionIdentity: () => root, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
    const dispatch = async (method: string, args: unknown[]) => {
      calls.push(method);
      if (method === "clientPolicy") return policy;
      if (method === "modelCatalog") return { items: [{ id: "m", webSearch: "native" }] };
      if (method === "send") { sent = args[0]; return { ...conversation, turns: [{ ...turn, id: "new-turn" }] }; }
      if (method === "snapshot") return { conversations: [conversation], projects: [] };
      if (method === "conversationTurns") return { turns: conversation.turns };
      if (method === "setConversationResearch") return { ...conversation, research: true };
      if (method === "interrupt") return { status: "accepted" };
      throw Error(method);
    };
    const build = path.resolve("build/official-ui"), registry = registryFor(build);
    const adapter = createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] }, { allowTextActions: true });
    const schema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
    const response = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
    const action = async (value: object, version: bigint) => {
      const body = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, existingOnly: true, mutationId: { sessionId: "research-test", version } }, action: value })));
      const result = await adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto", body });
      assert.equal(result.status, 200);
      return fromBinary(response, result.body) as any;
    };
    assert.equal((await action({ case: "updateConversationSettings", value: { settings: { researchMode: 2 } } }, 1n)).ack.outcome.case, "applied");
    const badBody = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, existingOnly: true, mutationId: { sessionId: "research-test", version: 3n } }, action: { case: "updateConversationSettings", value: { settings: { researchMode: 1 } } } })) );
    assert.equal((await adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto", body: badBody })).status, 400);
    const task = researchTaskId(org, conversation as never, turn as never)!;
    const base = `/api/organizations/${org}/chat_conversations/${id}/task/${task}`;
    assert.equal(isOfficialUiQuery("GET", `${base}/status`), true);
    assert.equal(isOfficialUiQuery("GET", `${base}/status`, "?x=1"), false);
    assert.equal(isOfficialUiAction("POST", `${base}/stop`), true);
    const status = await adapter({ method: "GET", path: `${base}/status` });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(Buffer.from(status.body).toString()).total_sources, 2);
    assert.equal((await action({ case: "stopResearchTask", value: { taskId: task } }, 2n)).ack.outcome.case, "applied");
    const stopped = await adapter({ method: "POST", path: `${base}/stop`, contentType: "application/json", body: Buffer.from("{}") });
    assert.equal(stopped.status, 200);
    const sendBody = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, mutationId: { sessionId: "research-test", version: 4n } }, action: { case: "sendMessage", value: { messageId: "22222222-2222-4222-8222-222222222222", assistantMessageId: "33333333-3333-4333-8333-333333333333", text: "/deep-research  example", settingsUpdate: { settings: { researchMode: 0, enabledWebSearch: false } } } } })));
    const sentResponse = await adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto", body: sendBody });
    assert.equal((fromBinary(response, sentResponse.body) as any).ack.outcome.case, "applied");
    assert.equal(sent.text, "/deep-research  example");
    assert.equal(sent.research, true);
    policy = { ...openPolicy, webSearch: false };
    const deniedBody = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, mutationId: { sessionId: "research-test", version: 5n } }, action: { case: "sendMessage", value: { messageId: "44444444-4444-4444-8444-444444444444", assistantMessageId: "55555555-5555-4555-8555-555555555555", text: "/deep-research blocked" } } })));
    const denied = await adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto", body: deniedBody });
    assert.equal((fromBinary(response, denied.body) as any).ack.outcome.case, "error");
    assert.equal(sent.text, "/deep-research  example");
    assert.ok(calls.includes("setConversationResearch"));
    assert.ok(calls.includes("interrupt"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
