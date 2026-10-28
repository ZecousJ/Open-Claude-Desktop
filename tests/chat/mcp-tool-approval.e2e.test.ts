/**
 * A connector tool's approval end to end with the real bundled Codex app-server
 * (loopback fixtures only, no credentials). Pins down what the approval card,
 * the engine and the phones rely on:
 * - a configured server's tool that is not read-only makes Codex ask through
 *   `mcpServer/elicitation/request`, with `_meta.codex_approval_kind`
 *   "mcp_tool_call", the call's parameters and `persist: ["session",
 *   "always"]`; the tool's name is only in the message (a connector's title and
 *   name come only for ChatGPT apps);
 * - the answer `_meta: { persist: "always" }` makes Codex write
 *   `mcp_servers.<server>.tools.<tool>.approval_mode = "approve"` itself;
 * - a tool whose approval_mode is "approve" is not asked about again;
 * - a "prompt" tool asks every time and offers nothing to remember. Skipped
 *   when the Codex binary is not installed.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { resolveRuntime } from "../../electron/engine/runtime";
import {
  CodexHost,
  MockResponses,
  MODEL,
  stopAllHosts,
  tempRoot,
  toolPlan,
  type Json,
} from "../spikes/harness";
import { McpHttpServer } from "../spikes/mcp-http-server";
import {
  alwaysScope,
  mcpToolApproval,
  withToolApproval,
} from "../../shared/mcp-tool-approval";
import { approvalResponse } from "../../shared/approval-response";

let binary: string | undefined;
try {
  binary = resolveRuntime();
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
