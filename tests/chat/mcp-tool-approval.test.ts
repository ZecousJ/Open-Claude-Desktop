import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPolicy, onlyConnectorSwitches } from "../../shared/client-policy";
import { sessionWideGrant } from "../../shared/approval-grants";
import {
  alwaysAllowedTools,
  alwaysScope,
  mcpToolApproval,
  mcpToolApprovalResponse,
  toolApprovalMode,
  validToolsTable,
  withOfferedPersist,
  withoutAlwaysAllowed,
  withToolApproval,
} from "../../shared/mcp-tool-approval";
import {
  allowsAlways,
  approvalResponse,
} from "../../src/approval/approval-model";
import { ApprovalCard } from "../../src/ui/ApprovalCard";
import { groupMode, modeOf } from "../../src/settings/tabs/ToolPermissions";
import { Engine } from "../../electron/engine/engine";
import {
  mcpServerStates,
  withToolEnabled,
} from "../../electron/connectors/mcp-config-file";
import { Store } from "../../electron/store/store";
import type { Approval } from "../../shared/types";

/** The elicitation Codex 0.144.1 sends for a connector tool call. */
const params = (persist: unknown = ["session", "always"]) => ({
  threadId: "t1",
  turnId: "u1",
  serverName: "linear",
  mode: "form",
  message: 'Allow the linear MCP server to run tool "create_issue"?',
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    persist,
    tool_title: "Create issue",
    tool_name: "create_issue",
    connector_name: "Linear",
    tool_params: { title: "Fix login", priority: 2 },
    tool_params_display: [
      { name: "title", value: "Fix login", display_name: "Title" },
      { name: "priority", value: 2, display_name: "Priority" },
    ],
  },
});
const approval = (p: unknown = params()): Approval => ({
  id: 41,
  conversationId: "c",
  method: "mcpServer/elicitation/request",
  params: p as any,
});

test("a connector tool approval is read from the request's metadata", () => {
  const info = mcpToolApproval(approval())!;
  assert.equal(info.server, "linear");
  assert.equal(info.tool, "create_issue");
  assert.equal(info.title, "Create issue");
  assert.equal(info.connector, "Linear");
  assert.deepEqual(info.rows, [
    { label: "Title", value: "Fix login" },
    { label: "Priority", value: "2" },
  ]);
  assert.deepEqual(info.persist, { session: true, always: true });
  assert.equal(alwaysScope(info), "always");
});

test("the parameters fall back to the raw call arguments, and the tool name to the message", () => {
  const raw = params("session") as any;
  delete raw._meta.tool_params_display;
  delete raw._meta.tool_name;
  delete raw._meta.tool_title;
  const info = mcpToolApproval(approval(raw))!;
  assert.deepEqual(info.rows, [
    { label: "title", value: "Fix login" },
    { label: "priority", value: "2" },
  ]);
  assert.equal(info.tool, "create_issue");
  assert.deepEqual(info.persist, { session: true, always: false });
  assert.equal(alwaysScope(info), "session");
});

test("only Codex's tool call elicitation counts as a tool approval", () => {
  assert.equal(
    mcpToolApproval(approval({ ...params(), _meta: { persist: "always" } })),
    undefined,
  );
  assert.equal(
    mcpToolApproval({
      ...approval(),
      method: "item/commandExecution/requestApproval",
    }),
    undefined,
  );
  assert.equal(
    mcpToolApproval(approval({ ...params(), mode: "url" })),
    undefined,
  );
});

test("the buttons answer with the persist scope the request offers", () => {
  const both = approval();
  assert.deepEqual(approvalResponse(both, "once"), {
    action: "accept",
    content: null,
    _meta: null,
  });
  assert.deepEqual(approvalResponse(both, "always"), {
    action: "accept",
    content: null,
    _meta: { persist: "always" },
  });
  assert.deepEqual(approvalResponse(both, "deny"), {
    action: "decline",
    content: null,
    _meta: null,
  });
  // Only the session's choice offered: Always allow keeps it for the session.
  assert.deepEqual(approvalResponse(approval(params(["session"])), "always"), {
    action: "accept",
    content: null,
    _meta: { persist: "session" },
  });
  // Nothing offered: the choice is a plain accept.
  assert.deepEqual(approvalResponse(approval(params([])), "always"), {
    action: "accept",
    content: null,
    _meta: null,
  });
  const info = mcpToolApproval(both)!;
  assert.deepEqual(mcpToolApprovalResponse(info, "once"), {
    action: "accept",
    content: null,
    _meta: null,
  });
});

test("a remembered choice is a session-wide grant; Allow once and Deny are not", () => {
  const a = approval();
  assert.equal(sessionWideGrant(approvalResponse(a, "always")), true);
  assert.equal(
    sessionWideGrant(approvalResponse(approval(params(["session"])), "always")),
    true,
  );
  for (const choice of ["once", "deny"] as const)
    assert.equal(sessionWideGrant(approvalResponse(a, choice)), false);
});

test("Always allow is offered when a scope is, unless the administrator turned it off", () => {
  assert.equal(allowsAlways(approval(), openPolicy), true);
  assert.equal(allowsAlways(approval(params([])), openPolicy), false);
  assert.equal(
    allowsAlways(approval(), { ...openPolicy, approvalsAlwaysAllow: false }),
    false,
  );
});

test("the engine offers Always allow only for a configured connector with a known tool", () => {
  const offer = (
    value: Record<string, unknown>,
    configured: boolean,
    alwaysAllowed = true,
  ) =>
    (
      (withOfferedPersist(value, { configured, alwaysAllowed }) as any)
        ._meta as any
    ).persist;
  assert.deepEqual(offer(params(), true), ["session", "always"]);
  // A built-in server has no connector settings to keep the choice in.
  assert.deepEqual(offer(params(), false), ["session"]);
  assert.deepEqual(offer(params(), true, false), []);
  const unnamed = params() as any;
  delete unnamed._meta.tool_name;
  unnamed.message = "Approve app tool call?";
  assert.deepEqual(offer(unnamed, true), ["session"]);
  // Other elicitations are left alone.
  const form = { message: "m", requestedSchema: {} };
  assert.equal(
    withOfferedPersist(form, { configured: true, alwaysAllowed: true }),
    form,
  );
});

test("a tool's approval mode lives in the connector's tools table", () => {
  const server = { url: "https://a.b/mcp", disabled_tools: ["delete"] };
  const on = withToolApproval(server, "create_issue", "approve");
  assert.deepEqual(on, {
    ...server,
    tools: { create_issue: { approval_mode: "approve" } },
  });
  assert.equal(toolApprovalMode(on, "create_issue"), "approve");
  assert.equal(toolApprovalMode(on, "other"), undefined);
  // Unblocking or blocking leaves the table; clearing the mode removes it.
  assert.deepEqual(withToolEnabled(on, "delete", true).tools, on.tools);
  assert.deepEqual(withToolApproval(on, "create_issue", undefined), {
    url: "https://a.b/mcp",
    disabled_tools: ["delete"],
  });
  const two = withToolApproval(
    withToolApproval(server, "a", "approve"),
    "b",
    "prompt",
  );
  assert.deepEqual(alwaysAllowedTools({ s: two, t: server }), [
    { server: "s", tool: "a" },
  ]);
  // Forget removes Always allow only, for one connector or all.
  assert.deepEqual((withoutAlwaysAllowed({ s: two, t: on }) as any).s.tools, {
    b: { approval_mode: "prompt" },
  });
  assert.equal(
    (withoutAlwaysAllowed({ s: two, t: on }) as any).t.tools,
    undefined,
  );
  assert.equal(
    (withoutAlwaysAllowed({ s: two, t: on }, "s") as any).t.tools.create_issue
      .approval_mode,
    "approve",
  );
});

test("a tools table is valid only with approve or prompt modes", () => {
  assert.equal(
    validToolsTable({
      a: { approval_mode: "approve" },
      b: { approval_mode: "prompt" },
    }),
    true,
  );
  assert.equal(validToolsTable({ a: { approval_mode: "auto" } }), false);
  assert.equal(
    validToolsTable({ a: { approval_mode: "approve", x: 1 } }),
    false,
  );
  assert.equal(validToolsTable({ a: "approve" }), false);
  assert.equal(validToolsTable([]), false);
  assert.equal(validToolsTable({ "": { approval_mode: "approve" } }), false);
});

test("approval modes are not edits of a connector under a policy that forbids editing", () => {
  const before = { s: { url: "https://a.b" } };
  assert.equal(
    onlyConnectorSwitches(before, {
      s: { url: "https://a.b", tools: { t: { approval_mode: "prompt" } } },
    }),
    true,
  );
  assert.equal(
    onlyConnectorSwitches(before, { s: { url: "https://c.d" } }),
    false,
  );
});

test("the connector list reports each tool's permission and how many are always allowed", () => {
  const config = withToolApproval(
    withToolApproval({ url: "https://a.b/mcp" }, "read", "approve"),
    "write",
    "prompt",
  );
  const [state] = mcpServerStates(
    { docs: { ...config, disabled_tools: ["drop"] } },
    true,
    new Map(),
    [
      {
        name: "docs",
        tools: { read: { name: "read" }, write: { name: "write" }, x: {} },
      },
    ],
  );
  const byName = Object.fromEntries(state.toolList!.map((t) => [t.name, t]));
  assert.equal(byName.read.approval, "approve");
  assert.equal(byName.write.approval, "prompt");
  assert.equal(byName.x.approval, undefined);
  assert.equal(byName.drop.enabled, false);
  assert.equal(state.alwaysAllowed, 1);
  assert.deepEqual(
    ["read", "write", "x", "drop"].map((name) => modeOf(byName[name])),
    ["allow", "ask", "ask", "block"],
  );
  assert.equal(groupMode([byName.read]), "allow");
  assert.equal(groupMode(state.toolList!), "custom");
});

test("the card asks in the official words and keeps the choice's scope", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval: approval(),
      frontmost: false,
      mac: true,
      onError: () => {},
    }),
  );
  assert.match(html, /Allow Claudex to use Linear: Create issue\?/);
  assert.match(html, /Title: Fix login/);
  assert.match(html, /More allow options/);
  assert.match(html, /Allow once/);
  assert.doesNotMatch(html, /cannot guarantee the security/);
  const sessionOnly = renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval: approval(params(["session"])),
      frontmost: false,
      mac: true,
      onError: () => {},
    }),
  );
  assert.match(sessionOnly, /More allow options/);
  assert.doesNotMatch(sessionOnly, />Always allow</);
});

function engineWith(servers: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-mcp-always-"));
  const store = new Store(root);
  store.settings.mcpServers = servers;
  const responses: unknown[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.rpc = {
    respond: (_id: unknown, result: unknown) => responses.push(result),
  } as any;
  return {
    engine,
    store,
    responses,
    done: () => {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Always allow keeps the tool's approval mode in the connector's settings, without a restart", () => {
  const { engine, store, responses, done } = engineWith({
    linear: { url: "https://linear.example/mcp" },
  });
  try {
    const open = approval();
    (engine as any).approvals = [open];
    (engine as any).startedMcp = (engine as any).runtimeKey();
    let saved = 0;
    engine.onMcpServersRemembered = () => saved++;
    engine.approve(41, approvalResponse(open, "always"));
    assert.deepEqual(responses, [
      { action: "accept", content: null, _meta: { persist: "always" } },
    ]);
    assert.deepEqual(store.settings.mcpServers.linear, {
      url: "https://linear.example/mcp",
      tools: { create_issue: { approval_mode: "approve" } },
    });
    assert.equal(saved, 1);
    // The agent already has the choice: the next send does not restart it.
    assert.equal((engine as any).startedMcp, (engine as any).runtimeKey());
  } finally {
    done();
  }
});

test("Allow once, Deny and an unconfigured connector keep nothing", () => {
  const { engine, store, responses, done } = engineWith({
    linear: { url: "https://linear.example/mcp" },
  });
  try {
    const once = approval();
    (engine as any).approvals = [once];
    engine.approve(41, approvalResponse(once, "once"));
    assert.equal((store.settings.mcpServers.linear as any).tools, undefined);
    // A built-in server (not in the settings) has nothing to keep it in.
    const builtin = { ...approval(), id: 42 };
    builtin.params = { ...params(), serverName: "claudex_notes" } as any;
    (engine as any).approvals = [builtin];
    engine.approve(42, approvalResponse(builtin, "always"));
    assert.deepEqual(Object.keys(store.settings.mcpServers), ["linear"]);
    assert.equal(responses.length, 2);
  } finally {
    done();
  }
});

test("the engine refuses Always allow on a connector tool when the administrator turned it off", () => {
  const { engine, store, responses, done } = engineWith({
    linear: { url: "https://linear.example/mcp" },
  });
  try {
    const open = approval();
    (engine as any).approvals = [open];
    engine.policy = () => ({ ...openPolicy, approvalsAlwaysAllow: false });
    assert.throws(
      () => engine.approve(41, approvalResponse(open, "always")),
      /approving each request/,
    );
    assert.equal(responses.length, 0);
    assert.equal((store.settings.mcpServers.linear as any).tools, undefined);
    engine.approve(41, approvalResponse(open, "once"));
    assert.equal(responses.length, 1);
  } finally {
    done();
  }
});

test("the engine hands a window only the persist choices it can keep", () => {
  const { engine, done } = engineWith({
    linear: { url: "https://linear.example/mcp" },
  });
  try {
    const shaped = (name: string, always = true) => {
      engine.policy = () => ({ ...openPolicy, approvalsAlwaysAllow: always });
      return (engine as any).offeredParams({
        method: "mcpServer/elicitation/request",
        params: { ...params(), serverName: name },
      })._meta.persist;
    };
    assert.deepEqual(shaped("linear"), ["session", "always"]);
    assert.deepEqual(shaped("claudex_notes"), ["session"]);
    assert.deepEqual(shaped("linear", false), []);
    // A form's field order travels beside the schema, for clients that decode it unordered.
    const form = (engine as any).offeredParams({
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "linear",
        mode: "form",
        message: "m",
        requestedSchema: {
          type: "object",
          properties: { b: { type: "string" }, a: { type: "string" } },
        },
      },
    });
    assert.deepEqual(form.claudexFieldOrder, ["b", "a"]);
  } finally {
    done();
  }
});
