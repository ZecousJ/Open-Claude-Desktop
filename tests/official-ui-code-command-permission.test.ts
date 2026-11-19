import {
  codeApprovalIsStopping,
  holdCodeTurnApprovals,
} from "../electron/engine/code-interrupt-scope";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  createCodeCommandPermissionHost,
  type CodeExecutionApprovalResult,
} from "../electron/official-ui/code-command-permission-host";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { Approval, Conversation } from "../shared/types";

function fixture(
  options: { lasting?: boolean; surface?: "native" | "web" } = {},
) {
  const c = {
    id: "c",
    mode: "code",
    title: "Code",
    cwd: process.cwd(),
    threadId: "thread",
    createdAt: 1,
    updatedAt: 1,
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
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
  } as Conversation;
  const approval: Approval = {
    id: 7,
    conversationId: "c",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "printf inert",
    },
  };
  let runtime: object | undefined = {};
  let pending = [approval],
    active = true;
  const calls: { approval: Approval; result: CodeExecutionApprovalResult }[] =
    [];
  let dispatch = (a: Approval, result: CodeExecutionApprovalResult) => {
    calls.push({ approval: a, result });
    pending = pending.filter((p) => p !== a);
  };
  const host = createCodeCommandPermissionHost({
    current: () => active,
    runtime: () => runtime,
    approvals: () => pending,
    conversation: () => c,
    canRespond: (request) => !codeApprovalIsStopping(c, request.params),
    surface: options.surface,
    allowPersistent: () => options.lasting === true,
    respondExact: (a, result) => dispatch(a, result),
  });
  return {
    c,
    approval,
    host,
    calls,
    project: () => host.project(7, "c"),
    retire: () => {
      active = false;
    },
    setPending: (value: Approval[]) => {
      pending = value;
    },
    setRuntime: (value: object | undefined) => {
      runtime = value;
    },
    pending: () => pending,
    setDispatch: (fn: typeof dispatch) => {
      dispatch = fn;
    },
  };
}

test("a pending Stop refuses the original approval before reserving its response", () => {
  const f = fixture();
  const card = f.project()!;
  const release = holdCodeTurnApprovals(f.c.turns[0]!);
  assert.throws(
    () => f.host.respond(card.requestId, "once"),
    /No response was sent/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.project()?.requestId, card.requestId);
  release();
  f.host.respond(card.requestId, "once");
  assert.equal(f.calls.length, 1);
});

for (const decision of ["once", "deny"] as const)
  test(`${decision} binds the original command and dispatches exactly once`, () => {
    const f = fixture(),
      card = f.project()!;
    assert.match(card.requestId, /^code-command:/);
    assert.notEqual(card.requestId, String(f.approval.id));
    assert.equal(card.cliToolUseId, "turn:tool:item");
    assert.equal(card.suppressAlwaysAllowRule, true);
    assert.deepEqual(card.input, { command: "printf inert" });
    assert.deepEqual(f.project(), card);
    f.host.respond(card.requestId, decision, card.input);
    f.host.respond(card.requestId, decision);
    assert.deepEqual(f.calls, [
      {
        approval: f.approval,
        result: { decision: decision === "once" ? "accept" : "decline" },
      },
    ]);
    assert.equal(f.project(), undefined);
    assert.throws(
      () =>
        f.host.respond(card.requestId, decision === "once" ? "deny" : "once"),
      /no longer available/,
    );
  });

for (const choice of ["always", "acceptForSession", "accept", "cancel", ""])
  test(`rejects unsupported choice ${choice}`, () => {
    const f = fixture(),
      card = f.project()!;
    assert.throws(
      () => f.host.respond(card.requestId, choice),
      /Only allow once or deny/,
    );
    assert.equal(f.calls.length, 0);
    f.host.respond(card.requestId, "deny");
  });

test("edited or forged input never dispatches and does not consume the original choice", () => {
  const f = fixture(),
    card = f.project()!;
  assert.throws(() => f.host.respond("7", "once"), /no longer available/);
  assert.throws(
    () => f.host.respond(card.requestId, "once", { command: "different" }),
    /Edited approval/,
  );
  assert.equal(f.calls.length, 0);
  f.host.respond(card.requestId, "once", card.input);
  assert.equal(f.calls.length, 1);
});

const invalidChanges: Record<string, (f: ReturnType<typeof fixture>) => void> =
  {
    "mutated request id": (f) => {
      f.approval.id = 8;
    },
    "replaced runtime": (f) => {
      f.setRuntime({});
    },
    "removed runtime": (f) => {
      f.setRuntime(undefined);
    },
    "different thread": (f) => {
      f.c.threadId = "replaced";
    },
    "different branch": (f) => {
      f.c.activeBranchId = "new";
    },
    "different cwd": (f) => {
      f.c.cwd = "/different";
    },
    "changed command": (f) => {
      f.approval.params.command = "different";
      f.c.turns[0].items[0].command = "different";
    },
    "changed reason": (f) => {
      f.approval.params.reason = "new context";
    },
    "completed turn": (f) => {
      f.c.turns[0].status = "completed";
    },
    "completed item": (f) => {
      f.c.turns[0].items[0].status = "completed";
    },
    "interrupted lifecycle": (f) => {
      f.c.turns[0].items[0].lifecycleStatus = "interrupted";
    },
    "duplicate turn": (f) => {
      f.c.turns.push(structuredClone(f.c.turns[0]));
    },
    "duplicate item": (f) => {
      f.c.turns[0].items.push(structuredClone(f.c.turns[0].items[0]));
    },
    "missing item": (f) => {
      f.c.turns[0].items = [];
    },
    "cloud mirror": (f) => {
      f.c.cloudHosted = true;
    },
    "other mode": (f) => {
      f.c.mode = "cowork";
    },
    "different request object": (f) => {
      f.setPending([structuredClone(f.approval)]);
    },
    "duplicate request id": (f) => {
      f.setPending([f.approval, structuredClone(f.approval)]);
    },
    "numeric/string collision": (f) => {
      f.setPending([f.approval, { ...f.approval, id: "7" }]);
    },
    "removed request": (f) => {
      f.setPending([]);
    },
    "retired account": (f) => {
      f.retire();
    },
  };
for (const [label, change] of Object.entries(invalidChanges))
  test(`${label} invalidates the previously displayed capability`, () => {
    const f = fixture(),
      card = f.project()!;
    change(f);
    assert.throws(
      () => f.host.respond(card.requestId, "once"),
      /no longer available/,
    );
    assert.equal(f.calls.length, 0);
  });

for (const key of [
  "networkApprovalContext",
  "additionalPermissions",
  "proposedNetworkPolicyAmendments",
  "proposedExecPolicyAmendment",
  "permissions",
  "requestedSchema",
  "url",
  "mode",
])
  test(`never projects broader ${key}, including an empty value`, () => {
    const f = fixture();
    for (const value of [{}, [], false, ""]) {
      f.approval.params[key] = value;
      assert.equal(f.project(), undefined);
      assert.equal(f.calls.length, 0);
    }
  });
test("respects the runtime's available decisions", () => {
  const f = fixture();
  f.approval.params.availableDecisions = ["acceptForSession", "cancel"];
  assert.equal(f.project(), undefined);
  f.approval.params.availableDecisions = [
    "accept",
    "decline",
    "acceptForSession",
  ];
  assert.ok(f.project());
});
test("reused engine id obtains a distinct capability; the old token cannot authorize it", () => {
  const f = fixture(),
    first = f.project()!;
  f.setPending([
    { ...f.approval, params: { ...f.approval.params, reason: "new request" } },
  ]);
  const second = f.project()!;
  assert.notEqual(first.requestId, second.requestId);
  assert.throws(
    () => f.host.respond(first.requestId, "once"),
    /no longer available/,
  );
  f.host.respond(second.requestId, "deny");
  assert.equal(f.calls.length, 1);
});
for (const outcome of [
  "throw-before",
  "throw-after-removal",
  "not-consumed",
  "retired-after-dispatch",
])
  test(`${outcome} never becomes a false success or a replay`, () => {
    const f = fixture(),
      card = f.project()!;
    let dispatched = 0;
    f.setDispatch(() => {
      dispatched++;
      if (outcome === "throw-after-removal") f.setPending([]);
      if (outcome === "retired-after-dispatch") {
        f.setPending([]);
        f.retire();
      }
      if (outcome.startsWith("throw")) throw Error("inert transport error");
    });
    assert.throws(() => f.host.respond(card.requestId, "once"), /unconfirmed/);
    assert.throws(
      () => f.host.respond(card.requestId, "once"),
      /unconfirmed|no longer available/,
    );
    assert.equal(dispatched, 1);
    if (outcome === "throw-before" || outcome === "not-consumed")
      assert.match(f.project()!.title!, /unconfirmed/);
  });
test("reentrant repeated click cannot issue a second dispatch", () => {
  const f = fixture(),
    card = f.project()!;
  let dispatched = 0;
  f.setDispatch(() => {
    dispatched++;
    assert.throws(() => f.host.respond(card.requestId, "once"), /unconfirmed/);
    f.setPending([]);
  });
  f.host.respond(card.requestId, "once");
  assert.equal(dispatched, 1);
});

function nativeFixture() {
  const f = fixture(),
    handlers = new Map<string, (...args: any[]) => any>(),
    events: any[] = [];
  let listener!: (event: any) => void;
  let snapshot = async () => ({ approvals: f.pending() });
  registerExperimentalCodeSessions({
    ctx: {
      codeCommandPermissions: f.host,
      account: () => undefined,
      localLoadConversation: async () => f.c,
      localCall: async (name: string) => {
        if (name === "snapshot") return snapshot();
        throw Error(`Unexpected ${name}`);
      },
      onEvent: (fn: any) => {
        listener = fn;
        return () => {};
      },
      log() {},
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (_d: string, _c: string, event: any) => events.push(event),
  } as never);
  return {
    ...f,
    events,
    emit: (event: any) => listener(event),
    setSnapshot: (value: typeof snapshot) => {
      snapshot = value;
    },
    run: (name: string, ...args: any[]) =>
      handlers.get(`LocalSessions.${name}`)!(...args),
  };
}
test("native projection and resolved event preserve the opaque request id", async () => {
  const f = nativeFixture();
  const session = await f.run("getSession", "local_c"),
    card = session.pendingToolPermissions[0];
  await assert.rejects(
    f.run("respondToToolPermission", "7", "once"),
    /no longer available/,
  );
  f.emit({ type: "approval", approval: f.approval });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    f.events.find((e) => e.type === "tool_permission_request").request
      .requestId,
    card.requestId,
  );
  await f.run("respondToToolPermission", card.requestId, "once");
  f.emit({ type: "approval-resolved", id: f.approval.id });
  assert.equal(
    f.events.find((e) => e.type === "tool_permission_resolved").request
      .requestId,
    card.requestId,
  );
  assert.equal(
    (await f.run("getSession", "local_c")).pendingToolPermissions.length,
    0,
  );
});

const source = fs.readFileSync(
  new URL("../electron/official-ui/window.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("  context.codeCommandPermissions = ");
const end = source.indexOf("  context.openStaticArtifactPreview =", start);
assert.ok(start > 0 && end > start);
for (const connected of [true, false])
  test(`actual native wiring requires connected RPC (${connected})`, () => {
    const f = fixture(),
      context: any = {},
      engine = {
        rpc: { connected },
        policy: () => ({ approvalsAlwaysAllow: false }),
        ownApprovals: [f.approval],
        approve(id: any, result: any) {
          assert.equal(id, 7);
          f.calls.push({ approval: f.approval, result });
          engine.ownApprovals = [];
        },
      };
    vm.runInNewContext(source.slice(start, end), {
      createCodeCommandPermissionHost,
      codeApprovalIsStopping,
      context,
      commandEngine: engine,
      commandStore: { conversations: [f.c] },
      commandCurrent: () => true,
    });
    const card = context.codeCommandPermissions.project(7, "c");
    if (connected) {
      context.codeCommandPermissions.respond(card.requestId, "once");
      assert.equal(f.calls.length, 1);
    } else {
      assert.throws(
        () => context.codeCommandPermissions.respond(card.requestId, "once"),
        /unconfirmed/,
      );
      assert.equal(f.calls.length, 0);
    }
  });

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function mcpRequest(f: ReturnType<typeof fixture>): Approval {
  f.c.turns[0].items.push({
    id: "mcp",
    type: "mcpToolCall",
    server: "wiki",
    tool: "lookup",
    status: "inProgress",
  });
  return {
    id: 7,
    conversationId: "c",
    method: "mcpServer/elicitation/request",
    params: {
      turnId: "turn",
      serverName: "wiki",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: "lookup",
        tool_params: { query: "test" },
        persist: ["session"],
      },
    },
  };
}
for (const order of ["command-to-mcp", "mcp-to-command"])
  test(`native ${order} replacement resolves the old card and then the current card`, async () => {
    const f = nativeFixture(),
      mcp = mcpRequest(f);
    const first = order === "command-to-mcp" ? f.approval : mcp,
      second = order === "command-to-mcp" ? mcp : f.approval;
    f.setPending([first]);
    f.emit({ type: "approval", approval: first });
    await tick();
    const old = f.events.find(
      (e) => e.type === "tool_permission_request",
    ).request;
    f.setPending([second]);
    f.emit({ type: "approval", approval: second });
    await tick();
    const newest = f.events
      .filter((e) => e.type === "tool_permission_request")
      .at(-1).request;
    assert.notEqual(newest.requestId, old.requestId);
    assert.equal(
      f.events.filter((e) => e.type === "tool_permission_resolved")[0].request
        .requestId,
      old.requestId,
    );
    f.emit({ type: "approval-resolved", id: 7 });
    assert.equal(
      f.events.filter((e) => e.type === "tool_permission_resolved").at(-1)
        .request.requestId,
      newest.requestId,
    );
    assert.equal(f.calls.length, 0);
  });
test("unsupported replacement retires the old card without authorizing either request", async () => {
  const f = nativeFixture();
  await f.run("getSession", "local_c");
  const old = f.project()!;
  const replacement = {
    ...f.approval,
    params: { ...f.approval.params, additionalPermissions: {} },
  };
  f.setPending([replacement]);
  f.emit({ type: "approval", approval: replacement });
  await tick();
  assert.equal(
    f.events.find((e) => e.type === "tool_permission_resolved").request
      .requestId,
    old.requestId,
  );
  assert.ok(f.events.some((e) => e.type === "error"));
  await assert.rejects(
    f.run("respondToToolPermission", old.requestId, "once"),
    /no longer available/,
  );
  assert.equal(f.calls.length, 0);
});
test("a snapshot resolved after request resolution cannot poison a later MCP id", async () => {
  const f = nativeFixture();
  let resolve!: (value: { approvals: Approval[] }) => void;
  let requested!: () => void;
  const started = new Promise<void>((r) => {
    requested = r;
  });
  f.setSnapshot(() => {
    requested();
    return new Promise((r) => {
      resolve = r;
    });
  });
  const session = f.run("getSession", "local_c");
  await started;
  f.emit({ type: "approval-resolved", id: 7 });
  resolve({ approvals: [f.approval] });
  assert.equal((await session).pendingToolPermissions.length, 0);
  const mcp = mcpRequest(f);
  f.setPending([mcp]);
  f.emit({ type: "approval", approval: mcp });
  await tick();
  f.emit({ type: "approval-resolved", id: 7 });
  assert.equal(
    f.events.filter((e) => e.type === "tool_permission_resolved").at(-1).request
      .requestId,
    "7",
  );
});
for (const field of ["status", "lifecycleStatus"])
  test(`declined ${field} is never an active command approval`, () => {
    const f = fixture();
    (f.c.turns[0].items[0] as any)[field] = "declined";
    assert.equal(f.project(), undefined);
  });
for (const environmentId of ["ssh", "remote-1", "", false, {}])
  test(`non-local environment ${JSON.stringify(environmentId)} has no ordinary command card`, () => {
    const f = fixture();
    f.approval.params.environmentId = environmentId;
    assert.equal(f.project(), undefined);
  });
test("the version-pinned local environment id remains supported", () => {
  const f = fixture();
  f.approval.params.environmentId = "local";
  assert.ok(f.project());
});
test("an observed stale command cannot be revived by restoring its fields", () => {
  const f = fixture(),
    card = f.project()!;
  f.c.turns[0].items[0].status = "completed";
  assert.equal(f.project(), undefined);
  f.c.turns[0].items[0].status = "inProgress";
  assert.equal(f.project(), undefined);
  assert.throws(
    () => f.host.respond(card.requestId, "once"),
    /no longer available/,
  );
  assert.equal(f.calls.length, 0);
});

for (const decision of ["once", "deny"])
  test(`standard accept/amendment/cancel offers preserve ${decision} without a persistent grant`, () => {
    const f = fixture();
    f.approval.params.proposedExecpolicyAmendment = ["printf"];
    f.approval.params.availableDecisions = [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["printf"] } },
      "cancel",
    ];
    const card = f.project()!;
    assert.ok(card);
    assert.equal(card.suppressAlwaysAllowRule, true);
    f.host.respond(card.requestId, decision);
    assert.deepEqual(f.calls, [
      {
        approval: f.approval,
        result: { decision: decision === "once" ? "accept" : "decline" },
      },
    ]);
  });
for (const choices of [
  "accept",
  [],
  ["decline"],
  ["accept", "unknown"],
  ["accept", {}],
  [
    "accept",
    {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "example.test", action: "allow" },
      },
    },
  ],
  [
    "accept",
    {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["printf"],
        extra: true,
      },
    },
  ],
])
  test(`unsupported decision offer ${JSON.stringify(choices)} has no ordinary card`, () => {
    const f = fixture();
    f.approval.params.availableDecisions = choices;
    assert.equal(f.project(), undefined);
  });

test("the native lasting choice applies only the runtime's exact durable rule", () => {
  const f = fixture({ lasting: true });
  const amendment = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["printf"] },
  };
  f.approval.params.proposedExecpolicyAmendment = ["printf"];
  f.approval.params.availableDecisions = ["accept", amendment, "cancel"];
  const card = f.project()!;
  assert.equal(card.suggestions?.[0].destination, "userSettings");
  assert.deepEqual(card.suggestions?.[0].rules, [
    { toolName: "Bash", ruleContent: "printf:*" },
  ]);
  f.host.respond(card.requestId, "always", card.input);
  assert.deepEqual(f.calls, [
    { approval: f.approval, result: { decision: amendment } },
  ]);
});

test("Web lasting approval requires the exact session rule returned to the card", () => {
  const f = fixture({ lasting: true, surface: "web" });
  const amendment = {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["printf"] },
  };
  f.approval.params.proposedExecpolicyAmendment = ["printf"];
  f.approval.params.availableDecisions = ["accept", amendment, "cancel"];
  const card = f.project()!;
  const binding = {
    sessionId: card.sessionId,
    toolUseId: card.cliToolUseId!,
    toolNames: ["Bash"],
  };
  assert.equal(card.suggestions?.[0].destination, "session");
  assert.deepEqual(card.suggestions?.[0].rules, [
    { toolName: "Bash", ruleContent: "printf inert" },
  ]);
  assert.throws(
    () => f.host.respond(card.requestId, "always", card.input, binding),
    /Only allow once or deny/,
  );
  assert.throws(
    () =>
      f.host.respond(card.requestId, "always", card.input, binding, [
        {
          ...card.suggestions?.[0],
          rules: [{ toolName: "Bash", ruleContent: "printf:*" }],
        },
      ]),
    /Only allow once or deny/,
  );
  f.host.respond(
    card.requestId,
    "always",
    card.input,
    binding,
    card.suggestions,
  );
  assert.deepEqual(f.calls, [
    { approval: f.approval, result: { decision: "acceptForSession" } },
  ]);
});

test("an additional shell permission shows the exact access and has one-use decisions", () => {
  const f = fixture({ lasting: true });
  f.approval.params.additionalPermissions = {
    network: { enabled: true },
    fileSystem: {
      read: ["/fixture/read.txt"],
      write: ["/fixture/write.txt"],
    },
  };
  f.approval.params.availableDecisions = ["accept", "cancel"];
  const card = f.project()!;
  assert.equal(card.toolName, "Bash");
  assert.match(
    card.description!,
    /All network destinations\nRead \/fixture\/read.txt\nWrite \/fixture\/write.txt/,
  );
  assert.equal(card.suppressAlwaysAllowRule, true);
  assert.throws(
    () => f.host.respond(card.requestId, "always", card.input),
    /Only allow once or deny/,
  );
  f.host.respond(card.requestId, "once", card.input);
  assert.deepEqual(f.calls, [
    { approval: f.approval, result: { decision: "accept" } },
  ]);
});

for (const decision of ["once", "deny"] as const)
  test(`a standalone permission request answers ${decision} with the exact turn scope`, () => {
    const f = fixture({ lasting: true });
    const target = "/fixture/read.txt";
    const permissions = {
      network: { enabled: true },
      fileSystem: {
        read: [target],
        write: null,
        entries: [{ access: "read", path: { type: "path", path: target } }],
      },
    };
    f.approval.method = "item/permissions/requestApproval";
    f.approval.params = {
      threadId: "thread",
      turnId: "turn",
      itemId: "additional",
      cwd: f.c.cwd,
      permissions,
    };
    const card = f.project()!;
    assert.equal(card.toolName, "request_permissions");
    assert.deepEqual(card.input, {
      read: [target],
      network: "All network destinations",
    });
    assert.match(card.description!, /for the rest of this turn/);
    f.host.respond(card.requestId, decision, card.input);
    assert.deepEqual(f.calls, [
      {
        approval: f.approval,
        result: {
          permissions: decision === "once" ? permissions : {},
          scope: "turn",
        },
      },
    ]);
  });
