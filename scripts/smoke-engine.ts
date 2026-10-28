/** Real bundled Codex + isolated state + loopback mock; no user credentials or paid API calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import type { ChildProcess } from "node:child_process";
import type { AppEvent, Conversation, Protocol } from "../shared/types";
import { latestGeneratedFiles } from "../shared/generated-files";
import {
  refreshWorkflowAgents,
  readWorkflowAgent,
  stopWorkflowAgent,
} from "../electron/ipc/workflow";
import { workflowFromTurn } from "../shared/workflow-model";
import { runningCommandTasks } from "../src/conversation/running-command-tasks";
import { Engine } from "../electron/engine/engine";
import { itemIsRunning, turnActivity } from "../shared/activity";
import { Store } from "../electron/store/store";
import { resolveRuntime } from "../electron/engine/runtime";
import {
  ResearchReports,
  createResearchExtension,
} from "../electron/ipc/research";

type Json = Record<string, any>;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-engine-smoke-"));
const providerServiceScript = path.join(root, "provider-service.cjs");
const model = "gpt-5.2-codex";
const fakeKey = "local-smoke-key-not-a-real-credential";
const marker = "CLAUDEX_TOOL_OK";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, ms = 25_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}
function flattenTools(tools: Json[], namespace?: string): Json[] {
  return tools.flatMap((tool) =>
    tool.type === "namespace"
      ? flattenTools(tool.tools ?? [], tool.name)
      : [{ ...tool, namespace }],
  );
}
function textOf(messages: Json[]) {
  return messages
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : (item.content ?? []).map((part: Json) => part.text ?? "").join("\n"),
    )
    .join("\n");
}
function responseEvents(
  output: Json[],
  responseId: string,
  requestedModel: string,
) {
  let sequence = 0;
  const events: Json[] = [];
  const add = (event: Json) =>
    events.push({ ...event, sequence_number: sequence++ });
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: {
      input_tokens: 30,
      output_tokens: 8,
      total_tokens: 38,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  add({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  });
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    add({
      type: "response.output_item.added",
      output_index: i,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "message"
          ? { content: [] }
          : item.type === "custom_tool_call"
            ? { input: "" }
            : { arguments: "" }),
      },
    });
    if (item.type === "message") {
      const part = item.content[0];
      add({
        type: "response.content_part.added",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        part: { ...part, text: "" },
      });
      add({
        type: "response.output_text.delta",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        delta: part.text,
      });
      add({
        type: "response.output_text.done",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        text: part.text,
      });
      add({
        type: "response.content_part.done",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        part,
      });
    } else if (item.type === "web_search_call") {
      // A built-in search has no streamed arguments.
    } else if (item.type === "custom_tool_call") {
      add({
        type: "response.custom_tool_call_input.delta",
        output_index: i,
        item_id: item.id,
        delta: item.input,
      });
      add({
        type: "response.custom_tool_call_input.done",
        output_index: i,
        item_id: item.id,
        input: item.input,
      });
    } else {
      add({
        type: "response.function_call_arguments.delta",
        output_index: i,
        item_id: item.id,
        delta: item.arguments,
      });
      add({
        type: "response.function_call_arguments.done",
        output_index: i,
        item_id: item.id,
        arguments: item.arguments,
      });
    }
    add({ type: "response.output_item.done", output_index: i, item });
  }
  add({ type: "response.completed", response });
  return events;
}

let activeProtocol: Protocol = "responses";
let scenario:
  | "hello"
  | "tool"
  | "approval"
  | "followup"
  | "hold"
  | "recover"
  | "restore"
  | "branch"
  | "branchContinue"
  | "originalContinue"
  | "fileCreate"
  | "fileUpdate"
  | "manualFile"
  | "autoFile"
  | "plan"
  | "effort"
  | "webSearch"
  | "agent"
  | "agentHold"
  | "background"
  | "research" = "hello";
let expectedChatEffort: "xhigh" | "max" = "xhigh";
let expectedWebSearch = false;
let requestNumber = 0;
let branchHistoryCheck: ((history: Json[]) => void) | undefined;
let toolRequested = false;
let toolOutputSeen = false;
let childAgentRequestSeen = false;
let historySeen = false;
let heldRequests = 0;
let closedRequests = 0;
let requestError: Error | undefined;
/** What the research scenario's mock saw of the Research thread. */
const researchSeen = {
  tools: false,
  instructions: false,
  steps: [] as string[],
};
const researchSources = [
  { type: "url", url: "https://density.example/rows", title: "Row density" },
  { type: "url", url: "https://tooltips.example/a11y", title: "Tooltips" },
];
const researchReport =
  "# Sidebar Density Findings\n\nIntro.\n\n## TL;DR\n\n- Rows of 28px ([source](https://density.example/rows)).\n";
/** The mock model's Research turn: plan, then search and report, then a summary. */
function researchStep(body: Json, history: Json[]): Json[] {
  const tools = flattenTools(body.tools ?? []);
  researchSeen.tools ||=
    ["research_plan", "research_report"].every((name) =>
      tools.some((tool) => tool.name === name && !tool.namespace),
    ) && tools.some((tool) => tool.type === "web_search");
  researchSeen.instructions ||= /Research mode is on/.test(
    JSON.stringify(history),
  );
  assert(
    (body.include ?? []).includes("web_search_call.action.sources"),
    "The gateway did not ask for search sources.",
  );
  const answered = (callId: string) =>
    history.some(
      (item) => item.type === "function_call_output" && item.call_id === callId,
    );
  if (!answered("call_research_plan")) {
    researchSeen.steps.push("plan");
    return [
      {
        id: `fc_plan_${requestNumber}`,
        type: "function_call",
        call_id: "call_research_plan",
        name: "research_plan",
        arguments: JSON.stringify({
          title: "Sidebar density",
          questions: ["Row heights?", "Tooltip accessibility?"],
        }),
        status: "completed",
      },
    ];
  }
  if (!answered("call_research_report")) {
    researchSeen.steps.push("search+report");
    return [
      {
        id: "ws_research_1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "sidebar row density",
          sources: researchSources,
        },
      },
      {
        id: `fc_report_${requestNumber}`,
        type: "function_call",
        call_id: "call_research_report",
        name: "research_report",
        arguments: JSON.stringify({
          title: "Sidebar Density Findings",
          markdown: researchReport,
        }),
        status: "completed",
      },
    ];
  }
  researchSeen.steps.push("summary");
  return [
    {
      id: `msg_${requestNumber}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "MOCK_RESEARCH_OK", annotations: [] },
      ],
    },
  ];
}
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${fakeKey}`);
    assert.equal(
      req.url,
      activeProtocol === "responses" ? "/v1/responses" : "/v1/chat/completions",
    );
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requestNumber++;
    const history = activeProtocol === "responses" ? body.input : body.messages;
    assert(Array.isArray(history));
    branchHistoryCheck?.(history);
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    if (scenario === "effort")
      assert.equal(
        activeProtocol === "responses"
          ? body.reasoning?.effort
          : body.reasoning_effort,
        expectedChatEffort,
      );
    if (scenario === "webSearch")
      assert.equal(
        (body.tools ?? []).some((tool: Json) => tool.type === "web_search"),
        expectedWebSearch,
      );
    if (scenario === "hold") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": waiting for cancellation\n\n");
      heldRequests++;
      res.once("close", () => closedRequests++);
      return;
    }
    if (
      scenario === "agentHold" &&
      !textOf(history).includes("AGENT_ROOT_HOLD")
    ) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": waiting for child cancellation\n\n");
      heldRequests++;
      res.once("close", () => closedRequests++);
      return;
    }
    let call: Json | undefined;
    if (["tool", "approval"].includes(scenario) && !toolRequested) {
      const tools =
        activeProtocol === "responses"
          ? flattenTools(body.tools)
          : body.tools.map((tool: Json) => tool.function);
      const tool = tools.find((item: Json) =>
        ["exec_command", "shell_command"].some(
          (name) => item.name === name || item.name?.endsWith(`__${name}`),
        ),
      );
      assert(
        tool,
        `Shell tool not advertised in ${activeProtocol}: ${tools.map((item: Json) => item.name).join(", ")}`,
      );
      const isShellCommand =
        tool.name === "shell_command" || tool.name.endsWith("__shell_command");
      const inputName = isShellCommand ? "command" : "cmd";
      assert(
        tool.parameters?.properties?.[inputName],
        `${tool.name} has no ${inputName} argument`,
      );
      assert(
        tool.parameters.required?.includes(inputName),
        `${tool.name} does not require ${inputName}`,
      );
      const command = `echo ${marker}`;
      // Windows sandbox startup can exceed one second under CI load; still require the exact native tool output.
      const argument = isShellCommand
        ? { command, timeout_ms: 10000 }
        : {
            cmd: command,
            login: false,
            max_output_tokens: 100,
            yield_time_ms: 10000,
          };
      call = {
        id: `fc_${requestNumber}`,
        type: "function_call",
        call_id: `call_smoke_${activeProtocol}_${scenario}`,
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        arguments: JSON.stringify({
          ...argument,
          ...(scenario === "approval"
            ? {
                sandbox_permissions: "require_escalated",
                justification:
                  "Smoke-test approval routing; the test will decline this harmless command.",
              }
            : {}),
        }),
        status: "completed",
      };
      toolRequested = true;
    } else if (["tool", "approval"].includes(scenario)) {
      const result = history.find((item: Json) =>
        activeProtocol === "responses"
          ? item.type === "function_call_output" &&
            item.call_id === `call_smoke_${activeProtocol}_${scenario}`
          : item.role === "tool" &&
            item.tool_call_id === `call_smoke_${activeProtocol}_${scenario}`,
      );
      assert(result, "Actual Codex tool output must be sent back to the model");
      assert.match(
        activeProtocol === "responses" ? String(result.output) : result.content,
        scenario === "approval" ? /reject|denied|declin/i : new RegExp(marker),
      );
      toolOutputSeen = true;
    }
    if (
      ["fileCreate", "fileUpdate", "manualFile", "autoFile"].includes(scenario)
    ) {
      const callId = `call_file_${activeProtocol}_${scenario}`;
      if (!toolRequested) {
        const tools =
          activeProtocol === "responses"
            ? flattenTools(body.tools)
            : body.tools.map((t: Json) => t.function);
        const tool = tools.find(
          (t: Json) =>
            t.name === "apply_patch" || t.name?.endsWith("__apply_patch"),
        );
        assert(tool, "apply_patch must be advertised");
        const patch =
          scenario === "autoFile"
            ? "*** Begin Patch\n*** Add File: auto-card.txt\n+Automatic edit fixture only.\n*** End Patch"
            : scenario === "manualFile"
              ? "*** Begin Patch\n*** Add File: manual-card.txt\n+Manual fixture only.\n*** End Patch"
              : scenario === "fileCreate"
                ? "*** Begin Patch\n*** Add File: generated-card.html\n+<html><title>Generated card</title><button>Add 1</button></html>\n*** End Patch"
                : "*** Begin Patch\n*** Update File: generated-card.html\n@@\n-<html><title>Generated card</title><button>Add 1</button></html>\n+<html><title>Generated card</title><button>Add 2</button></html>\n*** End Patch";
        call = {
          id: `fc_${requestNumber}`,
          type: "custom_tool_call",
          call_id: callId,
          name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          input: patch,
          arguments: JSON.stringify({ input: patch }),
          status: "completed",
        };
        toolRequested = true;
      } else {
        const result = history.find((i: Json) =>
          activeProtocol === "responses"
            ? i.call_id === callId && /_call_output$/.test(i.type)
            : i.role === "tool" && i.tool_call_id === callId,
        );
        assert(result, "Actual patch output must return to the model");
        assert.match(
          String(
            activeProtocol === "responses" ? result.output : result.content,
          ),
          /Success/,
        );
        toolOutputSeen = true;
      }
    }
    if (scenario === "background") {
      const output = history.find((item: Json) =>
        activeProtocol === "responses"
          ? item.type === "function_call_output" &&
            item.call_id === "call_background_fixture"
          : item.role === "tool" &&
            item.tool_call_id === "call_background_fixture",
      );
      if (output) {
        toolOutputSeen = true;
      } else if (!toolRequested) {
        const tools =
          activeProtocol === "responses"
            ? flattenTools(body.tools)
            : body.tools.map((item: Json) => item.function);
        const tool = tools.find((item: Json) =>
          ["exec_command", "shell_command"].some(
            (name) => item.name === name || item.name?.endsWith(`__${name}`),
          ),
        );
        assert(tool, "Background test needs a shell tool");
        const command =
          process.platform === "win32"
            ? "powershell -NoProfile -Command Start-Sleep -Seconds 6"
            : 'node -e "setTimeout(() => {}, 15000)"';
        const argument =
          tool.name === "shell_command" || tool.name.endsWith("__shell_command")
            ? { command, timeout_ms: 20000 }
            : {
                cmd: command,
                login: false,
                yield_time_ms: 1000,
                max_output_tokens: 100,
              };
        call = {
          id: `fc_${requestNumber}`,
          type: "function_call",
          call_id: "call_background_fixture",
          name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          arguments: JSON.stringify(argument),
          status: "completed",
        };
        toolRequested = true;
      }
    }
    if (scenario === "agent" || scenario === "agentHold") {
      const holding = scenario === "agentHold",
        callId = holding ? "call_agent_hold" : "call_agent_fixture",
        rootMarker = holding ? "AGENT_ROOT_HOLD" : "AGENT_ROOT_FIXTURE";
      const output = history.find((item: Json) =>
        activeProtocol === "responses"
          ? item.type === "function_call_output" && item.call_id === callId
          : item.role === "tool" && item.tool_call_id === callId,
      );
      if (output) {
        toolOutputSeen = true;
        assert.match(
          JSON.stringify(output),
          holding ? /synthetic_hold/ : /synthetic_review/,
        );
      } else if (textOf(history).includes(rootMarker) && !toolRequested) {
        const tools =
          activeProtocol === "responses"
            ? flattenTools(body.tools)
            : body.tools.map((item: Json) => item.function);
        const tool = tools.find(
          (item: Json) =>
            item.name === "spawn_agent" || item.name?.endsWith("__spawn_agent"),
        );
        assert(
          tool,
          `spawn_agent unavailable: ${tools.map((item: Json) => item.name).join(", ")}`,
        );
        call = {
          id: `fc_${requestNumber}`,
          type: "function_call",
          call_id: callId,
          name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          arguments: JSON.stringify({
            task_name: holding ? "synthetic_hold" : "synthetic_review",
            message: holding
              ? "CHILD_AGENT_HOLD: wait for cancellation."
              : "CHILD_AGENT_FIXTURE: return a short synthetic finding.",
            fork_turns: "none",
          }),
          status: "completed",
        };
        toolRequested = true;
      } else childAgentRequestSeen = true;
    }
    if (["followup", "recover", "restore"].includes(scenario)) {
      assert.match(textOf(history), /SMOKE_HELLO/);
      const previousAssistant = history.filter(
        (item: Json) => item.role === "assistant",
      );
      assert.match(textOf(previousAssistant), /MOCK_HELLO_OK/);
      historySeen = true;
    }
    const answer =
      scenario === "hello"
        ? "MOCK_HELLO_OK"
        : scenario === "tool"
          ? `TOOL_VERIFIED:${marker}`
          : `MOCK_${scenario.toUpperCase()}_OK`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (activeProtocol === "responses") {
      const output =
        scenario === "research"
          ? researchStep(body, history)
          : call
            ? [call]
            : [
                {
                  id: `msg_${requestNumber}`,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: answer, annotations: [] },
                  ],
                },
              ];
      for (const event of responseEvents(
        output,
        `resp_${requestNumber}`,
        body.model,
      ))
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else {
      const chunk = (delta: Json, finish_reason: string | null) => ({
        id: `chat_${requestNumber}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      const events = call
        ? [
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: call.call_id,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: call.arguments.slice(0, 15),
                    },
                  },
                ],
              },
              null,
            ),
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: call.arguments.slice(15) },
                  },
                ],
              },
              "tool_calls",
            ),
          ]
        : [
            chunk({ role: "assistant", content: answer.slice(0, 5) }, null),
            chunk({ content: answer.slice(5) }, "stop"),
          ];
      for (const event of events)
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.write(
        `data: ${JSON.stringify({ id: `chat_${requestNumber}`, choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } })}\n\ndata: [DONE]\n\n`,
      );
    }
    res.end();
  } catch (error) {
    requestError = error as Error;
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: { message: requestError.message } }));
  }
});

let engine: Engine | undefined;
let store: Store | undefined;
let unexpectedApprovals: AppEvent[] = [];
let acceptedFileApprovals = 0;
function makeEngine(currentStore: Store) {
  return new Engine(
    currentStore,
    resolveRuntime(),
    () => fakeKey,
    (event) => {
      if (event.type === "approval") {
        if (
          ["fileCreate", "fileUpdate", "manualFile", "autoFile"].includes(
            scenario,
          ) &&
          event.approval.method === "item/fileChange/requestApproval"
        ) {
          acceptedFileApprovals++;
          engine?.approve(event.approval.id, { decision: "accept" });
        } else {
          unexpectedApprovals.push(event);
          engine?.approve(event.approval.id, { decision: "decline" });
        }
      }
    },
    providerServiceScript,
  );
}
function lastTurn(c: Conversation) {
  return c.turns.at(-1)!;
}
async function complete(id: string) {
  await until(
    () =>
      Boolean(requestError) ||
      lastTurn(store!.conversation(id)).status !== "inProgress",
    `${activeProtocol}/${scenario} turn`,
  );
  if (requestError) throw requestError;
  const turn = lastTurn(store!.conversation(id));
  assert.equal(turn.status, "completed", turn.error);
  assert.equal(turnActivity(turn), "idle");
  assert.equal(
    turn.items.some(itemIsRunning),
    false,
    "Terminal turn must not retain active progress",
  );
  return turn;
}
async function send(text: string, conversationId?: string) {
  return engine!.send({
    text,
    conversationId,
    mode: "code",
    attachments: [],
    providerId: "mock",
    model,
  });
}

try {
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: providerServiceScript,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  for (const protocol of ["responses", "chat"] as const) {
    activeProtocol = protocol;
    scenario = "hello";
    requestError = undefined;
    toolRequested = false;
    toolOutputSeen = false;
    historySeen = false;
    unexpectedApprovals = [];
    acceptedFileApprovals = 0;
    store = new Store(path.join(root, protocol));
    store.settings.providers = [
      {
        id: "mock",
        name: "Local smoke mock",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        protocol,
        model,
        models: [model],
      },
    ];
    store.settings.activeProviderId = "mock";
    store.settings.sandbox = "workspace-write";
    store.settings.codeSandbox = "read-only";
    engine = makeEngine(store);
    if (process.platform === "win32") {
      await assert.rejects(
        send("Must not start before sandbox setup."),
        /Settings → Claude Code/,
      );
      assert.equal((await engine.setupWindowsSandbox()).ready, true);
      console.log(
        `PASS ${protocol}: Windows sends fail closed until explicit unelevated sandbox setup`,
      );
    }
    const conversation = await send("SMOKE_HELLO: return a short greeting.");
    let turn = await complete(conversation.id);
    assert.match(
      turn.items.find((item) => item.type === "agentMessage")?.text ?? "",
      /MOCK_HELLO_OK/,
    );
    assert.equal(engine.state.state, "ready");
    console.log(
      `PASS ${protocol}: real Codex ${engine.state.version}, streamed text`,
    );
    const loaded = await engine.rpc!.call("thread/loaded/list", {});
    assert(
      JSON.stringify(loaded).includes(conversation.threadId!),
      JSON.stringify(loaded),
    );
    const background = await engine.rpc!.call(
      "thread/backgroundTerminals/list",
      { threadId: conversation.threadId, limit: 50 },
    );
    assert(Array.isArray(background.data));

    scenario = "tool";
    await send(
      "Please run a read-only terminal command that prints CLAUDEX_TOOL_OK, then report its exact output.",
      conversation.id,
    );
    turn = await complete(conversation.id);
    assert(toolRequested && toolOutputSeen);
    assert.equal(
      unexpectedApprovals.length,
      0,
      "Read-only printf should not need approval",
    );
    const command = turn.items.find((item) => item.type === "commandExecution");
    assert(command, "UI must receive the real command execution item");
    assert.equal(
      command.status,
      "completed",
      JSON.stringify({
        status: command.status,
        lifecycleStatus: command.lifecycleStatus,
        exitCode: command.exitCode,
        error: command.error,
        aggregatedOutput: command.aggregatedOutput,
      }),
    );
    assert.equal(command.lifecycleStatus, "completed");
    assert.match(command.aggregatedOutput ?? "", new RegExp(marker));
    assert.match(
      turn.items.find((item) => item.type === "agentMessage")?.text ?? "",
      /TOOL_VERIFIED/,
    );
    console.log(
      `PASS ${protocol}: function call → sandboxed terminal → tool output → assistant`,
    );

    scenario = "approval";
    toolRequested = false;
    toolOutputSeen = false;
    await send(
      "Test an explicit command approval request; I will decline it.",
      conversation.id,
    );
    await complete(conversation.id);
    assert(toolRequested && toolOutputSeen);
    assert.equal(unexpectedApprovals.length, 1);
    assert.equal(unexpectedApprovals[0].type, "approval");
    assert.equal(engine.approvals.length, 0);
    console.log(
      `PASS ${protocol}: user approval request and decline reach the actual Codex tool`,
    );

    scenario = "followup";
    historySeen = false;
    await send(
      "Remember our greeting and summarize the previous command.",
      conversation.id,
    );
    await complete(conversation.id);
    assert(historySeen);
    console.log(`PASS ${protocol}: multi-turn conversation and tool history`);

    scenario = "hold";
    const heldBefore = heldRequests;
    const closedBefore = closedRequests;
    await send("Wait until I interrupt this response.", conversation.id);
    await until(() => heldRequests > heldBefore, "upstream stream opened");
    await engine.interrupt(conversation.id);
    await until(
      () =>
        lastTurn(store!.conversation(conversation.id)).status !== "inProgress",
      "turn interrupted",
    );
    assert.equal(
      lastTurn(store.conversation(conversation.id)).status,
      "interrupted",
    );
    await until(() => closedRequests > closedBefore, "upstream disconnected");
    console.log(
      `PASS ${protocol}: interrupt cancels Codex turn and upstream HTTP stream`,
    );

    scenario = "recover";
    await send("Continue after the interrupted response.", conversation.id);
    await complete(conversation.id);
    assert.equal(
      store.conversation(conversation.id).threadId,
      conversation.threadId,
    );
    console.log(`PASS ${protocol}: next turn works after interrupt`);

    scenario = "hold";
    const beforeCrash = heldRequests;
    await send(
      "Wait while the isolated test restarts the engine.",
      conversation.id,
    );
    await until(() => heldRequests > beforeCrash, "crash-test stream opened");
    const child = (engine.rpc as unknown as { process?: ChildProcess }).process;
    assert(child?.pid);
    child.kill("SIGKILL");
    await until(
      () => engine?.state.state === "error",
      "process failure surfaced",
    );
    assert.equal(
      lastTurn(store.conversation(conversation.id)).status,
      "failed",
    );
    scenario = "recover";
    await send("Continue after the engine process failure.", conversation.id);
    await complete(conversation.id);
    assert.equal(
      store.conversation(conversation.id).threadId,
      conversation.threadId,
    );
    console.log(
      `PASS ${protocol}: unexpected process exit surfaces error; restart resumes same thread`,
    );

    await engine.stop();
    store.flush();
    store = new Store(path.join(root, protocol));
    engine = makeEngine(store);
    scenario = "restore";
    historySeen = false;
    await send(
      "Continue our saved conversation after relaunch.",
      conversation.id,
    );
    await complete(conversation.id);
    assert(historySeen);
    assert.equal(
      store.conversation(conversation.id).threadId,
      conversation.threadId,
    );
    assert.equal(store.conversation(conversation.id).turns.length, 9);
    console.log(
      `PASS ${protocol}: persisted application state and Codex thread/resume`,
    );

    const original = structuredClone(store.conversation(conversation.id));
    const target = original.turns[1];
    scenario = "branch";
    branchHistoryCheck = (history) => {
      const text = textOf(history);
      assert.match(text, /SMOKE_HELLO/);
      assert.match(text, /read-only terminal command/);
      assert.doesNotMatch(
        text,
        /TOOL_VERIFIED|Remember our greeting|Continue our saved conversation/,
      );
    };
    await engine.retryResponse(conversation.id, target.id, "mock", model);
    const alternative = await complete(conversation.id);
    const alternativeThread = store.conversation(conversation.id).threadId;
    assert.notEqual(alternativeThread, original.threadId);
    assert.equal(store.conversation(conversation.id).turns.length, 2);
    assert.deepEqual(
      store.conversation(conversation.id).savedBranches![0].turns,
      original.turns.map((t) =>
        t.id === target.id
          ? {
              ...t,
              responseGroupId: t.id,
              promptGroupId: t.id,
              promptVersionId: t.id,
            }
          : t,
      ),
    );
    const beforeLate = structuredClone(store.conversation(conversation.id));
    (engine as any).notification({
      method: "item/agentMessage/delta",
      params: {
        threadId: original.threadId,
        turnId: target.id,
        itemId: "late",
        delta: "WRONG_BRANCH",
      },
    });
    assert.deepEqual(store.conversation(conversation.id), beforeLate);
    scenario = "branchContinue";
    branchHistoryCheck = (history) => {
      assert.match(textOf(history), /MOCK_BRANCH_OK/);
      assert.doesNotMatch(
        textOf(history),
        /TOOL_VERIFIED|Continue our saved conversation/,
      );
    };
    await send("BRANCH_ONLY_CONTINUATION", conversation.id);
    await complete(conversation.id);
    engine.selectReplyVersion(conversation.id, alternative.id, target.id);
    assert.equal(
      store.conversation(conversation.id).threadId,
      original.threadId,
    );
    assert.deepEqual(
      store.conversation(conversation.id).turns.map((t) => t.id),
      original.turns.map((t) => t.id),
    );
    scenario = "originalContinue";
    branchHistoryCheck = (history) => {
      assert.match(textOf(history), /TOOL_VERIFIED/);
      assert.doesNotMatch(
        textOf(history),
        /MOCK_BRANCH_OK|BRANCH_ONLY_CONTINUATION/,
      );
    };
    await send("ORIGINAL_ONLY_CONTINUATION", conversation.id);
    await complete(conversation.id);
    engine.selectReplyVersion(conversation.id, target.id, alternative.id);
    assert.equal(
      store.conversation(conversation.id).threadId,
      alternativeThread,
    );
    assert.equal(
      store.conversation(conversation.id).turns.at(-1)?.prompt,
      "BRANCH_ONLY_CONTINUATION",
    );
    await engine.stop();
    store.flush();
    store = new Store(path.join(root, protocol));
    engine = makeEngine(store);
    scenario = "branchContinue";
    branchHistoryCheck = (history) => {
      assert.match(textOf(history), /BRANCH_ONLY_CONTINUATION|MOCK_BRANCH_OK/);
      assert.doesNotMatch(
        textOf(history),
        /ORIGINAL_ONLY_CONTINUATION|TOOL_VERIFIED/,
      );
    };
    await send("BRANCH_RESTART_FOLLOWUP", conversation.id);
    await complete(conversation.id);
    assert.equal(
      store.conversation(conversation.id).threadId,
      alternativeThread,
    );
    console.log(
      `PASS ${protocol}: native fork boundary, isolated branch history, descendants, late-event isolation, switch and restart`,
    );

    scenario = "branch";
    branchHistoryCheck = (history) => {
      assert.match(textOf(history), /SMOKE_HELLO|EDITED_PROMPT_ONLY/);
      assert.match(textOf(history), /EDITED_PROMPT_ONLY/);
      assert.doesNotMatch(
        textOf(history),
        /read-only terminal command|BRANCH_ONLY_CONTINUATION|BRANCH_RESTART_FOLLOWUP/,
      );
    };
    await engine.editPrompt(
      conversation.id,
      alternative.id,
      "EDITED_PROMPT_ONLY",
      "mock",
      model,
    );
    const edited = await complete(conversation.id);
    assert.equal(store.conversation(conversation.id).turns.length, 2);
    assert.notEqual(edited.responseGroupId, alternative.responseGroupId);
    engine.selectPromptVersion(conversation.id, edited.id, alternative.id);
    assert.equal(
      store.conversation(conversation.id).threadId,
      alternativeThread,
    );
    assert.equal(
      store.conversation(conversation.id).turns.at(-1)?.prompt,
      "BRANCH_RESTART_FOLLOWUP",
    );
    console.log(
      `PASS ${protocol}: edited prompt excludes original prompt and descendants; prompt version restores native continuation`,
    );

    const first = store.conversation(conversation.id).turns[0];
    scenario = "branch";
    branchHistoryCheck = (history) => {
      assert.match(textOf(history), /SMOKE_HELLO/);
      assert.doesNotMatch(
        textOf(history),
        /MOCK_HELLO_OK|BRANCH_ONLY_CONTINUATION|BRANCH_RESTART_FOLLOWUP/,
      );
    };
    await engine.retryResponse(conversation.id, first.id, "mock", model);
    await complete(conversation.id);
    assert.equal(store.conversation(conversation.id).turns.length, 1);
    assert.notEqual(
      store.conversation(conversation.id).threadId,
      alternativeThread,
    );
    branchHistoryCheck = undefined;
    console.log(
      `PASS ${protocol}: first-response retry starts with no previous assistant context`,
    );

    const priorApprovals = unexpectedApprovals.length;
    scenario = "manualFile";
    toolRequested = false;
    toolOutputSeen = false;
    const manualConversation = await send(
      "Create manual-card.txt using apply_patch under read-only sandbox.",
    );
    await complete(manualConversation.id);
    assert(toolRequested && toolOutputSeen);
    assert(
      acceptedFileApprovals > 0,
      "Read-only Code patch must ask for approval before writing.",
    );
    assert.equal(unexpectedApprovals.length, priorApprovals);
    console.log(
      `PASS ${protocol}: read-only Code file changes request approval and apply only after acceptance`,
    );
    store.settings.autoAcceptEdits = true;
    scenario = "autoFile";
    toolRequested = false;
    toolOutputSeen = false;
    const acceptedBeforeAuto = acceptedFileApprovals;
    const automatic = await send(
      "Create auto-card.txt using apply_patch under read-only sandbox.",
    );
    await complete(automatic.id);
    assert(toolRequested && toolOutputSeen);
    if (process.platform === "win32")
      assert(
        acceptedFileApprovals > acceptedBeforeAuto,
        "Windows must still ask for file approval",
      );
    else
      assert.equal(
        acceptedFileApprovals,
        acceptedBeforeAuto,
        "Accept edits must resolve Code file approval without a UI prompt",
      );
    assert.equal(unexpectedApprovals.length, priorApprovals);
    console.log(
      `PASS ${protocol}: Accept edits handles only Code file approval; Windows remains approval-gated`,
    );
    scenario = "approval";
    toolRequested = false;
    toolOutputSeen = false;
    const beforeCommandApproval = unexpectedApprovals.length;
    const separateCommand = await send(
      "Request approval for an isolated command while Accept edits is active.",
    );
    await complete(separateCommand.id);
    assert(toolRequested && toolOutputSeen);
    assert.equal(
      unexpectedApprovals.length,
      beforeCommandApproval + 1,
      "Accept edits must not auto-approve commands",
    );
    console.log(
      `PASS ${protocol}: Accept edits still surfaces separate command approvals`,
    );
    const approvalsAfterCommand = unexpectedApprovals.length;
    store.settings.autoAcceptEdits = false;
    store.settings.codePlanMode = true;
    store.settings.codeSandbox = "read-only";
    scenario = "plan";
    await engine.ensure(store.settings.providers[0]);
    let planMode = "";
    const planRpc = engine.rpc!,
      planCall = planRpc.call;
    planRpc.call = (method, params, timeout) => {
      if (method === "turn/start") planMode = params.collaborationMode?.mode;
      return planCall.call(planRpc, method, params, timeout);
    };
    const planned = await send("Make a plan for a synthetic local task.");
    await complete(planned.id);
    planRpc.call = planCall;
    assert.equal(planMode, "plan");
    store.settings.codePlanMode = false;
    store.settings.codeSandbox = "workspace-write";
    await engine.stop();
    engine = makeEngine(store);
    await engine.ensure(store.settings.providers[0]);
    let defaultMode = "";
    const defaultRpc = engine.rpc!,
      defaultCall = defaultRpc.call;
    defaultRpc.call = (method, params, timeout) => {
      if (method === "turn/start") defaultMode = params.collaborationMode?.mode;
      return defaultCall.call(defaultRpc, method, params, timeout);
    };
    await send("Continue after the plan in the default mode.", planned.id);
    await complete(planned.id);
    defaultRpc.call = defaultCall;
    assert.equal(defaultMode, "default");
    console.log(
      `PASS ${protocol}: Code Plan and default collaboration modes cross real turn/start and resume`,
    );
    store.settings.codeSandbox = "workspace-write";
    scenario = "fileCreate";
    toolRequested = false;
    toolOutputSeen = false;
    const fileConversation = await send(
      "Create generated-card.html using apply_patch.",
    );
    const creation = await complete(fileConversation.id);
    assert(toolRequested && toolOutputSeen);
    const fileItem = creation.items.find((i) => i.type === "fileChange");
    assert(fileItem, "Native fileChange must reach the UI");
    const initialFile = fileItem.generatedFiles?.[0];
    assert.equal(initialFile?.state, "ready");
    assert.match(initialFile!.content!, /Add 1/);
    scenario = "fileUpdate";
    toolRequested = false;
    toolOutputSeen = false;
    await send(
      "Change the button to Add 2 using apply_patch.",
      fileConversation.id,
    );
    await complete(fileConversation.id);
    assert(toolRequested && toolOutputSeen);
    assert.equal(
      unexpectedApprovals.length,
      approvalsAfterCommand,
      "Synthetic file changes must not cause unrelated approvals",
    );
    if (process.platform === "win32")
      assert(
        acceptedFileApprovals > 0,
        "Windows patch approval must reach the client and be accepted for this isolated fixture",
      );
    const currentFile = latestGeneratedFiles(
      store.conversation(fileConversation.id).turns,
    ).get(initialFile!.path)!;
    assert.match(currentFile.content!, /Add 2/);
    assert.notEqual(currentFile.digest, initialFile!.digest);
    assert.match(initialFile!.content!, /Add 1/);
    await engine.stop();
    store.flush();
    store = new Store(path.join(root, protocol));
    engine = makeEngine(store);
    assert.match(
      latestGeneratedFiles(store.conversation(fileConversation.id).turns).get(
        initialFile!.path,
      )!.content!,
      /Add 2/,
    );
    console.log(
      `PASS ${protocol}: real apply_patch create/update, immutable snapshots, latest file resolution and persistence`,
    );
    scenario = "effort";
    let chatConversationId: string | undefined;
    for (const effort of ["xhigh", "max"] as const) {
      expectedChatEffort = effort;
      store.settings.effort = effort;
      const chatConversation = await engine.send({
        text: `CHAT_${effort.toUpperCase()}_EFFORT`,
        conversationId: chatConversationId,
        mode: "chat",
        attachments: [],
        providerId: "mock",
        model,
      });
      chatConversationId = chatConversation.id;
      await complete(chatConversation.id);
    }
    console.log(
      `PASS ${protocol}: real Chat turns forward Extra and Max effort through Codex to the model service`,
    );
    if (protocol === "responses") {
      scenario = "webSearch";
      expectedWebSearch = false;
      const searchConversation = await engine.send({
        text: "WEB_SEARCH_OFF",
        mode: "chat",
        attachments: [],
        providerId: "mock",
        model,
      });
      await complete(searchConversation.id);
      store.conversation(searchConversation.id).webSearch = true;
      store.flush();
      await engine.stop();
      engine = makeEngine(store);
      expectedWebSearch = true;
      await engine.send({
        text: "WEB_SEARCH_ON",
        conversationId: searchConversation.id,
        mode: "chat",
        attachments: [],
        providerId: "mock",
        model,
      });
      await complete(searchConversation.id);
      console.log(
        "PASS responses: per-conversation Web search enters the upstream tool list after an idle engine refresh",
      );
      scenario = "research";
      const reports = new ResearchReports(store.root);
      const removeResearch = engine.extensions.add(
        createResearchExtension({
          policy: () => engine!.policy(),
          catalogItem: () => undefined,
          reports,
          push: () => {},
        }),
      );
      const researchConversation = await engine.send({
        text: "Research sidebar density.",
        mode: "chat",
        research: true,
        attachments: [],
        providerId: "mock",
        model,
      });
      assert.equal(researchConversation.research, true);
      assert.equal(researchConversation.webSearch, true);
      const researchTurn = await complete(researchConversation.id);
      assert.deepEqual(researchSeen.steps, [
        "plan",
        "search+report",
        "summary",
      ]);
      assert(researchSeen.tools, "Research tools or web search not offered.");
      assert(researchSeen.instructions, "Research instructions not sent.");
      const research = researchTurn.research;
      assert.equal(research?.state, "done");
      assert.equal(research?.reportSource, "tool");
      assert.equal(research?.title, "Sidebar Density Findings");
      assert.deepEqual(research?.questions, [
        "Row heights?",
        "Tooltip accessibility?",
      ]);
      assert.equal(research?.sourceCount, 2);
      assert.equal(research?.searchCount, 1);
      assert.equal(reports.read(research!.report!.path), researchReport);
      const searchItem = researchTurn.items.find(
        (item) => item.type === "webSearch",
      );
      assert.equal(searchItem?.sources?.length, 2);
      assert.match(
        researchTurn.items.filter((item) => item.type === "agentMessage").at(-1)
          ?.text ?? "",
        /MOCK_RESEARCH_OK/,
      );
      removeResearch();
      console.log(
        "PASS responses: Research runs research_plan and research_report through Codex, counts gateway sources and keeps the report",
      );
    } else {
      await assert.rejects(
        engine.send({
          text: "WEB_SEARCH_REJECT",
          mode: "chat",
          webSearch: true,
          attachments: [],
          providerId: "mock",
          model,
        }),
        /Responses-compatible/,
      );
      console.log(
        "PASS chat: unsupported built-in Web search is rejected before the model service",
      );
    }
    if (protocol === "responses") {
      scenario = "background";
      toolRequested = false;
      toolOutputSeen = false;
      const backgroundConversation = await send(
        "Run a synthetic long-running shell task in the background.",
      );
      if (process.platform === "win32")
        await until(
          () =>
            runningCommandTasks(
              [store!.conversation(backgroundConversation.id)],
              [],
            ).length > 0,
          "Windows running command activity",
          10_000,
        );
      await complete(backgroundConversation.id);
      assert(toolRequested && toolOutputSeen);
      const running = await engine.rpc!.call(
        "thread/backgroundTerminals/list",
        {
          threadId: store.conversation(backgroundConversation.id).threadId,
          limit: 50,
        },
      );
      assert(Array.isArray(running.data));
      if (process.platform === "win32")
        console.log(
          "PASS responses: Windows shell turn completes; background terminal support remains unverified",
        );
      else {
        assert(running.data.length > 0, JSON.stringify(running));
        const processId = running.data[0].processId;
        assert.equal(typeof processId, "string");
        const stopped = await engine.rpc!.call(
          "thread/backgroundTerminals/terminate",
          {
            threadId: store.conversation(backgroundConversation.id).threadId,
            processId,
          },
        );
        assert.equal(stopped.terminated, true);
        console.log(
          "PASS responses: native background terminal appears and terminates",
        );
      }
    }
    if (protocol === "responses") {
      scenario = "agent";
      toolRequested = false;
      toolOutputSeen = false;
      childAgentRequestSeen = false;
      const agentConversation = await send(
        "AGENT_ROOT_FIXTURE: delegate one synthetic review to a child agent.",
      );
      const agentTurn = await complete(agentConversation.id);
      assert(
        toolRequested && toolOutputSeen,
        "Root did not spawn a child Agent.",
      );
      await until(
        () => childAgentRequestSeen,
        "child Agent model request",
        10_000,
      );
      const childItem = agentTurn.items.find(
        (item) => item.type === "subAgentActivity" && item.agentThreadId,
      );
      assert(childItem, JSON.stringify(agentTurn.items));
      await refreshWorkflowAgents({ store, engine }, agentConversation.id);
      const childTranscript = await readWorkflowAgent(
        { store, engine },
        agentConversation.id,
        childItem.agentThreadId,
      );
      assert(
        childTranscript.items.some(
          (item) =>
            item.type === "agentMessage" &&
            /MOCK_AGENT_OK/.test(item.text ?? ""),
        ),
      );
      assert.match(
        childTranscript.context,
        /CHILD_AGENT_FIXTURE/,
        JSON.stringify({
          context: childTranscript.context,
          items: agentTurn.items.map((item) => ({
            type: item.type,
            id: item.id,
            hasAgentPrompt: Boolean(item.agentPrompt),
          })),
        }),
      );
      store.flush();
      const restoredAgent = new Store(path.join(root, protocol));
      assert.match(
        restoredAgent
          .conversation(agentConversation.id)
          .turns.at(-1)!
          .items.find((item) => item.id === childItem.id)?.agentPrompt ?? "",
        /CHILD_AGENT_FIXTURE/,
      );
      const view = workflowFromTurn(
        lastTurn(store.conversation(agentConversation.id)),
        store.conversation(agentConversation.id),
      );
      assert.equal(view?.agents.length, 1);
      assert.equal(view?.agents[0].id, childItem.agentThreadId);
      console.log(
        `PASS responses: native child Agent workflow and parent item (${view?.agents[0].status}, ${view?.totalTokens ?? "usage pending"} tokens)`,
      );
    }
    if (protocol === "responses") {
      scenario = "agentHold";
      toolRequested = false;
      toolOutputSeen = false;
      const beforeHeld = heldRequests,
        beforeClosed = closedRequests;
      const heldConversation = await send(
        "AGENT_ROOT_HOLD: start a child that waits until interrupted.",
      );
      const rootTurn = await complete(heldConversation.id);
      assert(
        toolRequested && toolOutputSeen,
        "Parent did not spawn a held child.",
      );
      const child = rootTurn.items.find(
        (item) => item.type === "subAgentActivity" && item.agentThreadId,
      );
      assert(child, "Native child activity missing.");
      await until(
        () => heldRequests > beforeHeld,
        "held child upstream request",
        10_000,
      );
      const stopped = await stopWorkflowAgent(
        { store, engine },
        heldConversation.id,
        child.agentThreadId,
      );
      assert.equal(
        stopped.turns.at(-1)?.items.find((item) => item.id === child.id)
          ?.agentsStates?.[child.agentThreadId]?.status,
        "interrupted",
      );
      await until(
        () => closedRequests > beforeClosed,
        "held child upstream disconnected",
        10_000,
      );
      console.log(
        "PASS responses: stop child Agent interrupts native turn and cancels upstream stream",
      );
    }
    await engine.stop();
    store.flush();
  }
  console.log(
    `Engine smoke passed: ${requestNumber} mock API requests, both protocols, isolated local state.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await engine?.stop();
  store?.flush();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await delay(300);
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 200,
  });
}
