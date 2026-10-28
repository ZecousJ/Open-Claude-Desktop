/**
 * SP-1 (R8-0, R10): can codex 0.144.1 attach an MCP server per thread through
 * the thread/start `config` override, over streamable HTTP with
 * `bearer_token_env_var`, and relay MCP elicitation to the app-server client?
 *
 * Run: npx tsx --test tests/spikes/sp1-mcp-per-thread.spike.ts
 * Real bundled Codex, loopback fixtures only; results/sp1-mcp-per-thread.json.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  CodexHost,
  delay,
  until,
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
import { McpHttpServer, TINY_PNG } from "./mcp-http-server";

const TOKEN = "spike-mcp-token-a";
const HEADER_TOKEN = "spike-mcp-header-token-b";
const INLINE_MODEL = "grok-4"; // a model Codex has no metadata for
const findings: Json = { codexVersion: "0.144.1" };
const root = tempRoot("sp1");
let mock: MockResponses;
let mcp: McpHttpServer;

before(async () => {
  mock = await new MockResponses().start();
  mcp = await new McpHttpServer(TOKEN).start();
});
after(async () => {
  await stopAllHosts();
  await mcp.close();
  await mock.close();
  writeFinding("sp1-mcp-per-thread", findings);
  fs.rmSync(root, { recursive: true, force: true });
});

const urlServer = (extra: Json = {}) => ({
  "mcp_servers.probe.url": mcp.url,
  "mcp_servers.probe.bearer_token_env_var": "SPIKE_PROBE_TOKEN",
  "mcp_servers.probe.default_tools_approval_mode": "approve",
  "mcp_servers.probe.startup_timeout_sec": 10,
  "mcp_servers.probe.tool_timeout_sec": 90,
  ...extra,
});

const plan = toolPlan([
  { suffix: "probe_echo", args: { text: "hi" } },
  { suffix: "probe_ask" },
  { suffix: "probe_image" },
]);

async function host(label: string, extraConfig: Json = {}) {
  return new CodexHost(path.join(root, label), mock, extraConfig, {
    SPIKE_PROBE_TOKEN: TOKEN,
  }).start();
}

for (const model of [MODEL, INLINE_MODEL]) {
  test(`per-thread url + bearer_token_env_var + elicitation (${model})`, async () => {
    const codex = await host(`home-${model}`);
    const elicitations: Json[] = [];
    codex.onRequest = (r) => {
      if (r.method !== "mcpServer/elicitation/request") return undefined;
      elicitations.push(r.params);
      return {
        action: "accept",
        content: { choice: "allow_once" },
        _meta: null,
      };
    };
    mock.script = plan;
    const log = mcp.log.length;
    const withMcp = await codex.thread(model, path.join(root, "ws"), {
      config: urlServer(),
    });
    const plain = await codex.thread(model, path.join(root, "ws"));
    const turn = await codex.turn(withMcp, "use the probe tools");
    await codex.turn(plain, "use the probe tools");
    await codex.stop();

    const mine = mock.forThread(withMcp);
    const other = mock.forThread(plain);
    const firstTools = toolNames(mine[0]);
    const deferred = !firstTools.some((n) => n.includes("probe_echo"));
    const reachable = mine.flatMap(reachableTools);
    assert(reachable.some((n) => n === "mcp__probe/probe_echo"));
    // The thread without the override never sees the server.
    assert(!other.flatMap(reachableTools).some((n) => n.includes("probe")));
    assert(
      !JSON.stringify(other[0].tools).includes("probe"),
      "tool_search description must not list probe for the other thread",
    );
    const calls = turn.items.filter((i) => i.type === "mcpToolCall");
    assert.deepEqual(
      calls.map((c) => [c.server, c.tool, c.status]),
      [
        ["probe", "probe_echo", "completed"],
        ["probe", "probe_ask", "completed"],
        ["probe", "probe_image", "completed"],
      ],
    );
    const traffic = mcp.log.slice(log);
    assert(traffic.every((l) => l.authorization === `Bearer ${TOKEN}`));
    const toolCalls = traffic.filter((l) => l.method === "tools/call");
    assert(toolCalls.every((l) => l.params?._meta?.threadId === withMcp));
    // Our server's elicitation reached the client as a form, answer returned.
    const form = elicitations.find((e) => e._meta === null);
    assert.equal(form?.mode, "form");
    assert.equal(form?.serverName, "probe");
    assert.equal(form?.threadId, withMcp);
    assert.deepEqual(mcp.elicitationAnswers.at(-1), {
      action: "accept",
      content: { choice: "allow_once" },
    });
    // Known OpenAI models get MCP tools only through tool_search; models
    // Codex has no metadata for get them upfront.
    assert.equal(deferred, model === MODEL, "MCP tool deferral");
    // approve mode: Codex asked no approval of its own.
    assert.equal(elicitations.length, 1);
    // MCP image content → Responses input_image.
    const imageOut = outputs(mine.at(-1)!).at(-1)!;
    assert(Array.isArray(imageOut.output));
    assert(
      imageOut.output.some(
        (p: Json) =>
          p.type === "input_image" &&
          p.image_url === `data:image/png;base64,${TINY_PNG}`,
      ),
    );
    findings[`perThread_${model}`] = {
      perThreadUrlOverride: true,
      bearerTokenEnvVar: true,
      mcpToolsDeferredBehindToolSearch: deferred,
      toolNamespace: "mcp__probe",
      firstRequestTools: firstTools,
      otherThreadSeesServer: false,
      mcpSessions: traffic.filter((l) => l.method === "initialize").length,
      httpGetStreamOpened: traffic.some((l) => l.httpMethod === "GET"),
      protocolVersionOffered: traffic.find((l) => l.method === "initialize")
        ?.params?.protocolVersion,
      clientCapabilities: traffic.find((l) => l.method === "initialize")?.params
        ?.capabilities,
      toolsCallMeta: toolCalls[0]?.params?._meta,
      elicitationRequest: form,
      imageResultForwardedAsInputImage: true,
      startupStatusNotifications: codex.notifications
        .filter((n) => n.method === "mcpServer/startupStatus/updated")
        .map((n) => n.params),
    };
  });
}

test("default_tools_approval_mode semantics", async () => {
  const codex = await host("home-approval");
  const seen: Json[] = [];
  codex.onRequest = (r) => {
    if (r.method !== "mcpServer/elicitation/request") return undefined;
    seen.push(r.params);
    // Decline Codex's own approval; accept our server's form.
    return r.params._meta?.codex_approval_kind === "mcp_tool_call"
      ? { action: "decline", content: null, _meta: null }
      : { action: "accept", content: { choice: "deny" }, _meta: null };
  };
  mock.script = toolPlan([{ suffix: "probe_echo", args: { text: "x" } }]);
  const result: Json = {};
  for (const mode of ["auto", "prompt", "approve"]) {
    const before = seen.length;
    const calls = mcp.log.filter((l) => l.method === "tools/call").length;
    const id = await codex.thread(INLINE_MODEL, path.join(root, "ws"), {
      config: urlServer({
        "mcp_servers.probe.default_tools_approval_mode": mode,
      }),
    });
    const turn = await codex.turn(id, "echo");
    const approvals = seen
      .slice(before)
      .filter((e) => e._meta?.codex_approval_kind === "mcp_tool_call");
    result[mode] = {
      codexApprovalRequests: approvals.length,
      approvalMeta: approvals[0]?._meta ?? null,
      approvalMessage: approvals[0]?.message ?? null,
      toolReachedServer:
        mcp.log.filter((l) => l.method === "tools/call").length > calls,
      itemStatus: turn.items.find((i) => i.type === "mcpToolCall")?.status,
    };
  }
  await codex.stop();
  assert.equal(result.approve.codexApprovalRequests, 0);
  assert.equal(result.approve.toolReachedServer, true);
  assert.equal(result.auto.codexApprovalRequests, 1);
  assert.equal(result.auto.toolReachedServer, false);
  assert.equal(result.prompt.codexApprovalRequests, 1);
  assert.equal(result.prompt.toolReachedServer, false);
  findings.defaultToolsApprovalMode = result;
});

test("global server disabled per thread; per-thread stdio env", async () => {
  const home = path.join(root, "home-global");
  fs.mkdirSync(home, { recursive: true });
  // Engine.start() writes mcp_servers into config.toml; a thread turns one off.
  fs.writeFileSync(
    path.join(home, "config.toml"),
    `[mcp_servers.probe]\nurl = ${JSON.stringify(mcp.url)}\nbearer_token_env_var = "SPIKE_PROBE_TOKEN"\ndefault_tools_approval_mode = "approve"\n`,
  );
  const codex = await host("home-global");
  mock.script = toolPlan([{ suffix: "whoami" }]);
  const stdioLog = path.join(root, "stdio.log");
  const stdio = (conversation: string) => ({
    "mcp_servers.cu.command": process.execPath,
    "mcp_servers.cu.args": [path.join(import.meta.dirname, "stdio-mcp.mjs")],
    "mcp_servers.cu.env": { SPIKE_CONV: conversation, SPIKE_LOG: stdioLog },
    "mcp_servers.cu.default_tools_approval_mode": "approve",
  });
  const on = await codex.thread(INLINE_MODEL, path.join(root, "ws"), {
    config: stdio("conv-A"),
  });
  const off = await codex.thread(INLINE_MODEL, path.join(root, "ws"), {
    config: { "mcp_servers.probe.enabled": false, ...stdio("conv-B") },
  });
  const a = await codex.turn(on, "whoami");
  const b = await codex.turn(off, "whoami");
  await codex.stop();
  const toolsOn = reachableTools(mock.forThread(on)[0]);
  const toolsOff = reachableTools(mock.forThread(off)[0]);
  assert(toolsOn.some((n) => n.includes("probe_echo")));
  assert(!toolsOff.some((n) => n.includes("probe")));
  const text = (turn: typeof a) =>
    JSON.stringify(
      outputs(mock.forThread(turn.completed.threadId).at(-1)!).at(-1)?.output,
    );
  assert.match(text(a), /CONV:conv-A/);
  assert.match(text(b), /CONV:conv-B/);
  const starts = fs
    .readFileSync(stdioLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(starts.map((s) => s.conversation).sort(), [
    "conv-A",
    "conv-B",
  ]);
  findings.globalServerDisabledPerThread = true;
  findings.perThreadStdioEnv = {
    works: true,
    processesStarted: starts.length,
    oneProcessPerThread: new Set(starts.map((s) => s.pid)).size === 2,
    toolsCallMetaHasThreadId: text(a).includes(on),
  };
});

test("same override on two threads: one MCP session each", async () => {
  const codex = await host("home-two");
  mock.script = toolPlan([{ suffix: "probe_echo", args: { text: "t" } }]);
  const log = mcp.log.length;
  const a = await codex.thread(INLINE_MODEL, path.join(root, "ws"), {
    config: urlServer(),
  });
  const b = await codex.thread(INLINE_MODEL, path.join(root, "ws"), {
    config: urlServer(),
  });
  await codex.turn(a, "echo");
  await codex.turn(b, "echo");
  await codex.stop();
  const traffic = mcp.log.slice(log);
  const sessions = new Set(
    traffic.filter((l) => l.method === "tools/call").map((l) => l.sessionId),
  );
  findings.sameOverrideTwoThreads = {
    initializeCount: traffic.filter((l) => l.method === "initialize").length,
    distinctSessionsUsedByToolCalls: sessions.size,
  };
  assert.equal(sessions.size, 2);
});

test("per-thread http_headers, persistence and resume after restart", async () => {
  const home = "home-resume";
  let codex = await host(home);
  mock.script = toolPlan([{ suffix: "probe_echo", args: { text: "r" } }]);
  const log = mcp.log.length;
  const id = await codex.thread(INLINE_MODEL, path.join(root, "ws"), {
    config: {
      "mcp_servers.probe.url": mcp.url,
      "mcp_servers.probe.http_headers": {
        Authorization: `Bearer ${HEADER_TOKEN}`,
      },
      "mcp_servers.probe.default_tools_approval_mode": "approve",
    },
  });
  await codex.turn(id, "echo");
  await codex.stop();
  const headerAuth = mcp.log.slice(log).map((l) => l.authorization);
  // Is the per-thread override (and its literal token) written to disk?
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : files.push(path.join(dir, e.name));
  };
  walk(path.join(root, home));
  const leaked = files.filter((f) =>
    fs.readFileSync(f).includes(Buffer.from(HEADER_TOKEN)),
  );
  // Restart, resume without the override: does the server come back?
  codex = await host(home);
  await codex.rpc.call("thread/resume", { threadId: id });
  const before = mock.forThread(id).length;
  await codex.turn(id, "echo again");
  const withoutOverride = mock.forThread(id).slice(before);
  await codex.stop();
  // Restart, resume with the override again.
  codex = await host(home);
  await codex.rpc.call("thread/resume", {
    threadId: id,
    config: {
      "mcp_servers.probe.url": mcp.url,
      "mcp_servers.probe.bearer_token_env_var": "SPIKE_PROBE_TOKEN",
      "mcp_servers.probe.default_tools_approval_mode": "approve",
    },
  });
  const before2 = mock.forThread(id).length;
  await codex.turn(id, "echo third");
  const withOverride = mock.forThread(id).slice(before2);
  // thread/fork (retry / edit branches) with and without the override.
  const forkWith = await codex.rpc.call("thread/fork", {
    threadId: id,
    config: urlServer(),
  });
  await codex.turn(forkWith.thread.id, "echo fork");
  const forkWithout = await codex.rpc.call("thread/fork", { threadId: id });
  await codex.turn(forkWithout.thread.id, "echo fork plain");
  // Is it only a startup race? Fork with the override, wait for "ready".
  const forkWait = await codex.rpc.call("thread/fork", {
    threadId: id,
    config: urlServer(),
  });
  await until(
    () =>
      codex.notifications.some(
        (n) =>
          n.method === "mcpServer/startupStatus/updated" &&
          n.params?.threadId === forkWait.thread.id &&
          n.params?.status === "ready",
      ),
    "fork MCP ready",
    15_000,
  ).catch(() => {});
  await delay(500);
  await codex.turn(forkWait.thread.id, "echo fork after ready");
  // Workaround candidate: unsubscribe the fork and resume it with the override.
  const forkResumed = await codex.rpc.call("thread/fork", { threadId: id });
  await codex.rpc.call("thread/unsubscribe", {
    threadId: forkResumed.thread.id,
  });
  await codex.rpc.call("thread/resume", {
    threadId: forkResumed.thread.id,
    config: urlServer(),
  });
  await codex.turn(forkResumed.thread.id, "echo fork resumed");
  await codex.stop();
  const forkReach = (forkId: string) =>
    mock
      .forThread(forkId)
      .flatMap(reachableTools)
      .includes("mcp__probe/probe_echo");
  findings.fork = {
    withOverrideServerAvailable: forkReach(forkWith.thread.id),
    withoutOverrideServerAvailable: forkReach(forkWithout.thread.id),
    withOverrideAfterReady: forkReach(forkWait.thread.id),
    forkThenUnsubscribeResumeWithOverride: forkReach(forkResumed.thread.id),
    forkRequestsSeen: mock.forThread(forkWith.thread.id).length,
    forkStartupStatus: codex.notifications
      .filter(
        (n) =>
          n.method === "mcpServer/startupStatus/updated" &&
          n.params?.threadId === forkWith.thread.id,
      )
      .map((n) => n.params.status),
  };
  assert(headerAuth.every((a) => a === `Bearer ${HEADER_TOKEN}`));
  assert(
    withOverride.flatMap(reachableTools).includes("mcp__probe/probe_echo"),
  );
  // Observed on 0.144.1: the override is not persisted (resume must pass it
  // again), the literal header token is not written to disk, and a fork
  // exposes the server's tools only after unsubscribe + resume.
  assert.deepEqual(leaked, [], "per-thread header token written to disk");
  assert.equal(
    withoutOverride.flatMap(reachableTools).includes("mcp__probe/probe_echo"),
    false,
  );
  assert.equal(findings.fork.withOverrideServerAvailable, false);
  assert.equal(findings.fork.withOverrideAfterReady, false);
  assert.equal(findings.fork.forkThenUnsubscribeResumeWithOverride, true);
  findings.perThreadHttpHeaders = {
    works: true,
    tokenWrittenToDisk: leaked.map((f) => path.relative(root, f)),
  };
  findings.resumeAfterRestart = {
    withoutOverrideServerAvailable: withoutOverride
      .flatMap(reachableTools)
      .includes("mcp__probe/probe_echo"),
    withOverrideServerAvailable: true,
  };
});
