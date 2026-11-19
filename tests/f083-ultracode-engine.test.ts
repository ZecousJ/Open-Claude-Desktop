import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Engine } from "../electron/engine/engine";
import { newConversation } from "../electron/engine/new-conversation";
import { saveCodeModelPreference } from "../electron/ipc/code-model-preferences";
import { registerWorkflowHandlers } from "../electron/ipc/workflow";
import { Store } from "../electron/store/store";
import { openPolicy } from "../shared/client-policy";
import { CodeUltracodeUnavailable } from "../shared/code-session-settings";
import type { Provider, Turn } from "../shared/types";

function account(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f083-engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const provider: Provider = {
    id: "p",
    name: "Provider",
    baseUrl: "https://unused.invalid",
    protocol: "responses",
    model: "capable",
    models: ["capable", "limited"],
  };
  store.settings.providers = [provider];
  const engine = new Engine(store, "unused", () => "", () => {});
  engine.policy = () => openPolicy;
  engine.modelEfforts = (_, model) => model === "capable" ? ["high", "xhigh"] : ["high"];
  const input = { mode: "code" as const, providerId: "p", model: "capable", text: "Review this", attachments: [] };
  return { root, store, provider, engine, input };
}

test("the registered Workflow consumes the start-of-turn choice while preserving keyword and classic effort", (t) => {
  const { store, engine, provider, input } = account(t);
  assert.equal(engine.codeUltracodeAvailable("p", "capable"), false);
  registerWorkflowHandlers(() => {}, { store, engine });
  assert.equal(engine.codeUltracodeAvailable("p", "limited"), false);
  const space = engine.createPeer({ environment: { kind: "space", spaceId: "session" } });
  const conversation = newConversation({ ...input, codeUltracode: true }, provider, engine.defaultWorkspace);
  const turn: Turn = { id: "t", prompt: "Review this", attachments: [], items: [], status: "inProgress", createdAt: 1, codeUltracode: true };
  conversation.turns.push(turn);
  const contextFor = (model = "capable") => space.turnContext(conversation, provider, model, "code");
  const instruction = (model?: string) => space.extensions.turnContext(contextFor(model))?.["workflows.ultracode"]?.value;
  assert.equal(space.codeUltracodeAvailable("p", "capable"), true);
  assert.ok(space.extensions.dynamicTools(contextFor()).some(tool => tool.name === "Workflow"));
  conversation.codeUltracode = false;
  assert.match(instruction() ?? "", /Ultracode is ON for this turn/);
  assert.match(instruction("limited") ?? "", /Ultracode is off for this turn/);
  turn.codeUltracode = false;
  assert.match(instruction() ?? "", /Ultracode is off for this turn/);
  turn.prompt = "ultracode this";
  assert.match(instruction() ?? "", /Ultracode is ON for this turn/);
  store.settings.workflows = { keywordTrigger: false };
  assert.match(instruction() ?? "", /Ultracode is off for this turn/);
  store.settings.codeEffort = "ultra";
  assert.match(instruction("limited") ?? "", /Ultracode is ON for this turn/);
  engine.policy = () => ({ ...openPolicy, workflows: false });
  assert.equal(space.codeUltracodeAvailable("p", "capable"), false);
  assert.match(instruction() ?? "", /workflows are unavailable/);
  assert.ok(space.extensions.dynamicTools(contextFor()).some(tool => tool.name === "Workflow"));
});

test("an unsupported Ultracode first send is refused before creating a session or workspace", async (t) => {
  const { engine, store, input } = account(t);
  registerWorkflowHandlers(() => {}, { engine, store });
  await assert.rejects(
    engine.send({ ...input, model: "limited", codeUltracode: true }),
    CodeUltracodeUnavailable,
  );
  assert.equal(store.conversations.length, 0);
  assert.equal(fs.existsSync(path.join(engine.defaultWorkspace, "sessions")), false);
});

test("the native rollout must already carry Workflow when enabling it in an existing thread", async (t) => {
  const { engine, store, input, provider } = account(t);
  registerWorkflowHandlers(() => {}, { engine, store });
  const context = { engine, store, accountGeneration: () => 1 };
  const conversation = newConversation(input, provider, engine.defaultWorkspace);
  store.conversations.push(conversation);
  const folder = path.join(engine.codexHome, "sessions", "2026", "11", "15");
  fs.mkdirSync(folder, { recursive: true });
  const setupRollout = (id: string, names: string[]) => {
    const record = { type: "session_meta", payload: { id, dynamic_tools: names.map(name => ({ name })) } };
    fs.writeFileSync(path.join(folder, `rollout-2026-11-15T10-00-00-${id}.jsonl`), JSON.stringify(record) + "\n");
  };
  const withoutWorkflow = "10000000-0000-4000-8000-000000000001";
  conversation.threadId = withoutWorkflow;
  setupRollout(withoutWorkflow, ["UnrelatedTool"]);
  await assert.rejects(saveCodeModelPreference(context, conversation, { codeUltracode: true }), CodeUltracodeUnavailable);
  assert.equal(conversation.codeUltracode, undefined);
  const withWorkflow = "10000000-0000-4000-8000-000000000002";
  conversation.threadId = withWorkflow;
  setupRollout(withWorkflow, ["Workflow"]);
  assert.equal((await saveCodeModelPreference(context, conversation, { codeUltracode: true })).codeUltracode, true);
});

test("a hosted named workflow must resolve inside the Code project", async (t) => {
  const { root, engine, store, provider, input } = account(t);
  registerWorkflowHandlers(() => {}, { engine, store });
  let approvals = 0;
  engine.requestAppApproval = async () => {
    approvals++;
    return { action: "decline" };
  };
  const outside = path.join(root, "outside");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(outside, "review.js"), "export const meta = { name: 'review', description: 'Review' }; return null");
  fs.symlinkSync(outside, path.join(cwd, ".claude", "workflows"), "junction");
  const conversation = newConversation(input, provider, cwd);
  conversation.environment = { kind: "space", spaceId: "session" };
  const turn: Turn = { id: "t", prompt: input.text, attachments: [], items: [], status: "inProgress", createdAt: 1 };
  conversation.threadId = "thread";
  conversation.turns.push(turn);
  const outcome = await engine.extensions.handleDynamicTool({
    conversation, turn, threadId: "thread", turnId: "t",
    callId: "call", namespace: null, tool: "Workflow",
    arguments: { name: "review" }, changed() {},
  });
  assert.equal(outcome.success, false);
  const diagnostic = outcome.contentItems[0];
  assert.equal(diagnostic?.type, "inputText");
  assert.match(diagnostic.text, /scriptPath must be/);
  assert.equal(approvals, 0);
});
