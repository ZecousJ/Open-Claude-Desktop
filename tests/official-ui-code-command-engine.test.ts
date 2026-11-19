/** Production request -> native registration -> captured wiring -> engine response; inert transport only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  request,
  approve,
  rememberToolApproval,
} from "../electron/engine/engine-approvals";
import { codeApprovalIsStopping } from "../electron/engine/code-interrupt-scope";
import { createCodeCommandPermissionHost } from "../electron/official-ui/code-command-permission-host";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";

const source = fs.readFileSync(
  new URL("../electron/official-ui/window.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("  context.codeCommandPermissions = "),
  end = source.indexOf("  context.openStaticArtifactPreview =", start);
assert.ok(start > 0 && end > start);

test("local Windows declines extra writable roots before offering an approval", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const received: unknown[] = [];
  const conversation = { id: "code", threadId: "t", mode: "code", turns: [] };
  const engine = {
    routes: new Map([["t", conversation.id]]),
    environment: { kind: "local" },
    windowsSandbox: { supportsScopedWrites: false },
    store: { conversation: () => conversation },
    rpc: { respond: (id: number, result: unknown) => received.push({ id, result }) },
    emit: () => assert.fail("A grant the sandbox cannot enforce must not be offered"),
  };
  try {
    request.call(engine as never, {
      id: 1,
      method: "item/permissions/requestApproval",
      params: { threadId: "t", permissions: { fileSystem: { write: ["C:\\fixture\\out"] } } },
    });
    request.call(engine as never, {
      id: 2,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t",
        additionalPermissions: {
          fileSystem: { entries: [{ access: "write", path: { type: "path", path: "C:\\fixture\\out" } }] },
        },
      },
    });
    assert.deepEqual(received, [
      { id: 1, result: { permissions: {}, scope: "turn" } },
      { id: 2, result: { decision: "decline" } },
    ]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("a Code turn in bypass mode answers execution approvals without a dialog", () => {
  const conversation = {
    id: "code", threadId: "t", mode: "code", cwd: "/fixture",
    codePermissionMode: "manual",
    turns: [{ id: "turn", status: "inProgress", codePermissionMode: "bypass" }],
  };
  const wire: unknown[] = [];
  const engine = {
    routes: new Map([["t", conversation.id]]),
    environment: { kind: "local" },
    store: {
      conversation: () => conversation,
      settings: { codeSandbox: "read-only", allowBypassPermissions: true, bypassFolders: [] },
    },
    rpc: { respond: (id: number, result: unknown) => wire.push({ id, result }) },
    emit: () => assert.fail("Bypass must not show an execution approval"),
  };
  const params = { threadId: "t", turnId: "turn" };
  request.call(engine as never, { id: 1, method: "item/commandExecution/requestApproval", params });
  request.call(engine as never, { id: 2, method: "item/fileChange/requestApproval", params });
  request.call(engine as never, {
    id: 3, method: "item/permissions/requestApproval",
    params: { ...params, permissions: { fileSystem: { read: ["/outside"] } } },
  });
  assert.deepEqual(wire, [
    { id: 1, result: { decision: "accept" } },
    { id: 2, result: { decision: "accept" } },
    { id: 3, result: { permissions: { fileSystem: { read: ["/outside"], write: null } }, scope: "turn" } },
  ]);
});

for (const decision of ["once", "deny"])
  test(`production engine chain sends ${decision} once without persistence or generic IPC fallback`, async () => {
    const c: any = {
      id: "c",
      threadId: "t",
      cwd: process.cwd(),
      mode: "code",
      title: "Inert",
      providerId: "p",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      turns: [
        {
          id: "turn",
          prompt: "test",
          createdAt: 2,
          attachments: [],
          status: "inProgress",
          items: [
            {
              id: "item",
              type: "commandExecution",
              command: "printf inert",
              status: "inProgress",
            },
          ],
        },
      ],
    };
    const handlers = new Map<string, (...args: any[]) => any>(),
      ui: any[] = [],
      wire: any[] = [];
    let listener = (_event: any) => {},
      persisted = 0;
    const engine: any = {
      ownApprovals: [],
      appApprovals: new Map(),
      requestIds: new Map(),
      routes: new Map([["t", "c"]]),
      environment: { kind: "local" },
      store: {
        settings: {},
        conversations: [c],
        conversation: () => c,
        flush: () => {
          persisted++;
        },
      },
      rpc: {
        connected: true,
        respond: (id: any, result: any) => wire.push({ id, result }),
        reject: () => {
          throw Error("Unexpected RPC rejection");
        },
      },
      policy: () => ({ approvalsAlwaysAllow: false }),
      approvalId: (id: any) => id,
      requestIdOf: (id: any) => id,
      offeredParams: (msg: any) => msg.params,
      sshToolApproval: () => undefined,
      emit: (event: any) => listener(event),
      rememberToolApproval(result: any, value: any) {
        return rememberToolApproval.call(engine, result, value);
      },
      approve(id: any, result: any) {
        return approve.call(engine, id, result);
      },
    };
    const context: any = {
      account: () => ({ id: "test" }),
      sessionIdentity: () => engine,
      localLoadConversation: async () => c,
      localCall: async (name: string) => {
        if (name === "snapshot") return { approvals: engine.ownApprovals };
        throw Error("Unexpected generic IPC dispatch: " + name);
      },
      onEvent: (fn: any) => {
        listener = fn;
        return () => {};
      },
      log() {},
    };
    vm.runInNewContext(source.slice(start, end), {
      context,
      commandCurrent: () => true,
      commandEngine: engine,
      commandStore: engine.store,
      createCodeCommandPermissionHost,
      codeApprovalIsStopping,
    });
    registerExperimentalCodeSessions({
      ctx: context,
      on: (name: string, fn: any) => handlers.set(name, fn),
      emit: (_domain: string, _event: string, value: any) => ui.push(value),
    } as never);
    const params = {
      threadId: "t",
      turnId: "turn",
      itemId: "item",
      command: "printf inert",
      environmentId: "local",
      proposedExecpolicyAmendment: ["printf"],
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["printf"] } },
        "cancel",
      ],
    };
    request.call(engine, {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const session = await handlers.get("LocalSessions.getSession")!("local_c"),
      card = session.pendingToolPermissions[0];
    assert.match(card.requestId, /^code-command:/);
    assert.equal(
      ui.find((e) => e.type === "tool_permission_request").request.requestId,
      card.requestId,
    );
    await handlers.get("LocalSessions.respondToToolPermission")!(
      card.requestId,
      decision,
    );
    await handlers.get("LocalSessions.respondToToolPermission")!(
      card.requestId,
      decision,
    );
    assert.deepEqual(structuredClone(wire), [
      {
        id: 7,
        result: { decision: decision === "once" ? "accept" : "decline" },
      },
    ]);
    assert.equal(persisted, 0);
    assert.equal(engine.ownApprovals.length, 0);
    assert.equal(
      ui.find((e) => e.type === "tool_permission_resolved").request.requestId,
      card.requestId,
    );
  });
