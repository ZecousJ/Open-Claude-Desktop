import { bootstrapCatalog } from "../../shared/official-bootstrap-catalog";
import { bootstrapRead } from "../../src-web/official/bootstrap-read";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialUiActionPath, officialUiDefaultsPath, officialUiTimelinePath } from "../../shared/official-ui-web";
import { deepCreate, registryFor } from "../../electron/official-ui/api/timeline";
import { reserveOfficialAction } from "../../runner/src/official-ui-receipts";
import { storeAttachment } from "../../electron/engine/composer-files";
import { openPolicy } from "../../shared/client-policy";
import { Store } from "../../electron/store/store";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import { registerConversationManageHandlers } from "../../electron/ipc/conversation-manage-handlers";
import type { AppEvent, Conversation, Provider } from "../../shared/types";
import type { ModelCatalogItem } from "../../shared/model-catalog-api";

test("runner's read-only official adapter keeps accounts separate and refuses writes and host paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-runner-official-"));
  const build = path.resolve("build/official-ui");
  const contexts = ["a", "b"].map((id) => {
    const identity = {};
    const c = { id: "same-id", title: `private-${id}`, mode: "chat", model: "m", providerId: "p", turns: [], pinned: false, archived: false, createdAt: 1, updatedAt: 1 };
    const host = { account: () => ({ id, email: `${id}@example.invalid`, name: id }), settings: () => ({}), sessionIdentity: () => identity,
      webSearchAllowed: () => id === "a",
      stateDirectory: () => path.join(root, id), onEvent: () => () => {}, appVersion: "test", log() {} };
    const calls: string[] = [];
    const dispatch = async (method: string) => { calls.push(method); if (method === "usageRecords") return {items:[],total:0,page:1,pages:1}; if (method === "snapshot") return { conversations: [c], projects: [{ id: `project-${id}`, name: `project-${id}`, kind: "chat", createdAt: 1 }] }; if (method === "modelCatalog") return null; if (method === "mcpServers") return { servers: [{ name: `connector-${id}`, url: "https://example.invalid/mcp", state: "ready", toolList: [] }] }; if (method === "listSkills") return [{ skills: [{ name: `skill-${id}`, path: `/private/${id}/SKILL.md`, scope: "user" }] }]; if (method === "memoryStatus") return { available: id === "a", allowed: { generate: true, searchChats: true }, prefs: { generate: true, searchChats: id === "b" } }; throw Error(`Unexpected ${method}`); };
    return { adapter: createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] }), calls };
  });
  try {
    const webSearch = await Promise.all(contexts.map(async ({ adapter }, index) => {
      const response = await adapter({ method: "GET", path: `/api/bootstrap/${organizationUuid(index === 0 ? "a" : "b")}/current_user_access` });
      assert.equal(response.status, 200);
      const access = JSON.parse(Buffer.from(response.body).toString());
      return access.features.find((row: { feature: string }) => row.feature === "web_search")?.status;
    }));
    assert.deepEqual(webSearch, ["available", "blocked_by_org_admin"]);
    const [a, b] = await Promise.all(contexts.map(({ adapter }, index) => adapter({ method: "GET", path: `/api/organizations/${organizationUuid(index === 0 ? "a" : "b")}/chat_conversations_v2` })));
    // IDs are validated before reaching any account data.
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.match(Buffer.from(a.body).toString(), /private-a/);
    assert.doesNotMatch(Buffer.from(a.body).toString(), /private-b/);
    assert.match(Buffer.from(b.body).toString(), /private-b/);
    const projects = await contexts[0].adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/projects` });
    const projectRows = JSON.parse(Buffer.from(projects.body).toString());
    assert.equal(projectRows[0].name, "project-a");
    assert.equal(projectRows[0].permissions.includes("chat_project:delete"), false);
    assert.doesNotMatch(Buffer.from(projects.body).toString(), /project-b/);
    const connectors = await contexts[0].adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/mcp/remote_servers_with_connection` });
    assert.match(Buffer.from(connectors.body).toString(), /connector-a/);
    assert.doesNotMatch(Buffer.from(connectors.body).toString(), /connector-b/);
    const skills = await contexts[0].adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/skills/list-skills` });
    assert.match(Buffer.from(skills.body).toString(), /skill-a/);
    assert.doesNotMatch(Buffer.from(skills.body).toString(), /\/private\//);
    const memory = await Promise.all(contexts.map(({ adapter }, index) => adapter({ method: "GET", path: `/api/organizations/${organizationUuid(index === 0 ? "a" : "b")}/memory/settings` })));
    const [memoryA, memoryB] = memory.map((response) => JSON.parse(Buffer.from(response.body).toString()));
    assert.equal(memoryA.enabled_saffron, true);
    assert.equal(memoryA.enabled_saffron_search, false);
    assert.equal(memoryA.memory_mode, "classic");
    assert.equal(memoryB.enabled_saffron, false);
    assert.equal(memoryB.enabled_saffron_search, false);
    assert.equal(memoryB.classic_mode_available, false);
    for (const [index, id] of ["a", "b"].entries()) {
      const account = await contexts[index].adapter({ method: "GET", path: "/api/account" });
      assert.equal(account.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(account.body).toString()).claudex_usage_summary, {
        version: 1, account_uuid: id, organization_uuid: organizationUuid(id), read_only: true,
      });
    }
    assert.equal((await contexts[1].adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/memory/settings` })).status, 404);
    const usagePath = `/api/organizations/${organizationUuid("a")}/claudex_usage_activity/records`;
    const records = await contexts[0].adapter({method:"GET",path:usagePath+"?page=1&pageSize=10&start=2026-11-01&end=2026-11-03"});
    assert.equal(records.status,200);
    assert.deepEqual(JSON.parse(Buffer.from(records.body).toString()).data.items,[]);
    const callsBeforeInvalid = contexts[0].calls.length;
    assert.equal((await contexts[0].adapter({method:"GET",path:usagePath+"?page=1&pageSize=10"})).status,501);
    assert.equal(contexts[0].calls.length,callsBeforeInvalid);
    const discoverable = await contexts[0].adapter({ method: "GET", path: "/api/organizations/discoverable" });
    assert.deepEqual(JSON.parse(Buffer.from(discoverable.body).toString()), []);
    const experiences = await contexts[0].adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/experiences/claude_web` });
    assert.deepEqual(JSON.parse(Buffer.from(experiences.body).toString()), { experiences: [] });
    for (const request of [
      { method: "POST", path: `/api/organizations/${organizationUuid("a")}/chat_conversations_v2` },
      { method: "GET", path: "/api/a/files/../../etc/passwd/contents" },
    ]) assert.equal((await contexts[0].adapter(request as never)).status, 501);
    assert.equal((await contexts[0].adapter({ method: "POST", path: officialUiTimelinePath } as never)).status, 400);
    assert.equal((await contexts[0].adapter({ method: "GET", path: "http://evil.invalid/api/account" })).status, 400);
    assert.equal((await contexts[1].adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/chat_conversations_v2` })).status, 404);
    const boot = await contexts[0].adapter({ method: "GET", path: `/edge-api/bootstrap/${organizationUuid("a")}/app_start` });
    assert.equal(boot.status, 200);
    const messages = JSON.parse(fs.readFileSync(path.join(build, "data", "bootstrap-defaults.json"), "utf8")).gated_messages.messages;
    const catalog = bootstrapCatalog.parse({ revision: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), messages });
    const compact = await contexts[0].adapter({ method: "GET", path: `/edge-api/bootstrap/${organizationUuid("a")}/app_start`, bootstrapCatalogRevision: catalog.revision });
    assert.ok(compact.body.length < boot.body.length / 3);
    const read = bootstrapRead(contexts[0].adapter, Promise.resolve(catalog));
    const restored = await read({ method: "GET", path: `/edge-api/bootstrap/${organizationUuid("a")}/app_start` });
    assert.deepEqual(JSON.parse(Buffer.from(restored.body).toString()), JSON.parse(Buffer.from(boot.body).toString()));
    const mismatched = await contexts[0].adapter({ method: "GET", path: `/edge-api/bootstrap/${organizationUuid("a")}/app_start`, bootstrapCatalogRevision: "0".repeat(64) });
    assert.deepEqual(JSON.parse(Buffer.from(mismatched.body).toString()), JSON.parse(Buffer.from(boot.body).toString()));

    assert.equal(JSON.parse(Buffer.from(boot.body).toString()).account.uuid, "a");
    assert.deepEqual(JSON.parse(Buffer.from(boot.body).toString()).account.settings.enabled_mcp_tools, {});
    assert.equal("account_settings_template" in JSON.parse(Buffer.from(boot.body).toString()), false);
    assert.equal("organization_template" in JSON.parse(Buffer.from(boot.body).toString()), false);
    const access = await contexts[0].adapter({ method: "GET", path: `/api/bootstrap/${organizationUuid("a")}/current_user_access` });
    const expected = JSON.parse(fs.readFileSync(path.join(build, "data", "bootstrap-defaults.json"), "utf8")).current_user_access;
    const actualAccess = JSON.parse(Buffer.from(access.body).toString());
    const unavailable = ["work_across_apps", "skill_creation"];
    for (const feature of unavailable)
      assert.equal(actualAccess.features.find((row: any) => row.feature === feature).status, "blocked_by_platform");
    actualAccess.features = actualAccess.features.filter((row: any) => !unavailable.includes(row.feature));
    expected.features = expected.features.filter((row: any) => !unavailable.includes(row.feature));
    assert.deepEqual(actualAccess, expected);
    const defaults = await contexts[0].adapter({ method: "POST", path: officialUiDefaultsPath, contentType: "application/json", body: new TextEncoder().encode("{}") });
    assert.equal(defaults.status, 200);
    assert.equal(JSON.parse(Buffer.from(defaults.body).toString()).regular.workMode, "WORK_MODE_CHAT");
    assert.ok(contexts.every((c) => c.calls.every((method) => ["snapshot", "modelCatalog", "mcpServers", "listSkills", "memoryStatus", "usageRecords"].includes(method))));
  } finally {
    // Allow the adapter's existing 500 ms state-save queue to finish before
    // removing this synthetic account directory; do not suppress write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runner waits for a new Chat before returning its first account-owned timeline frame", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-official-timeline-"));
  const listeners = new Set<(event: AppEvent) => void>();
  try {
    const build = path.resolve("build/official-ui");
    const conversation: Conversation = { id: "timeline-id", title: "Test", mode: "chat", providerId: "p", model: "m", createdAt: 1, updatedAt: 1, pinned: false, archived: false,
      turns: [{ id: "turn", prompt: "PRIVATE_TIMELINE_TEST", attachments: [], items: [], status: "completed", createdAt: 1 }] };
    const snapshots = new EventEmitter();
    const initialSnapshot = once(snapshots, "read");
    let exists = false;
    const host = { account: () => ({ id: "a", email: "a@example.invalid", name: "a" }), settings: () => ({}), sessionIdentity: () => 1,
      stateDirectory: () => root, onEvent: (listener: (event: AppEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, appVersion: "test", log() {} };
    const adapter = createRunnerOfficialAdapter(host as never, async (method) => {
      if (method === "snapshot") {
        snapshots.emit("read");
        return { conversations: exists ? [conversation] : [], projects: [] };
      }
      if (method === "conversationTurns") return { turns: conversation.turns };
      throw Error(`Unexpected ${method}`);
    }, build, { modes: ["chat"] }, { allowTextActions: true });
    const schema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
    const payload = Buffer.from(toBinary(schema, create(schema, { conversationId: conversation.id })));
    const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1);
    const body = Buffer.concat([header, payload]);
    const opening = adapter({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto", body });
    await initialSnapshot;
    await new Promise<void>(resolve => setImmediate(resolve));
    exists = true;
    for (const listener of listeners) listener({ type: "conversation", conversation });
    const result = await opening;
    assert.equal(result.status, 200);
    assert.match(result.contentType, /application\/connect\+proto/);
    assert.ok(Buffer.from(result.body).includes(Buffer.from("PRIVATE_TIMELINE_TEST")));
    const responseSchema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.StreamTimelineResponse")!;
    const decoded = fromBinary(responseSchema, result.body.subarray(5)) as any;
    conversation.turns[0].prompt = "UPDATED_TIMELINE_TEST";
    const next = await adapter({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto", body });
    const decodedNext = fromBinary(responseSchema, next.body.subarray(5)) as any;
    assert.ok(Buffer.from(next.body).includes(Buffer.from("UPDATED_TIMELINE_TEST")));
    assert.ok(Number(decodedNext.event.version.value) > Number(decoded.event.version.value));
    for (let i = 0; i < 100 && listeners.size; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(listeners.size, 0);
    const otherHost = { ...host, account: () => ({ id: "b", email: "b@example.invalid", name: "b" }), stateDirectory: () => path.join(root, "b") };
    const other = createRunnerOfficialAdapter(otherHost as never, async (method) => {
      if (method === "snapshot") return { conversations: [], projects: [] };
      throw Error(`Unexpected ${method}`);
    }, build, { modes: ["chat"] });
    const denied = await other({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto", body });
    assert.equal(denied.status, 200);
    assert.ok(!Buffer.from(denied.body).includes(Buffer.from("UPDATED_TIMELINE_TEST")));
    const compressed = Buffer.from(body); compressed[0] = 1;
    assert.equal((await adapter({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto", body: compressed })).status, 400);
    const malformed = Buffer.from(body); malformed.writeUInt32BE(payload.length + 1, 1);
    assert.equal((await adapter({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto", body: malformed })).status, 400);
  } finally {
    // Allow the adapter's existing 500 ms state-save queue to finish before
    // removing this synthetic account directory; do not suppress write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official bootstrap defaults are isolated by build root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-official-builds-"));
  try {
    const responses = await Promise.all(["first", "second"].map(async (id) => {
      const build = path.join(root, id);
      fs.mkdirSync(path.join(build, "data"), { recursive: true });
      fs.writeFileSync(path.join(build, "data", "bootstrap-defaults.json"), JSON.stringify({ current_user_access: { marker: id } }));
      fs.copyFileSync(path.resolve("build/official-ui/data/conversation-protocol.json"), path.join(build, "data", "conversation-protocol.json"));
      const host = { account: () => ({ id: "account", email: "a@example.invalid", name: "a" }), settings: () => ({}), sessionIdentity: () => 1,
        stateDirectory: () => path.join(root, "state"), onEvent: () => () => {}, appVersion: "test", log() {} };
      const adapter = createRunnerOfficialAdapter(host as never, async () => { throw Error("Unexpected call"); }, build, { modes: ["chat"] });
      const response = await adapter({ method: "GET", path: `/api/bootstrap/${organizationUuid("account")}/current_user_access` });
      return JSON.parse(Buffer.from(response.body).toString()).marker;
    }));
    assert.deepEqual(responses, ["first", "second"]);
  } finally {
    // Allow the adapter's existing 500 ms state-save queue to finish before
    // removing this synthetic account directory; do not suppress write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("oversized official responses fail without terminating the runner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-official-large-"));
  try {
    const host = { account: () => ({ id: "a", email: "a@example.invalid", name: "a" }), settings: () => ({}), sessionIdentity: () => 1,
      stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
    const huge = "x".repeat(5 * 1024 * 1024);
    const adapter = createRunnerOfficialAdapter(host as never, async (method) => {
      if (method === "snapshot") return { conversations: [{ id: "id", title: huge, mode: "chat", turns: [], createdAt: 1, updatedAt: 1 }], projects: [] };
      throw Error("Unexpected call");
    }, path.resolve("build/official-ui"), { modes: ["chat"] });
    const response = await adapter({ method: "GET", path: `/api/organizations/${organizationUuid("a")}/chat_conversations_v2` });
    assert.equal(response.status, 413);
    assert.match(Buffer.from(response.body).toString(), /too large|supported bound|too much/i);
    assert.ok(response.body.byteLength < 4096, "oversized source returns a bounded error, not partial data");
    const alive = await adapter({ method: "GET", path: "/api/account" });
    assert.equal(alive.status, 200, "runner remains usable after bounded rejection");
  } finally {
    // Allow the adapter's existing 500 ms state-save queue to finish before
    // removing this synthetic account directory; do not suppress write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runner official adapter requires a current authenticated account", async () => {
  const adapter = createRunnerOfficialAdapter({ account: () => undefined, sessionIdentity: () => undefined } as never, async () => { throw Error("Must not dispatch"); }, path.resolve("build/official-ui"), { modes: ["chat"] });
  assert.equal((await adapter({ method: "GET", path: "/api/account" })).status, 401);
});

test("original picker protobuf sends the exact extracted file through the runner adapter", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-picker-"));
  t.after(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); fs.rmSync(root, { recursive: true, force: true }); });
  const id = "11111111-1111-4111-8111-111111111111", identity = {}, text = "F016 file picker test: the lighthouse is blue.\n";
  let sent: any, stored: any;
  const host = { account: () => ({ id: "picker", email: "fixture@example.invalid", name: "fixture" }),
    settings: () => ({ activeProviderId: "p", providers: [{ id: "p", backend: "sub2api", protocol: "responses", model: "m" }] }),
    sessionIdentity: () => identity, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
  const dispatch = async (method: string, args: unknown[]) => {
    if (method === "snapshot") return { conversations: [], projects: [] };
    if (method === "modelCatalog") return { defaultModel: "m", items: [{ id: "m", efforts: ["low"] }] };
    if (method === "addAttachmentData") { stored = storeAttachment(path.join(root, "attachments"), args[0] as string, args[1] as Uint8Array, openPolicy); return stored; }
    if (method === "send") { sent = args[0]; return { id, mode: "chat", turns: [] }; }
    throw Error(`Unexpected ${method}`);
  };
  const build = path.resolve("build/official-ui"), schema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const body = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, mutationId: { sessionId: "picker-test", version: 1n } },
    action: { case: "sendMessage", value: { messageId: "22222222-2222-4222-8222-222222222222", assistantMessageId: "33333333-3333-4333-8333-333333333333", text: "What color?",
      inlineAttachments: [{ fileName: "f016-picker-test.txt", fileType: "text/plain", fileSize: 47n, extractedContent: text }] } } })));
  const adapter = createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] }, { allowTextActions: true });
  const result = await adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto", body });
  assert.equal(result.status, 200);
  const response = fromBinary(registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!, result.body) as any;
  assert.equal(response.ack.outcome.case, "applied");
  assert.equal(stored.name, "f016-picker-test.txt.extracted.txt");
  assert.equal(fs.readFileSync(stored.path, "utf8"), text);
  assert.deepEqual(sent.attachments, [{ id: stored.id }]);
});

test("experimental official text sends remain deduplicated across account activation and runner restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-official-actions-"));
  const id = "11111111-1111-4111-8111-111111111111", user = "22222222-2222-4222-8222-222222222222", assistant = "33333333-3333-4333-8333-333333333333";
  const projectId = "88888888-8888-4888-8888-888888888888";
  let calls = 0, identity = {};
  let existing: any;
  let savedChoice: import("../../shared/model-catalog-api").ModelSelectorPreference = {};
  const sentArguments: any[] = [];
  const host = { account: () => ({ id: "a", email: "a@example.invalid", name: "a" }),
    settings: () => ({ activeProviderId: "p", providers: [{ id: "p", backend: "sub2api", protocol: "responses", model: "m" }] }),
    readModelPreference: () => savedChoice, sessionIdentity: () => identity, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
  const dispatch = async (method: string, args: unknown[]) => {
    if (method === "snapshot") return { conversations: existing ? [existing] : [], projects: [{ id: projectId, kind: "chat" }] };
    if (method === "conversationTurns") return { turns: existing?.turns ?? [] };
    if (method === "modelCatalog") return { defaultModel: "m", items: [{ id: "m", efforts: ["low", "high"] }] };
    if (method === "send") { calls++; const sent = args[0] as any; sentArguments.push(sent); if (sent.text === "FAIL_SEND") { await new Promise((resolve) => setTimeout(resolve, 1600)); throw Error("Model unavailable"); } assert.equal(sent.text, "SAFE_TEXT_SEND");
      return { id, mode: "chat", turns: [{ id: `turn-${calls}`, prompt: sent.text, attachments: [], items: [], createdAt: 1, status: "inProgress" }] }; }
    throw Error(`Unexpected ${method}`);
  };
  const build = path.resolve("build/official-ui");
  const adapter = createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] }, { allowTextActions: true });
  const disabled = createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] });
  const schema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const body = (text = "SAFE_TEXT_SEND", extra: object = {}, version = 1n) => Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, mutationId: { sessionId: "test-session", version } },
    action: { case: "sendMessage", value: { messageId: user, assistantMessageId: assistant, text, ...extra } } })));
  const request = { method: "POST" as const, path: officialUiActionPath, contentType: "application/proto", body: body("SAFE_TEXT_SEND", { settingsUpdate: { settings: { toolSearchMode: 2 } } }) };
  try {
    assert.equal((await disabled(request)).status, 501);
    const [one, retry] = await Promise.all([adapter(request), adapter(request)]);
    assert.equal(one.status, 200); assert.deepEqual(one.body, retry.body); assert.equal(calls, 1);
    assert.equal((await adapter({ ...request, body: body("DIFFERENT") })).status, 409);
    const rejectedBranch = await adapter({ ...request, body: body("SAFE_TEXT_SEND", { parentMessageId: assistant }, 4n) });
    const responseSchema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
    assert.equal((fromBinary(responseSchema, rejectedBranch.body) as any).ack.outcome.case, "error");
    const failed = await adapter({ ...request, body: body("FAIL_SEND", {}, 2n) });
    assert.equal((fromBinary(responseSchema, failed.body) as any).ack.outcome.case, "error");
    assert.equal(calls, 2);
    identity = {};
    assert.equal((await adapter(request)).status, 200);
    assert.equal(calls, 2);
    const restarted = createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] }, { allowTextActions: true });
    assert.equal((await restarted(request)).status, 200);
    assert.equal(calls, 2);
    const interrupted = body("SAFE_TEXT_SEND", {}, 3n);
    const interruptedHash = createHash("sha256").update(request.contentType).update(interrupted).digest("hex");
    assert.equal(reserveOfficialAction(root, "test-session:3", interruptedHash).kind, "reserved");
    const uncertain = await restarted({ ...request, body: interrupted });
    assert.equal(uncertain.status, 409);
    assert.match(Buffer.from(uncertain.body).toString(), /may have completed/);
    assert.equal(calls, 2);
    const withSettings = body("SAFE_TEXT_SEND", { settingsUpdate: { settings: { enabledWebSearch: false, researchMode: 0, effortLevelToken: "low", toolSearchMode: 3 } } }, 5n);
    assert.equal((await restarted({ ...request, body: withSettings })).status, 200);
    assert.equal(sentArguments.at(-1).webSearch, false);
    assert.equal(sentArguments.at(-1).research, false);
    assert.equal(sentArguments.at(-1).effort, "low");
    const invalidToolSearch = body("SAFE_TEXT_SEND", { settingsUpdate: { settings: { toolSearchMode: 99 } } }, 10n);
    assert.equal((await restarted({ ...request, body: invalidToolSearch })).status, 400);
    const unsupported = await restarted({ ...request, body: body("SAFE_TEXT_SEND", { settingsUpdate: { settings: { effortLevelToken: "xhigh" } } }, 6n) });
    assert.equal((fromBinary(responseSchema, unsupported.body) as any).ack.outcome.case, "error");
    assert.equal(calls, 3);
    existing = { id, mode: "chat", model: "m", providerId: "p", turns: [] };
    const update = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, existingOnly: true, mutationId: { sessionId: "test-session", version: 7n } },
      action: { case: "updateConversationSettings", value: { settings: { effortLevelToken: "high" } } } })));
    const updated = await restarted({ ...request, body: update });
    assert.equal(updated.status, 200);
    assert.notEqual((fromBinary(responseSchema, updated.body) as any).ack.outcome.case, "error");
    const followup = await restarted({ ...request, body: body("SAFE_TEXT_SEND", {messageId:"44444444-4444-4444-8444-444444444444",assistantMessageId:"55555555-5555-4555-8555-555555555555"}, 8n) });
    assert.equal(followup.status, 200);
    assert.equal(calls, 4);
    assert.equal(sentArguments.at(-1).effort, "high");
    existing = undefined;
    savedChoice = {model:"m", thinking:{type:"effort_and_mode",effort:"low",mode:"auto"}};
    const fresh = await restarted({ ...request, body: body("SAFE_TEXT_SEND", {messageId:"66666666-6666-4666-8666-666666666666",assistantMessageId:"77777777-7777-4777-8777-777777777777"}, 9n) });
    assert.equal(fresh.status, 200);
    assert.equal(calls, 5);
    assert.equal(sentArguments.at(-1).effort, "low");
    const inProject = body("SAFE_TEXT_SEND", {
      messageId: "99999999-9999-4999-8999-999999999999",
      assistantMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId,
    }, 10n);
    const acceptedProject = await restarted({ ...request, body: inProject });
    assert.equal(acceptedProject.status, 200);
    assert.notEqual((fromBinary(responseSchema, acceptedProject.body) as any).ack.outcome.case, "error");
    assert.equal(calls, 6);
    assert.equal(sentArguments.at(-1).projectId, projectId);
    const invalidProject = body("SAFE_TEXT_SEND", { projectId: "../other-project" }, 11n);
    assert.equal((await restarted({ ...request, body: invalidProject })).status, 400);
    const unavailableProject = body("SAFE_TEXT_SEND", { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, 12n);
    const unavailable = await restarted({ ...request, body: unavailableProject });
    assert.equal((fromBinary(responseSchema, unavailable.body) as any).ack.outcome.value.error.type, "not_found");
    existing = { id, mode: "chat", model: "m", providerId: "p", turns: [] };
    const mismatched = await restarted({ ...request, body: body("SAFE_TEXT_SEND", { projectId }, 13n) });
    assert.equal((fromBinary(responseSchema, mismatched.body) as any).ack.outcome.value.error.type, "invalid_argument");
    assert.equal(calls, 6);
  } finally {
    // Allow the adapter's existing 500 ms state-save queue to finish before
    // removing this synthetic account directory; do not suppress write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Android retries an existing reply without the Web existing-only header", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-android-retry-"));
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const assistantMessageId = "22222222-2222-4222-8222-222222222222";
  const originalTurn: Conversation["turns"][number] = {
    id: "turn-failed", prompt: "Recover my response", attachments: [], items: [], createdAt: 1, status: "failed",
  };
  const conversation: Conversation = {
    id: conversationId, title: "Chat", mode: "chat", model: "m", providerId: "p", turns: [originalTurn],
    pinned: false, archived: false, createdAt: 1, updatedAt: 1,
  };
  const host = { account: () => ({ id: "owner", email: "fixture@example.invalid", name: "fixture" }),
    settings: () => ({ providers: [{ id: "p", backend: "sub2api", protocol: "responses", model: "m" }] }),
    sessionIdentity: () => root, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
  const retries: unknown[][] = [];
  const build = path.resolve("build/official-ui"), registry = registryFor(build);
  const adapter = createRunnerOfficialAdapter(host as never, async (method, args) => {
    if (method === "snapshot") return { conversations: [conversation], projects: [] };
    if (method === "conversationTurns") return { turns: conversation.turns };
    if (method === "retryResponse") {
      retries.push(args);
      return { ...conversation, turns: [{ ...originalTurn, id: "new-branch-turn", status: "inProgress" }] };
    }
    throw Error(`Unexpected ${method}`);
  }, build, { modes: ["chat"] }, { allowTextActions: true });
  const query = registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
  const payload = toBinary(query, deepCreate(query, { conversationId }));
  const envelope = Buffer.alloc(5);
  envelope.writeUInt32BE(payload.length, 1);
  assert.equal((await adapter({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto",
    body: Buffer.concat([envelope, payload]) })).status, 200);

  const input = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const output = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const retry = (clientPlatform: number, version: bigint, target = conversationId,
    parentMessageId = "turn-failed:user", assistant = assistantMessageId) =>
    adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto",
      body: toBinary(input, deepCreate(input, {
        header: { conversationId: target, mutationId: { sessionId: "android-retry", version } },
        action: { case: "sendMessage", value: { assistantMessageId: assistant, parentMessageId, inputMode: 2, clientPlatform } },
      })) });

  assert.equal((await retry(1, 1n)).status, 400);
  assert.equal((await retry(4, 2n, conversationId, "")).status, 400);
  const missing = await retry(4, 3n, "33333333-3333-4333-8333-333333333333");
  assert.equal((fromBinary(output, missing.body) as any).ack.outcome.case, "error");
  assert.equal(retries.length, 0);
  const original = await retry(4, 4n);
  assert.equal((fromBinary(output, original.body) as any).ack.outcome.case, "applied");
  assert.deepEqual((await retry(4, 4n)).body, original.body);
  assert.deepEqual(retries.map(args => args.slice(0, 2)), [[conversationId, originalTurn.id]]);
  const replay = fromBinary(output, (await retry(4, 5n)).body) as any;
  assert.equal(replay.ack.outcome.case, "applied");
  assert.equal(replay.ack.highWaterMark.version, 5n);
  assert.equal(retries.length, 1);
  const newRetry = await retry(4, 6n, conversationId, "turn-failed:user", "44444444-4444-4444-8444-444444444444");
  assert.equal((fromBinary(output, newRetry.body) as any).ack.outcome.case, "applied");
  assert.equal(retries.length, 2);
});

test("the original Chat model selector saves an offered model for the existing conversation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-chat-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const account = { id: "owner", email: "owner@example.invalid", name: "Owner" };
  const identity = {};
  const provider: Provider = {
    id: "gateway", name: "Gateway", baseUrl: "https://fixture.invalid", protocol: "responses",
    backend: "sub2api", model: "first-model", models: ["first-model"],
    routes: [{ groupId: 1, groupName: "Extra", protocol: "responses", keyId: "extra", primary: false, models: ["second-model"] }],
  };
  store.settings.providers = [provider];
  store.settings.activeProviderId = provider.id;
  const id = "11111111-1111-4111-8111-111111111111";
  const foreignId = "22222222-2222-4222-8222-222222222222";
  const conversation: Conversation = {
    id, mode: "chat", title: "Existing", model: provider.model, providerId: provider.id, effort: "high",
    turns: [], pinned: false, archived: false, createdAt: 1, updatedAt: 1,
  };
  store.conversations.push(conversation, {
    ...conversation, id: foreignId,
    sessionAuthors: { ownerAccountUuid: "someone-else", viewerAccountUuid: account.id },
  });
  store.flush();
  let updates = 0;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerConversationManageHandlers({
    context: { store, engine: {} as never, activeAccount: account, accountGeneration: () => identity,
      replyFeedback: new ReplyFeedback(root), selectedAttachments: new Map(), allowedFolder() {}, noActive() {},
      push: () => { updates++; } },
    engineOf: () => undefined,
    handle: (name, handler) => handlers.set(name, handler),
  });
  const build = path.resolve("build/official-ui");
  const input = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const output = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const items: Pick<ModelCatalogItem, "id" | "efforts" | "defaultEffort">[] = [
    { id: "first-model", efforts: ["high"] },
    { id: "second-model", efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "catalog-only" },
  ];
  const host = { account: () => account, settings: () => store.settings,
    sessionIdentity: () => identity, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
  const dispatch = async (method: string, args: unknown[]) => {
    if (method === "snapshot") return { conversations: structuredClone(store.conversations), projects: [] };
    if (method === "modelCatalog") return { defaultModel: provider.model, items };
    if (method === "updateConversation") return handlers.get(method)!(...args);
    throw Error(`Unexpected ${method}`);
  };
  const run = createRunnerOfficialAdapter(host as never, dispatch, build, { modes: ["chat"] }, { allowTextActions: true });
  const select = (model: string, version: bigint, conversationId = id) => ({
    method: "POST" as const, path: officialUiActionPath, contentType: "application/proto",
    body: toBinary(input, deepCreate(input, {
      header: { conversationId, mutationId: { sessionId: "model-picker", version } },
      action: { case: "setConversationModel", value: { model: { id: { case: "identifier", value: model } } } },
    })),
  });
  const ack = (body: Uint8Array) => (fromBinary(output, body) as any).ack;
  const first = select("second-model", 1n);
  const [saved, replay] = await Promise.all([run(first), run(first)]);
  assert.equal(saved.status, 200);
  assert.equal(ack(saved.body).outcome.case, "applied");
  assert.deepEqual(replay.body, saved.body);
  assert.equal(updates, 1);
  for (const [request, type] of [
    [select("unpublished", 2n), "invalid_argument"],
    [select("catalog-only", 3n), "invalid_argument"],
    [select("second-model", 4n, foreignId), "not_found"],
  ] as const) {
    const refused = await run(request);
    assert.equal(refused.status, 200);
    const result = ack(refused.body);
    assert.equal(result.outcome.value.error.type, type);
    assert.equal(result.outcome.value.action, "set_conversation_model");
    assert.equal(result.highWaterMark.sessionId, "model-picker");
  }
  assert.equal(updates, 1);
  const reopened = new Store(root);
  assert.equal(reopened.conversation(id).model, "second-model");
  assert.equal(reopened.conversation(id).effort, "medium");
  assert.equal(reopened.conversation(foreignId).model, "first-model");
  assert.equal(reopened.settings.providers[0].model, "first-model");
});

test("original Web rich quotes preserve owned source and comment before a single send", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-web-rich-quote-"));
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = "11111111-1111-4111-8111-111111111111";
  const firstUser = "22222222-2222-4222-8222-222222222222";
  const firstAssistant = "33333333-3333-4333-8333-333333333333";
  let existing: any;
  let changeSourceDuringCatalog = false;
  const sends: any[] = [];
  const identity = {};
  const host = {
    account: () => ({ id: "a", email: "fixture@example.invalid", name: "Fixture" }),
    settings: () => ({ activeProviderId: "p", providers: [{ id: "p", model: "m", protocol: "responses" }] }),
    sessionIdentity: () => identity, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {},
  };
  const adapter = createRunnerOfficialAdapter(host as never, async (method, args) => {
    if (method === "snapshot") return { conversations: existing ? [existing] : [], projects: [] };
    if (method === "conversationTurns") return { turns: existing?.turns ?? [] };
    if (method === "modelCatalog") {
      if (changeSourceDuringCatalog) {
        changeSourceDuringCatalog = false;
        existing.turns[0].items[0].text = "The source was replaced.";
      }
      return { defaultModel: "m", items: [{ id: "m", efforts: ["low"] }] };
    }
    if (method !== "send") throw Error("Unexpected dispatch " + method);
    const input = args[0] as any;
    sends.push(structuredClone(input));
    const row = {
      id: input.newConversationId ?? input.conversationId, mode: "chat", providerId: "p", model: "m",
      createdAt: 1, updatedAt: 1,
      turns: [...(existing?.turns ?? []), {
        id: "turn-" + sends.length, prompt: input.text, createdAt: 1, status: "completed",
        attachments: [], items: [{ id: "answer-" + sends.length, type: "agentMessage", text: "A **visible source** here." }],
        ...(input.completionQuotes ? { completionQuotes: input.completionQuotes } : {}),
      }],
    };
    existing = row;
    return structuredClone(row);
  }, path.resolve("build/official-ui"), { modes: ["chat"] }, { allowTextActions: true });
  const registry = registryFor(path.resolve("build/official-ui"));
  const requestSchema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const responseSchema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const send = async (version: bigint, text: string, extra: object = {}) => {
    const value = { header: { conversationId: id, mutationId: { sessionId: "rich-session", version } },
      action: { case: "sendMessage", value: { messageId: version === 1n ? firstUser : `44444444-4444-4444-8444-${String(version).padStart(12, "0")}`,
        assistantMessageId: version === 1n ? firstAssistant : `55555555-5555-4555-8555-${String(version).padStart(12, "0")}`, text, ...extra } } };
    const response = await adapter({ method: "POST", path: officialUiActionPath, contentType: "application/proto",
      body: Buffer.from(toBinary(requestSchema, deepCreate(requestSchema, value))) });
    return { status: response.status, ack: response.status === 200 ? (fromBinary(responseSchema, response.body) as any).ack : undefined };
  };
  assert.equal((await send(1n, "seed")).ack.outcome.case, "applied");
  const quote = { passage: { case: "excerpt", value: { text: "visible source", targetMessageId: firstAssistant } }, comment: "Explain" };
  const accepted = await send(2n, "follow-up", { quotes: [quote] });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.ack.outcome.case, "applied");
  assert.equal(sends.length, 2);
  assert.equal(sends[1].text, "> visible source\n\nExplain\n\nfollow-up");
  assert.equal(sends[1].completionQuotes[0].passage.value.targetMessageId, firstAssistant);
  assert.equal(sends[1].completionQuotes[0].comment, "Explain");
  const foreign = { ...quote, passage: { case: "excerpt", value: { text: "visible source", targetMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } };
  const denied = await send(3n, "bad", { quotes: [foreign] });
  assert.equal(denied.ack.outcome.case, "error");
  assert.equal(sends.length, 2);
  changeSourceDuringCatalog = true;
  const changed = await send(4n, "stale", {
    quotes: [quote],
    settingsUpdate: { settings: { effortLevelToken: "low" } },
  });
  assert.equal(changed.ack.outcome.case, "error");
  assert.equal(sends.length, 2);
  existing.turns[0].items[0].text = "A **visible source** here.";
  const commentOnly = await send(5n, "", { quotes: [quote] });
  assert.equal(commentOnly.ack.outcome.case, "applied");
  assert.equal(sends.length, 3);
  assert.equal(sends[2].text, "> visible source\n\nExplain\n\n");
});

test("engine Chat REST preserves quoted sources and accepts ordinary extracted text",async t=>{
 const {storeAttachment}=await import("../../electron/engine/composer-files");const {openPolicy}=await import("../../shared/client-policy");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"web-rest-excerpt-"));t.after(async()=>{await new Promise(resolve=>setTimeout(resolve,550));fs.rmSync(root,{recursive:true,force:true});});
 const id="11111111-1111-4111-8111-111111111111",identity={},owner="web-excerpt-owner",uploads=new Map<string,any>();let sends=0;
 let conversation:any={id,mode:"chat",providerId:"p",model:"model",createdAt:1,updatedAt:1,turns:[{id:"seed",prompt:"first",items:[{id:"answer",type:"agentMessage",text:"Original quoted passage"}],attachments:[],createdAt:1,status:"completed"}],savedBranches:[]};
 const host:any={richQuoteActions:true,account:()=>({id:owner}),settings:()=>({activeProviderId:"p",providers:[{id:"p",model:"model",models:["model"]}]}),sessionIdentity:()=>identity,stateDirectory:()=>root,onEvent:()=>()=>{},appVersion:"test",log:()=>{}};
 const dispatch=async(method:string,args:any[])=>{
  if(method==="snapshot")return {projects:[],conversations:[conversation]};
  if(method==="conversationTurns")return conversation;
  if(method==="modelCatalog")return {items:[{id:"model",efforts:[]}]};
  if(method==="addAttachmentData"){const file=storeAttachment(path.join(root,"attachments"),args[0],args[1],openPolicy);uploads.set(file.id,file);return file;}
  if(method==="turnAttachment"){const file=uploads.get(args[1]);return file?{name:file.name,data:fs.readFileSync(file.path)}:null;}
  if(method==="send"){sends++;const input=args[0];conversation={...conversation,turns:[...conversation.turns,{id:"new",prompt:input.text,items:[{id:"reply",type:"agentMessage",text:"Done"}],attachments:input.attachments.map((a:any)=>uploads.get(a.id)),inlineAttachmentDisplays:structuredClone(input.inlineAttachmentDisplays),createdAt:2,status:"completed"}]};return structuredClone(conversation);}
  throw Error("Unexpected "+method);
 };
 const adapter=createRunnerOfficialAdapter(host,dispatch,path.resolve("build/official-ui"),{modes:["chat"]},{allowTextActions:true});
 const url=`/api/organizations/${organizationUuid(owner)}/chat_conversations/${id}/completion`,parent="seed:assistant";
 const make=(attachment:any,target=parent)=>({prompt:"Explain",model:"model",tools:[],files:[],sync_sources:[],rendering_mode:"messages",parent_message_uuid:target,turn_message_uuids:{human_message_uuid:crypto.randomUUID(),assistant_message_uuid:crypto.randomUUID()},completion_request_id:crypto.randomUUID(),attachments:[attachment]});
 const excerpt={file_name:"excerpt_from_previous_claude_message.txt",file_type:"txt",file_size:6,extracted_content:"quoted",kind:"excerpt",origin:"user_upload",quote_message_uuid:parent};
 const send=(body:any)=>adapter({method:"POST",path:url,contentType:"application/json",body:Buffer.from(JSON.stringify(body))});
 const firstBody=make(excerpt);const accepted=await send(firstBody);assert.equal(accepted.status,200);assert.equal(sends,1);
 const nextParent=firstBody.turn_message_uuids.assistant_message_uuid;
 const history=await adapter({method:"GET",path:`/api/organizations/${organizationUuid(owner)}/chat_conversations/${id}`});
 assert.equal(history.status,200);const messages=JSON.parse(Buffer.from(history.body).toString()).chat_messages;
 const sent=messages.find((row:any)=>row.sender==="human"&&row.text==="Explain");assert.equal(sent.attachments[0].quote_message_uuid,parent);assert.equal(sent.attachments[0].extracted_content,"quoted");assert.equal(Buffer.from(history.body).toString().includes(root),false);
 assert.equal((await send(make({...excerpt,quote_message_uuid:"foreign:assistant"},nextParent))).status,409);
 assert.equal((await send(make({...excerpt,file_name:"other.txt"},nextParent))).status,400);
 const arbitrary={...make(excerpt,nextParent),attachments:[],files:["unrelated-file"]};assert.equal((await send(arbitrary)).status,404);assert.equal(sends,1);
 const regular={file_name:"notes.txt",file_type:"txt",file_size:11,extracted_content:"hello world",kind:"file",origin:"user_upload"};
 const ordinary=await send(make(regular,nextParent));assert.equal(ordinary.status,200);assert.equal(sends,2);
 const current=conversation.turns.at(-1).attachments[0];assert.equal(fs.readFileSync(current.path,"utf8"),"hello world");
});

test("original branch continuation is admitted only with a Chat lease and deduplicated", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-branch-action-"));
  t.after(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); fs.rmSync(root, { recursive: true, force: true }); });
  const source = "11111111-1111-4111-8111-111111111111", destination = "22222222-2222-4222-8222-222222222222";
  const turn = { id: "early", prompt: "early prompt", attachments: [], items: [], status: "completed", createdAt: 1 };
  const conversation = { id: source, title: "Source", mode: "chat", providerId: "p", model: "m", createdAt: 1, updatedAt: 1, turns: [turn], savedBranches: [] };
  const host = { account: () => ({ id: "a", email: "a@example.invalid", name: "a" }), settings: () => ({}), sessionIdentity: () => 1, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
  const calls: unknown[][] = [];
  const build = path.resolve("build/official-ui"), registry = registryFor(build);
  const adapter = createRunnerOfficialAdapter(host as never, async (method, args) => {
    if (method === "snapshot") return { conversations: [conversation], projects: [] };
    if (method === "conversationTurns") return { turns: conversation.turns, savedBranches: [] };
    if (method === "forkConversation") { calls.push(args); return { ...conversation, id: destination, forkedFrom: { conversationId: source, turnId: "early" } }; }
    throw Error(`Unexpected ${method}`);
  }, build, { modes: ["chat"] }, { allowTextActions: true });
  const timeline = registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
  const payload = Buffer.from(toBinary(timeline, create(timeline, { conversationId: source })));
  const prefix = Buffer.alloc(5); prefix.writeUInt32BE(payload.length, 1);
  assert.equal((await adapter({ method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto", body: Buffer.concat([prefix, payload]) })).status, 200);
  const schema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const body = Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: destination, mutationId: { sessionId: "branch-test", version: 1n } }, action: { case: "continueBranchAsNewChat", value: { sourceConversationId: source, throughMessageId: "early:assistant" } } })));
  const request = { method: "POST" as const, path: officialUiActionPath, contentType: "application/proto", body };
  assert.equal((await adapter(request)).status, 400);
  const response = await adapter({ ...request, capabilityLease: "lease" });
  assert.equal(response.status, 200);
  const result = fromBinary(registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!, response.body) as any;
  assert.equal(result.ack.outcome.case, "applied");
  assert.deepEqual(calls, [[source, { turnId: "early", conversationId: destination }]]);
  assert.deepEqual((await adapter({ ...request, capabilityLease: "lease" })).body, response.body);
  assert.equal(calls.length, 1);
});

test("protobuf conversation metadata changes target only the requested chat", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-metadata-action-"));
  const build = path.resolve("build/official-ui");
  const schema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const responseSchema = registryFor(build).getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const id = "22222222-2222-4222-8222-222222222222";
  const conversation = { id, mode: "chat", title: "Before", pinned: false, archived: false, turns: [] };
  const writes: unknown[][] = [];
  const host = { account: () => ({ id: "a", email: "a@example.invalid", name: "A" }), settings: () => ({}),
    sessionIdentity: () => 1, stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {} };
  const adapter = createRunnerOfficialAdapter(host as never, async (method, args) => {
    if (method === "snapshot") return { conversations: [conversation], projects: [] };
    if (method === "updateConversation") { writes.push(args); Object.assign(conversation, args[1]); return conversation; }
    throw Error(`Unexpected ${method}`);
  }, build, { modes: ["chat"] }, { allowTextActions: true });
  const request = (action: object, version: bigint) => ({ method: "POST" as const, path: officialUiActionPath, contentType: "application/proto",
    body: Buffer.from(toBinary(schema, deepCreate(schema, { header: { conversationId: id, mutationId: { sessionId: "metadata-session", version } }, action }))) });
  try {
    for (const [index, action] of [
      { case: "renameConversation", value: { title: "After" } },
      { case: "starConversation", value: { starred: true } },
      { case: "archiveConversation", value: { archived: true } },
      { case: "archiveConversation", value: { archived: false } },
    ].entries()) {
      const result = await adapter(request(action, BigInt(index + 1)));
      assert.equal(result.status, 200);
      assert.equal((fromBinary(responseSchema, result.body) as any).ack.outcome.case, "applied");
    }
    assert.deepEqual(writes, [[id, { title: "After" }], [id, { pinned: true }], [id, { archived: true }], [id, { archived: false }]]);
    const noChat = createRunnerOfficialAdapter(host as never, async () => { throw Error("must not dispatch"); }, build, { modes: ["code"] }, { allowTextActions: true });
    assert.equal((await noChat(request({ case: "archiveConversation", value: { archived: true } }, 9n))).status, 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
