import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowExtension,
  type WorkflowEngine,
} from "../../electron/workflows/extension";
import { strictSchema } from "../../electron/workflows/extension-support";
import { workflowApprovalServer } from "../../electron/workflows/extension-support";
import { agentEffort } from "../../electron/workflows/extension-support";
import { workflowApproval } from "../../src/approval/approval-model";
import {
  officialCodeApprovalControls,
  officialCodeApprovalResult,
} from "../../electron/official-ui/api/cloud-code-approval";
import { codeElicitationOffer } from "../../electron/official-ui/native/command-permission";
import { mcpElicitationResponse } from "../../shared/mcp-elicitation";
import { tasksFromTurn } from "../../shared/workflow-model";
import type {
  Approval,
  Conversation,
  Settings,
  Turn,
} from "../../shared/types";

function fixture(answer: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wf-"));
  const asked: Record<string, unknown>[] = [];
  let request!: (params: Record<string, unknown>) => void;
  const requested = new Promise<Record<string, unknown>>((resolve) => {
    request = resolve;
  });
  const prompts: string[] = [];
  let n = 0;
  const engine: WorkflowEngine = {
    async startWorkflowAgent(_id, request, listener) {
      const threadId = `thread-${++n}`;
      prompts.push(request.prompt);
      setImmediate(() => {
        listener("item/completed", {
          item: {
            type: "agentMessage",
            id: `m-${n}`,
            text: request.outputSchema
              ? '{"ok":true}'
              : `done: ${request.prompt}`,
          },
        });
        listener("turn/completed", { turn: { status: "completed" } });
      });
      return { threadId, turnId: "turn", model: "fixture-model" };
    },
    async interruptWorkflowAgent() {},
    releaseWorkflowAgent() {},
    async requestAppApproval(_id, params) {
      asked.push(params);
      request(params);
      return answer;
    },
  };
  const settings = { workflows: { enabled: true } } as unknown as Settings;
  const extension = createWorkflowExtension({
    engine,
    root: () => root,
    settings: () => settings,
  });
  const turn: Turn = {
    id: "t1",
    prompt: "review",
    attachments: [],
    createdAt: 1000,
    status: "inProgress",
    items: [],
  };
  const conversation = {
    id: "c1",
    threadId: "thread",
    title: "Session",
    mode: "code",
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    archived: false,
    providerId: "fixture",
    model: "fixture-model",
    turns: [turn],
  } as Conversation;
  const call = (args: Record<string, unknown>, session = conversation) =>
    extension.handleDynamicTool!({
      conversation: session,
      turn: session.turns.at(-1),
      threadId: session.threadId ?? "",
      turnId: session.turns.at(-1)?.id ?? "",
      callId: "call-1",
      namespace: null,
      tool: "Workflow",
      arguments: args,
      changed: () => {},
    });
  return { root, asked, requested, prompts, turn, conversation, call };
}

const script = `export const meta = {
  name: 'two-step',
  description: 'Ask two agents',
  phases: [{ title: 'Ask' }],
}
phase('Ask')
const [a, b] = await parallel([
  () => agent('first', { label: 'one' }),
  () => agent('second', { label: 'two', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }),
])
return { a, b }`;

test("Not now on the Run workflow card runs nothing", async () => {
  const f = fixture({ action: "decline", content: null });
  const result = await f.call({ script });
  assert.equal(result?.success, false);
  assert.equal(f.turn.items.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.asked[0].serverName, workflowApprovalServer);
  assert.equal(f.asked[0].workflowName, "two-step");
});

for (const surface of ["desktop", "web"]) {
  test(`the ${surface} Code approval runs the workflow for the active turn`, async (t) => {
    let settle!: (reply: unknown) => void;
    const f = fixture(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const running = f.call({ script });
    const params = await f.requested;
    assert.deepEqual(f.prompts, []);
    const approval: Approval = {
      id: "app:workflow",
      conversationId: f.conversation.id,
      method: "mcpServer/elicitation/request",
      params,
    };
    const choice = { action: "accept", content: { decision: "once" } } as const;
    if (surface === "desktop") {
      const offer = codeElicitationOffer(approval, f.conversation);
      assert.ok(offer && "elicitationForm" in offer);
      assert.match(offer.elicitationForm.message, /two-step/);
      const response = mcpElicitationResponse(approval, choice);
      assert.equal(response?.action, "accept");
      settle(response);
    } else {
      const [control] = officialCodeApprovalControls(
        f.conversation,
        [approval],
        {},
      );
      assert.equal(control?.request.subtype, "elicitation");
      const response = officialCodeApprovalResult(
        f.conversation,
        [approval],
        {
          subtype: "success",
          request_id: control.request_id,
          response: choice,
        },
        {},
      );
      assert.equal(response.kind, "ready");
      settle(response.response);
    }
    assert.equal((await running)?.success, true);
    assert.deepEqual(f.prompts.sort(), ["first", "second"]);
  });
}

test("an approval resolving after the Code thread changes starts no workflow", async (t) => {
  let settle!: (reply: unknown) => void;
  const f = fixture(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const running = f.call({ script });
  await f.requested;
  f.conversation.threadId = "replacement";
  settle({ action: "accept", content: { decision: "once" } });
  await assert.rejects(async () => running, /Code turn is no longer active/);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.turn.items, []);
});

test("an accepted workflow runs its agents and becomes a finished run task", async () => {
  const f = fixture({ action: "accept", content: { decision: "once" } });
  const result = await f.call({ script });
  assert.equal(result?.success, true);
  const text = (result?.contentItems[0] as { text: string }).text;
  assert.match(text, /"a": "done: first"/);
  assert.match(text, /"ok": true/);
  assert.deepEqual(f.prompts.sort(), ["first", "second"]);
  const [task] = tasksFromTurn(f.turn, f.conversation);
  assert.equal(task.kind, "workflow");
  assert.equal(task.status, "completed");
  assert.equal(task.title, "two-step");
  assert.equal(task.description, "Ask two agents");
  assert.ok(task.runId?.startsWith("wf_"));
  assert.equal(task.agents.length, 2);
  assert.deepEqual(
    task.agents.map((agent) => agent.phase),
    ["Ask", "Ask"],
  );
  // The run keeps its script, record and journal for resume.
  const dir = path.join(f.root, "workflow-runs", task.runId!);
  for (const file of ["script.js", "run.json", "journal.jsonl", "result.json"])
    assert.ok(fs.existsSync(path.join(dir, file)), file);

  // Resume replays the finished agents without starting them again.
  const again = await f.call({ script, resumeFromRunId: task.runId });
  assert.equal(again?.success, true);
  assert.equal(f.prompts.length, 2);
  const tasks = tasksFromTurn(f.turn, f.conversation);
  assert.equal(tasks.length, 2, "each run is its own task");
});

test("hosted sessions reuse only their own recorded workflow scripts and journals", async (t) => {
  const f = fixture({ action: "accept", content: { decision: "once" } });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.conversation.environment = { kind: "space", spaceId: "first-space" };
  const first = await f.call({ script });
  assert.equal(first?.success, true);
  const [task] = tasksFromTurn(f.turn, f.conversation);
  assert.ok(task.runId);
  const scriptPath = path.join(
    f.root,
    "workflow-runs",
    task.runId,
    "script.js",
  );
  const other: Conversation = {
    ...f.conversation,
    id: "other-session",
    threadId: "other-thread",
    environment: { kind: "space", spaceId: "second-space" },
    turns: [{ ...f.turn, id: "other-turn", items: [] }],
  };
  await assert.rejects(
    async () => f.call({ scriptPath }, other),
    /not part of the conversation/,
  );
  await assert.rejects(
    async () => f.call({ script, resumeFromRunId: task.runId }, other),
    /not part of the conversation/,
  );
  assert.deepEqual(other.turns[0].items, []);
  const replayed = await f.call({ scriptPath, resumeFromRunId: task.runId });
  assert.equal(replayed?.success, true);
  assert.deepEqual(f.prompts.sort(), ["first", "second"]);
});

test("a failing script is a failed run with its reason", async () => {
  const f = fixture({ action: "accept", content: { decision: "once" } });
  const result = await f.call({
    script: `export const meta = { name: 'boom', description: 'Fails' }
throw new Error('nope')`,
  });
  assert.equal(result?.success, false);
  const [task] = tasksFromTurn(f.turn, f.conversation);
  assert.equal(task.status, "failed");
  assert.equal(task.summary, "nope");
});

test("the Run workflow question is recognized by the approval card", () => {
  const parsed = workflowApproval({
    id: "app:1",
    conversationId: "c1",
    method: "mcpServer/elicitation/request",
    params: { serverName: workflowApprovalServer, workflowName: "two-step" },
  });
  assert.deepEqual(parsed, { name: "two-step", description: undefined });
  assert.equal(
    workflowApproval({
      id: 2,
      conversationId: "c1",
      method: "mcpServer/elicitation/request",
      params: { serverName: "other" },
    }),
    undefined,
  );
});

test("agent efforts map to Codex's and schemas become strict", () => {
  assert.equal(agentEffort("max"), "xhigh");
  assert.equal(agentEffort("low"), "low");
  assert.equal(agentEffort("bogus"), undefined);
  assert.deepEqual(
    strictSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    }),
    {
      type: "object",
      properties: { a: { type: "string" }, b: { type: ["number", "null"] } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  );
});

test("a scriptPath link out of the project is refused", async () => {
  const f = fixture({ action: "accept", content: { decision: "once" } });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wf-project-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wf-outside-"));
  fs.writeFileSync(path.join(outside, "secret.js"), script);
  fs.symlinkSync(
    path.join(outside, "secret.js"),
    path.join(project, "link.js"),
  );
  fs.writeFileSync(path.join(project, "own.js"), script);
  (f.conversation as { cwd?: string }).cwd = project;
  await assert.rejects(
    async () => f.call({ scriptPath: "link.js" }),
    /scriptPath must be/,
  );
  const own = await f.call({ scriptPath: "own.js" });
  assert.equal(own?.success, true);
});

test("a saved workflow runs inline in the approved Code turn and shares its journal", async (t) => {
  const f = fixture({ action: "accept", content: { decision: "once" } });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.conversation.cwd = f.root;
  f.conversation.environment = { kind: "space", spaceId: "workspace" };
  const directory = path.join(f.root, ".claude", "workflows");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "summarize.js"), `
export const meta = { name: 'summarize', description: 'Summarize a result' }
phase('Summarize')
log(args.labels[0])
return { summary: await agent(args.text), labels: args.labels }
`);

  const parent = `
export const meta = { name: 'parent', description: 'Run a saved summary', phases: [{title: 'Parent'}] }
const child = await workflow('summarize', args)
return { child, parent: await agent('parent prompt') }
`;
  const input = { script: parent, args: { text: "nested prompt", labels: ["证据"] } };
  const result = await f.call(input);
  assert.equal(result?.success, true, JSON.stringify(result));
  const [run] = tasksFromTurn(f.turn, f.conversation);
  assert.equal(f.asked.length, 1);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.agents.map(({ phase }) => phase), ["Summarize", "Parent"]);
  assert.deepEqual(f.prompts, ["nested prompt", "parent prompt"]);
  const resultFile = path.join(f.root, "workflow-runs", run.runId!, "result.json");
  const receipt = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.deepEqual(receipt.value, {
    child: { summary: "done: nested prompt", labels: ["证据"] },
    parent: "done: parent prompt",
  });
  assert.deepEqual(receipt.logs, ["证据"]);
  assert.equal((await f.call({ ...input, resumeFromRunId: run.runId }))?.success, true);
  assert.deepEqual(f.prompts, ["nested prompt", "parent prompt"]);
});
