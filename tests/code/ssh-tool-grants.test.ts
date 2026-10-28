import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { SshToolGrantStore } from "../../electron/ssh/tool-grants";
import { approvalResponse } from "../../shared/approval-response";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import type { SshHost } from "../../shared/ssh-api";
import { registerSshHandlers } from "../../electron/ipc/ssh-handlers";

const host: SshHost = {
  id: "host",
  destination: "me@devbox",
  label: "Devbox",
  createdAt: 1,
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ssh-grants-"));
  const store = new Store(root);
  store.settings.mcpServers = { linear: { url: "https://linear.example/mcp" } };
  store.conversations.push({
    id: "code",
    threadId: "thread",
    mode: "code",
    turns: [],
  } as unknown as Conversation);
  const responses: { id: unknown; result: any }[] = [];
  const binding = { endpointKey: '["me@devbox",22]', hostKey: "trusted-key" };
  const launcher = { sshHost: host, sshToolBinding: binding };
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      environment: { kind: "ssh", hostId: host.id },
      launcher: launcher as any,
    },
  );
  engine.policy = () => openPolicy;
  engine.rpc = {
    respond: (id: unknown, result: unknown) => responses.push({ id, result }),
  } as any;
  (engine as any).routes.set("thread", "code");
  let requestId = 0;
  const request = (
    server = "linear",
    tool = "create_issue",
    extra: Record<string, unknown> = {},
  ) => {
    (engine as any).request({
      id: ++requestId,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread",
        mode: "form",
        serverName: server,
        message: "Approve tool?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_name: tool,
          tool_title: "Create issue",
          connector_name: "Linear",
          persist: ["session", "always"],
          ...extra,
        },
      },
    });
    return engine.approvals.at(-1)!;
  };
  return {
    root,
    store,
    engine,
    binding,
    launcher,
    responses,
    request,
    grants: new SshToolGrantStore(root),
    close: () => {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("SSH Always allow persists host/server/tool grants and skips only that host's tool", () => {
  const env = setup();
  try {
    const approval = env.request();
    env.engine.approve(approval.id, approvalResponse(approval, "always"));
    assert.equal(env.grants.list().length, 1);
    assert.equal(new SshToolGrantStore(env.root).list()[0].hostLabel, "Devbox");
    assert.equal(env.grants.list()[0].toolLabel, "Create issue");
    assert.equal(
      (env.store.settings.mcpServers.linear as any).tools,
      undefined,
    );
    assert.deepEqual(env.responses[0].result, {
      action: "accept",
      content: null,
      _meta: null,
    });
    env.request();
    assert.equal(env.engine.approvals.length, 0);
    assert.equal(env.responses.length, 2);
    env.request("linear", "delete_issue");
    assert.equal(env.engine.approvals.length, 1);
    env.binding.endpointKey = '["me@another",22]';
    env.request();
    assert.equal(env.engine.approvals.length, 2);
  } finally {
    env.close();
  }
});

test("removing and clearing real grants restores the prompt immediately", async () => {
  const env = setup();
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerSshHandlers((name, handler) => handlers.set(name, handler), {
      store: env.store,
      onAccountActivated() {},
      onAccountDeactivating() {},
    } as any);
    const approve = () => {
      const approval = env.request();
      env.engine.approve(approval.id, approvalResponse(approval, "always"));
    };
    approve();
    const [grant] = await handlers.get("sshToolGrants")!();
    await handlers.get("sshRemoveToolGrant")!(
      grant.endpointKey,
      grant.server,
      grant.toolName,
    );
    assert.deepEqual(await handlers.get("sshToolGrants")!(), []);
    const approval = env.request();
    assert.equal(env.engine.approvals.length, 1);
    env.engine.approve(approval.id, approvalResponse(approval, "always"));
    await handlers.get("sshClearToolGrants")!();
    env.request();
    assert.equal(env.engine.approvals.length, 1);
    await assert.rejects(
      handlers.get("sshRemoveToolGrant")!({}, "linear", "create_issue"),
    );
  } finally {
    env.close();
  }
});

test("host key changes, connector changes and policy never reuse an SSH grant", () => {
  const env = setup();
  try {
    const approval = env.request();
    env.engine.approve(approval.id, approvalResponse(approval, "always"));
    env.binding.hostKey = "replacement-key";
    env.request();
    assert.equal(env.engine.approvals.length, 1);
    env.binding.hostKey = "trusted-key";
    env.store.settings.mcpServers.linear = {
      url: "https://different.example/mcp",
    };
    env.request();
    assert.equal(env.engine.approvals.length, 2);
    env.store.settings.mcpServers.linear = {
      url: "https://linear.example/mcp",
    };
    env.engine.policy = () => ({ ...openPolicy, approvalsAlwaysAllow: false });
    const refused = env.request();
    assert.equal(env.engine.approvals.length, 3);
    assert.throws(
      () =>
        env.engine.approve(refused.id, {
          action: "accept",
          _meta: { persist: "always" },
        }),
      /approving each request/,
    );
  } finally {
    env.close();
  }
});

test("once, deny, session-only and unconfigured requests never create SSH grants", () => {
  const env = setup();
  try {
    for (const choice of ["once", "deny"] as const) {
      const approval = env.request();
      env.engine.approve(approval.id, approvalResponse(approval, choice));
    }
    const session = env.request("linear", "create_issue", {
      persist: ["session"],
    });
    env.engine.approve(session.id, approvalResponse(session, "always"));
    const unknown = env.request("unknown");
    env.engine.approve(unknown.id, {
      action: "accept",
      _meta: { persist: "always" },
    });
    assert.deepEqual(env.grants.list(), []);
    assert.ok(env.responses.every(({ result }) => result._meta === null));
  } finally {
    env.close();
  }
});

test("SSH startup ignores local connector approvals so removal remains revocable", () => {
  const env = setup();
  try {
    env.store.settings.mcpServers.linear = {
      url: "https://linear.example/mcp",
      tools: { create_issue: { approval_mode: "approve" } },
    };
    const config = JSON.parse((env.engine as any).mcpConfig());
    assert.notEqual(
      config.linear.tools?.create_issue?.approval_mode,
      "approve",
    );
    const approval = env.request();
    env.engine.approve(approval.id, approvalResponse(approval, "always"));
    assert.equal(
      fs.statSync(path.join(env.root, "ssh-tool-grants.json")).mode & 0o777,
      0o600,
    );
    env.grants.clear();
    env.request();
    assert.equal(env.engine.approvals.length, 1);
  } finally {
    env.close();
  }
});

test("Plan mode still asks even when the SSH host tool is allowed", () => {
  const env = setup();
  try {
    const approval = env.request();
    env.engine.approve(approval.id, approvalResponse(approval, "always"));
    env.store.settings.codePlanMode = true;
    env.request();
    assert.equal(env.engine.approvals.length, 1);
  } finally {
    env.close();
  }
});
