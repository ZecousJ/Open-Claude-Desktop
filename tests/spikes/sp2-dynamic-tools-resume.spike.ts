/**
 * SP-2 (R3, R45): do thread/start `dynamicTools` stay advertised and routable
 * after thread/resume (same process and after an app-server restart) and
 * thread/fork? Does a resume's developerInstructions replace the old one?
 *
 * Run: npx tsx --test tests/spikes/sp2-dynamic-tools-resume.spike.ts
 * Real bundled Codex, loopback fixtures only; results/sp2-dynamic-tools-resume.json.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  CodexHost,
  MODEL,
  MockResponses,
  outputs,
  reachableTools,
  stopAllHosts,
  tempRoot,
  toolNames,
  toolPlan,
  writeFinding,
  type Json,
} from "./harness";

const findings: Json = { codexVersion: "0.144.1" };
const root = tempRoot("sp2");
let mock: MockResponses;
before(async () => {
  mock = await new MockResponses().start();
});
after(async () => {
  await stopAllHosts();
  await mock.close();
  writeFinding("sp2-dynamic-tools-resume", findings);
  fs.rmSync(root, { recursive: true, force: true });
});

const dynamicTools = [
  {
    type: "function",
    name: "memory_probe",
    description: "Search the user's saved memory (spike fixture).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "namespace",
    name: "claudex_research",
    description: "Research helpers (spike fixture).",
    tools: [
      {
        type: "function",
        name: "research_probe",
        description: "Record a research plan (spike fixture).",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  },
];

/** Answers item/tool/call so the output proves the call reached the client. */
function answerDynamic(codex: CodexHost, calls: Json[]) {
  codex.onRequest = (r) => {
    if (r.method !== "item/tool/call") return undefined;
    calls.push(r.params);
    return {
      contentItems: [{ type: "inputText", text: `DYN_OK:${r.params.tool}` }],
      success: true,
    };
  };
}

function instructionVersions(body: Json): string[] {
  return [...JSON.stringify(body.input).matchAll(/INSTR_V\d/g)].map(
    (m) => m[0],
  );
}

type Stage = {
  stage: string;
  toolsAdvertised: string[];
  /** Advertised upfront in the first request (not only via tool_search). */
  upfront?: string[];
  memoryCallRouted: boolean;
  namespaceCallRouted: boolean;
  outputs: string[];
  developerInstructionVersions: string[];
  error?: string;
};

async function runTurn(
  codex: CodexHost,
  calls: Json[],
  threadId: string,
  stage: string,
): Promise<Stage> {
  const before = calls.length;
  const seen = mock.forThread(threadId).length;
  try {
    await codex.turn(threadId, `turn ${stage}`);
  } catch (error) {
    return {
      stage,
      toolsAdvertised: [],
      memoryCallRouted: false,
      namespaceCallRouted: false,
      outputs: [],
      developerInstructionVersions: [],
      error: String(error),
    };
  }
  const requests = mock.forThread(threadId).slice(seen);
  const mine = calls.slice(before);
  return {
    stage,
    toolsAdvertised: [...new Set(requests.flatMap(reachableTools))].filter(
      (n) => /probe/.test(n),
    ),
    upfront: toolNames(requests[0]).filter((n) => /probe/.test(n)),
    memoryCallRouted: mine.some((c) => c.tool === "memory_probe"),
    namespaceCallRouted: mine.some(
      (c) => c.tool === "research_probe" && c.namespace === "claudex_research",
    ),
    outputs: outputs(requests.at(-1)!).map((o) =>
      typeof o.output === "string" ? o.output : JSON.stringify(o.output),
    ),
    developerInstructionVersions: instructionVersions(requests.at(-1)!),
  };
}

for (const model of [MODEL, "grok-4"]) {
  test(`dynamicTools across resume, restart and fork (${model})`, async () => {
    mock.script = toolPlan([
      { suffix: "memory_probe", args: { query: "q" } },
      { suffix: "research_probe" },
    ]);
    const home = path.join(root, `home-${model}`);
    const calls: Json[] = [];
    let codex = await new CodexHost(home, mock).start();
    answerDynamic(codex, calls);
    const id = await codex.thread(model, path.join(root, "ws"), {
      dynamicTools,
      developerInstructions: "INSTR_V1",
    });
    const stages: Stage[] = [];
    stages.push(await runTurn(codex, calls, id, "start"));

    // Same process: unsubscribe + resume (Engine.ensureThread's limits path).
    await codex.rpc.call("thread/unsubscribe", { threadId: id });
    await codex.rpc.call("thread/resume", {
      threadId: id,
      developerInstructions: "INSTR_V2",
    });
    stages.push(await runTurn(codex, calls, id, "resume-same-process"));
    await codex.stop();

    // Restart, resume (what Engine does after every engine restart).
    codex = await new CodexHost(home, mock).start();
    answerDynamic(codex, calls);
    await codex.rpc.call("thread/resume", {
      threadId: id,
      developerInstructions: "INSTR_V3",
    });
    stages.push(await runTurn(codex, calls, id, "resume-after-restart"));

    // Resume does not declare dynamicTools; is an extra field rejected?
    let resumeWithDynamicTools: string;
    await codex.stop();
    codex = await new CodexHost(home, mock).start();
    answerDynamic(codex, calls);
    try {
      await codex.rpc.call("thread/resume", {
        threadId: id,
        developerInstructions: "INSTR_V4",
        dynamicTools,
      });
      resumeWithDynamicTools = "accepted";
    } catch (error) {
      resumeWithDynamicTools = `rejected: ${(error as Error).message}`;
    }
    stages.push(
      await runTurn(codex, calls, id, "resume-with-dynamicTools-field"),
    );

    // Fork (retry / edit branches use thread/fork).
    const fork = await codex.rpc.call("thread/fork", {
      threadId: id,
      developerInstructions: "INSTR_V5",
    });
    stages.push(
      await runTurn(codex, calls, fork.thread.id, "fork-after-restart"),
    );
    await codex.stop();

    findings[model] = { stages, resumeWithDynamicTools };
    // Observed on 0.144.1 (a failure after a Codex upgrade means: re-check).
    for (const s of stages.slice(0, 4)) {
      assert.equal(s.memoryCallRouted, true, s.stage);
      assert.equal(s.namespaceCallRouted, true, s.stage);
      assert.deepEqual(s.upfront, [
        "memory_probe",
        "claudex_research/research_probe",
      ]);
    }
    assert.equal(stages[4].memoryCallRouted, false, "fork drops dynamicTools");
    // developerInstructions are fixed at thread/start.
    for (const s of stages)
      assert.deepEqual(s.developerInstructionVersions, ["INSTR_V1"], s.stage);
  });
}

test("dynamicTools field on fork / resume with a different set", async () => {
  mock.script = toolPlan([{ suffix: "memory_probe", args: { query: "q" } }]);
  const home = path.join(root, "home-fields");
  const calls: Json[] = [];
  let codex = await new CodexHost(home, mock).start();
  answerDynamic(codex, calls);
  const id = await codex.thread("grok-4", path.join(root, "ws"), {
    dynamicTools: [dynamicTools[0]],
  });
  await runTurn(codex, calls, id, "start");
  const fork = await codex.rpc.call("thread/fork", {
    threadId: id,
    dynamicTools: [dynamicTools[0]],
  });
  const forked = await runTurn(codex, calls, fork.thread.id, "fork-with-field");
  // Does an unsubscribe + resume of the fork bring the tools back?
  await codex.rpc.call("thread/unsubscribe", { threadId: fork.thread.id });
  await codex.rpc.call("thread/resume", {
    threadId: fork.thread.id,
    dynamicTools: [dynamicTools[0]],
  });
  const forkResumed = await runTurn(
    codex,
    calls,
    fork.thread.id,
    "fork-unsubscribe-resume",
  );
  findings.forkThenResume = forkResumed;
  await codex.stop();
  codex = await new CodexHost(home, mock).start();
  answerDynamic(codex, calls);
  const renamed = { ...dynamicTools[0], name: "memory_probe_v2" };
  await codex.rpc.call("thread/resume", {
    threadId: id,
    dynamicTools: [renamed],
  });
  mock.script = toolPlan([{ suffix: "memory_probe_v2", args: { query: "q" } }]);
  const resumed = await runTurn(codex, calls, id, "resume-different-set");
  await codex.stop();
  findings.forkWithDynamicToolsField = forked;
  findings.resumeWithDifferentSet = resumed;
  // Observed on 0.144.1: a fork loses dynamicTools even when the field is
  // passed, resume cannot restore them, and resume ignores a new tool set.
  assert.equal(forked.memoryCallRouted, false, forked.error);
  assert.equal(forkResumed.memoryCallRouted, false, forkResumed.error);
  assert.equal(resumed.error, undefined);
  assert.deepEqual(resumed.toolsAdvertised, ["memory_probe"]);
  assert.equal(resumed.memoryCallRouted, false);
});

test("per-turn instruction channels", async () => {
  mock.script = toolPlan([]);
  const codex = await new CodexHost(path.join(root, "home-turn"), mock).start();
  const id = await codex.thread("grok-4", path.join(root, "ws"), {
    developerInstructions: "INSTR_V1",
  });
  await codex.turn(id, "first");
  const channels: Json = {};
  const probe = async (label: string, extra: Json, marker: string) => {
    const seen = mock.forThread(id).length;
    try {
      await codex.turn(id, label, extra);
    } catch (error) {
      channels[label] = { error: String(error) };
      return;
    }
    const last = mock.forThread(id).slice(seen).at(-1)!;
    const hit = (last.input as Json[]).filter((m) =>
      JSON.stringify(m).includes(marker),
    );
    channels[label] = {
      markerInRequest: hit.length > 0,
      roles: hit.map((m) => `${m.type}:${m.role ?? ""}`),
      snippet: hit.map((m) => JSON.stringify(m).slice(0, 300)),
      stillHasV1: JSON.stringify(last.input).includes("INSTR_V1"),
    };
  };
  await probe(
    "collaborationMode.developer_instructions",
    {
      collaborationMode: {
        mode: "default",
        settings: {
          model: "grok-4",
          reasoning_effort: null,
          developer_instructions: "INSTR_TURN_COLLAB",
        },
      },
    },
    "INSTR_TURN_COLLAB",
  );
  await probe(
    "additionalContext.application",
    {
      additionalContext: {
        claudex_memory: { value: "INSTR_TURN_CONTEXT", kind: "application" },
      },
    },
    "INSTR_TURN_CONTEXT",
  );
  await probe("next turn without extras", {}, "INSTR_TURN_");
  await codex.stop();
  findings.perTurnInstructionChannels = channels;
  // Both channels add a developer message that stays in the history.
  for (const label of [
    "collaborationMode.developer_instructions",
    "additionalContext.application",
  ]) {
    assert.equal(channels[label].markerInRequest, true, label);
    assert.deepEqual(channels[label].roles, ["message:developer"], label);
  }
  assert.equal(channels["next turn without extras"].markerInRequest, true);
});
