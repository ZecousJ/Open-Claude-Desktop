/**
 * A connector tool's approval end to end with the real bundled Codex
 * app-server (loopback fixtures only, no credentials). Pins down what the
 * approval card, the engine and the phones rely on (codex-cli 0.144.1,
 * checked 2026-10-13):
 * - a configured server's tool that is not read-only makes Codex ask through
 *   `mcpServer/elicitation/request`, with `_meta.codex_approval_kind`
 *   "mcp_tool_call", the call's parameters and `persist: ["session",
 *   "always"]`; the tool's name is only in the message (a connector's title
 *   and name come only for ChatGPT apps);
 * - the answer `_meta: { persist: "always" }` makes Codex write
 *   `mcp_servers.<server>.tools.<tool>.approval_mode = "approve"` itself;
 * - a tool whose approval_mode is "approve" is not asked about again;
 * - a "prompt" tool asks every time and offers nothing to remember.
 * Skipped when the Codex binary is not installed.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { build } from "esbuild";
import { Engine } from "../../electron/engine/engine";
import { resolveRuntime } from "../../electron/engine/runtime";
import { Store } from "../../electron/store/store";
import {
  CodexHost,
  FAKE_KEY,
  MockResponses,
  MODEL,
  message,
  stopAllHosts,
  tempRoot,
  toolPlan,
  until,
  type Json,
} from "../spikes/harness";
import { McpHttpServer } from "../spikes/mcp-http-server";
import {
  alwaysScope,
  mcpToolApproval,
  withoutAlwaysAllowed,
  withToolApproval,
} from "../../shared/mcp-tool-approval";
import { approvalResponse } from "../../shared/approval-response";
import { openPolicy } from "../../shared/client-policy";

let binary: string | undefined;
try {
  binary = resolveRuntime(process.env.CLAUDEX_RUNTIME_RESOURCES);
} catch {
  binary = undefined;
}
after(() => stopAllHosts());

const options = {
  skip: !binary && "the bundled Codex binary is not installed",
  timeout: 120_000,
};

/** One turn calling probe_echo against a server configured as `configure` says. */
async function run(
  choice: "once" | "always" | "deny",
  configure: (server: Record<string, unknown>) => Record<string, unknown>,
) {
  const root = tempRoot("mcp-approval");
  const mock = await new MockResponses().start();
  const mcp = await new McpHttpServer("tok").start();
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  // The file the engine writes at every start: the settings' servers as TOML.
  const server = configure({
    url: mcp.url,
    bearer_token_env_var: "PROBE_TOKEN",
  });
  fs.writeFileSync(
    path.join(home, "config.toml"),
    TOML.stringify({ mcp_servers: { probe: server } } as any),
  );
  const codex = await new CodexHost(
    home,
    mock,
    {},
    { PROBE_TOKEN: "tok" },
  ).start();
  try {
    const asked: Json[] = [];
    codex.onRequest = (request) => {
      if (request.method !== "mcpServer/elicitation/request") return undefined;
      asked.push(request.params);
      return approvalResponse(
        {
          id: request.id,
          conversationId: "c",
          method: request.method,
          params: request.params,
        },
        choice,
      );
    };
    mock.script = toolPlan([{ suffix: "probe_echo", args: { text: "hi" } }]);
    const thread = await codex.thread(MODEL, path.join(root, "ws"));
    const turn = await codex.turn(thread, "use the probe tool");
    return {
      asked,
      calls: turn.items.filter((item) => item.type === "mcpToolCall"),
      config: fs.readFileSync(path.join(home, "config.toml"), "utf8"),
    };
  } finally {
    await codex.stop();
    await mcp.close();
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const read = (params: Json) =>
  mcpToolApproval({ method: "mcpServer/elicitation/request", params })!;

test(
  "an unrestricted connector tool asks with what the card reads; Allow once runs it",
  options,
  async () => {
    const { asked, calls, config } = await run("once", (server) => server);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].serverName, "probe");
    const info = read(asked[0]);
    assert.equal(info.server, "probe");
    assert.equal(info.tool, "probe_echo");
    assert.deepEqual(
      info.rows.map((row) => row.value),
      ["hi"],
    );
    assert.deepEqual(info.persist, { session: true, always: true });
    assert.deepEqual(
      calls.map((call) => call.status),
      ["completed"],
    );
    assert.doesNotMatch(config, /approval_mode/);
  },
);

test(
  "Always allow is a persist answer Codex takes and writes down as the tool's approval mode",
  options,
  async () => {
    const { asked, calls, config } = await run("always", (server) => server);
    assert.equal(asked.length, 1);
    assert.deepEqual(
      calls.map((call) => call.status),
      ["completed"],
    );
    assert.match(config, /\[mcp_servers\.probe\.tools\.probe_echo\]/);
    assert.match(config, /approval_mode = "approve"/);
  },
);

test(
  "a tool the settings call Always allow is not asked about",
  options,
  async () => {
    const { asked, calls } = await run("deny", (server) =>
      withToolApproval(server, "probe_echo", "approve"),
    );
    assert.equal(asked.length, 0);
    assert.deepEqual(
      calls.map((call) => call.status),
      ["completed"],
    );
  },
);

test(
  "a Needs approval tool asks every time and offers nothing to remember",
  options,
  async () => {
    const { asked } = await run("once", (server) =>
      withToolApproval(server, "probe_echo", "prompt"),
    );
    assert.equal(asked.length, 1);
    const info = read(asked[0]);
    assert.deepEqual(info.persist, { session: false, always: false });
    assert.equal(alwaysScope(info), undefined);
  },
);

test("Deny declines the call", options, async () => {
  const { asked, calls } = await run("deny", (server) => server);
  assert.equal(asked.length, 1);
  assert.notDeepEqual(
    calls.map((call) => call.status),
    ["completed"],
  );
});

test(
  "configured read-only connector permissions apply to Chat and Code turns",
  options,
  async () => {
    assert.ok(binary);
    const root = tempRoot("mcp-effective-permissions");
    const mock = await new MockResponses().start();
    const mcp = await new McpHttpServer("fixture", "probe", {
      readOnlyHint: true,
    }).start();
    const store = new Store(path.join(root, "profile"));
    const cwd = path.join(root, "workspace");
    fs.mkdirSync(cwd);
    const provider = {
      id: "fixture",
      name: "Loopback Responses",
      model: MODEL,
      models: [],
      baseUrl: mock.url,
      protocol: "responses" as const,
    };
    store.settings.providers = [provider];
    store.settings.activeProviderId = provider.id;
    store.settings.ccNewTaskPrompt = "here";
    const service = path.join(root, "provider-service.cjs");
    const engine = new Engine(
      store,
      binary,
      () => FAKE_KEY,
      () => {},
      service,
    );
    engine.connectorHeaders = () => ({ Authorization: "Bearer fixture" });
    let policy = openPolicy;
    engine.policy = () => policy;
    const server = { url: mcp.url };
    const received = (marker: string) =>
      mcp.log.filter(
        (entry) =>
          entry.method === "tools/call" &&
          entry.params?.arguments?.text === marker,
      );
    const send = (
      mode: "chat" | "code",
      text: string,
      conversationId?: string,
    ) =>
      engine.send({
        mode,
        text,
        conversationId,
        cwd,
        attachments: [],
        providerId: provider.id,
        model: MODEL,
        ...(mode === "code" ? { codePermissionMode: "manual" } : {}),
      });
    const latest = (id: string) => store.conversation(id).turns.at(-1);
    const finished = (id: string) => latest(id)?.status !== "inProgress";
    let heldResponse: Promise<Json[]> | undefined;
    const check = async (
      mode: "chat" | "code",
      stage: string,
      expectation: { approval?: "once" | "always" | "deny"; calls: number },
      conversationId?: string,
    ) => {
      const marker = `${mode}-${stage}`;
      const plan = toolPlan([{ suffix: "probe_echo", args: { text: marker } }]);
      mock.script = (body, index) => {
        const prompt = JSON.stringify(
          body.input?.findLast((item: Json) => item.role === "user"),
        );
        if (prompt?.includes(marker)) return plan(body, index);
        if (heldResponse && prompt?.includes("f041-held-turn"))
          return heldResponse;
        return [message("FIXTURE_DONE")];
      };
      const conversation = await send(mode, marker, conversationId);
      const approval = () =>
        engine.approvals.find(
          (entry) => entry.conversationId === conversation.id,
        );
      await until(
        () => Boolean(approval()) || finished(conversation.id),
        marker,
      );
      const offered = approval();
      if (expectation.approval) {
        assert.ok(offered, marker);
        assert.equal(received(marker).length, 0, marker);
        const info = mcpToolApproval(offered);
        assert.equal(info?.tool, "probe_echo", marker);
        assert.equal(
          info?.persist.always,
          expectation.approval === "always",
          marker,
        );
        if (!policy.approvalsAlwaysAllow || stage === "explicit-ask") {
          assert.throws(
            () =>
              engine.approve(offered.id, {
                action: "accept",
                _meta: { persist: "always" },
              }),
            /Choose Allow once or Deny/,
          );
        }
        engine.approve(
          offered.id,
          approvalResponse(offered, expectation.approval),
        );
      } else {
        assert.equal(offered, undefined, marker);
      }
      await until(() => finished(conversation.id), marker);
      assert.equal(latest(conversation.id)?.status, "completed", marker);
      assert.equal(received(marker).length, expectation.calls, marker);
      return conversation;
    };
    let release: () => void = () => {};
    try {
      await build({
        entryPoints: ["server/provider-service.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22",
        outfile: service,
      });
      for (const mode of ["chat", "code"] as const) {
        store.settings.mcpServers = { probe: server };
        const { id, threadId } = await check(mode, "default", {
          approval: "always",
          calls: 1,
        });
        await check(mode, "remembered", { calls: 1 }, id);
        policy = { ...openPolicy, approvalsAlwaysAllow: false };
        await check(mode, "ceiling", { approval: "once", calls: 1 }, id);
        policy = openPolicy;
        await check(mode, "ceiling-restored", { calls: 1 }, id);
        store.settings.mcpServers = withoutAlwaysAllowed(
          store.settings.mcpServers,
        );
        await check(mode, "reset", { approval: "always", calls: 1 }, id);
        store.settings.mcpServers = {
          probe: withToolApproval(server, "probe_echo", "prompt"),
        };
        await check(mode, "explicit-ask", { approval: "once", calls: 1 }, id);
        await check(
          mode,
          "explicit-ask-again",
          { approval: "once", calls: 1 },
          id,
        );
        await check(mode, "explicit-deny", { approval: "deny", calls: 0 }, id);
        store.conversation(id).connectorToolOverrides = {
          probe: { probe_echo: false },
        };
        await check(mode, "session-disabled", { calls: 0 }, id);
        store.conversation(id).connectorToolOverrides = {
          probe: { probe_echo: true },
        };
        await check(
          mode,
          "session-enabled",
          { approval: "once", calls: 1 },
          id,
        );
        store.settings.mcpServers = {
          probe: { ...server, disabled_tools: ["probe_echo"] },
        };
        await check(mode, "account-blocked", { calls: 0 }, id);
        assert.equal(store.conversation(id).threadId, threadId);
      }

      policy = { ...openPolicy, approvalsAlwaysAllow: false };
      store.settings.mcpServers = {
        probe: {
          ...server,
          default_tools_approval_mode: "approve",
          tools: { probe_echo: { approval_mode: "auto" } },
        },
      };
      await check("chat", "developer-override-ceiling", {
        approval: "once",
        calls: 1,
      });
      policy = openPolicy;

      store.settings.mcpServers = {
        probe: withToolApproval(server, "probe_echo", "approve"),
      };
      const heldTurnResponse = new Promise<Json[]>((resolve) => {
        release = () => resolve([message("HELD_TURN_DONE")]);
      });
      heldResponse = heldTurnResponse;
      const beforeHold = mock.requests.length;
      mock.script = () => heldTurnResponse;
      const held = await send("chat", "f041-held-turn");
      await until(
        () => mock.requests.length > beforeHold,
        "first turn waiting for Responses",
      );
      const concurrent = await check("chat", "unchanged-concurrent", {
        calls: 1,
      });
      assert.equal(latest(held.id)?.status, "inProgress");
      store.settings.mcpServers = {
        probe: { ...server, disabled_tools: ["probe_echo"] },
      };
      await assert.rejects(
        send("chat", "stale-block", concurrent.id),
        /current task to finish/,
      );
      assert.equal(received("stale-block").length, 0);
      release();
      await until(() => finished(held.id), "first turn complete");
      await check("chat", "block-after-idle", { calls: 0 }, concurrent.id);
    } finally {
      release();
      await engine.stop();
      await mcp.close();
      await mock.close();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
