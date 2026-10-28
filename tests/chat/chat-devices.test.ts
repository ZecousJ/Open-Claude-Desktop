import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  DeviceMethods,
  type DeviceHost,
} from "../../electron/remote-control/device-methods";
import {
  ChatDeviceController,
  type ChatDeviceRunnerHost,
} from "../../runner/src/chat-devices";
import type { ChatDeviceSendInput } from "../../shared/chat-devices-api";
import type {
  AppEvent,
  Approval,
  Attachment,
  Conversation,
} from "../../shared/types";
import { defaultSettings } from "../../electron/store/store";
import { portableChatDeviceConversation } from "../../shared/chat-device-context";
import { Engine } from "../../electron/engine/engine";
import { openPolicy } from "../../shared/client-policy";
import { DeviceTrustStore } from "../../electron/remote-control/device-trust-store";

const source = (patch: Partial<Conversation> = {}): Conversation => ({
  id: randomUUID(),
  title: "Reference",
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...patch,
});
async function setup(proof = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-chat-device-"));
  const cloud: Conversation[] = [],
    events: AppEvent[] = [],
    calls: { device: string; method: string; input: any }[] = [];
  const nodes = new Map<
    string,
    {
      conversations: Conversation[];
      methods: DeviceMethods;
      sent: any[];
      scope: string;
      online: boolean;
      access: boolean;
      version: number;
      permissions: string[];
      approvals: Approval[];
      approved: (string | number)[];
      interrupted: string[];
      blobs: Map<string, Uint8Array>;
      trust: DeviceTrustStore;
    }
  >();
  for (const id of ["device-a", "device-b"]) {
    const node = {
      conversations: [] as Conversation[],
      methods: undefined as unknown as DeviceMethods,
      sent: [] as any[],
      scope: "7",
      online: true,
      access: true,
      version: 1,
      permissions: ["default", "auto"],
      approvals: [] as Approval[],
      approved: [] as (string | number)[],
      interrupted: [] as string[],
      blobs: new Map<string, Uint8Array>(),
      trust: new DeviceTrustStore(path.join(root, id), "7", id),
    };
    if (proof) node.trust.setRequired(true);
    const host: DeviceHost = {
      conversations: () => node.conversations,
      approvals: () => node.approvals,
      remoteFolders: () => [],
      now: Date.now,
      models: () => ({ models: [{ providerId: "p", id: "m" }] }),
      computerAccess: () => node.access,
      send: async (input) => {
        const c = node.conversations.find(
          (c) => c.id === input.conversationId,
        )!;
        node.sent.push({
          ...input,
          permission: c.deviceChatOrigin?.permission,
        });
        c.threadId = "device-local-runtime";
        c.turns.push({
          id: randomUUID(),
          prompt: input.text,
          status: "completed",
          createdAt: Date.now(),
          attachments: input.attachments,
          items: [
            { id: "answer", type: "agentMessage", text: "Real remote reply" },
          ],
        });
        return c;
      },
      addAttachment: async (name, bytes) => ({
        id: randomUUID(),
        name,
        path: "/remote/attachment",
        size: bytes.byteLength,
        kind: "text",
      }),
      interrupt: async (id) => {
        node.interrupted.push(id);
        const c = node.conversations.find((c) => c.id === id)!;
        c.turns.at(-1)!.status = "interrupted";
      },
      approve: async (id) => {
        node.approved.push(id);
        node.approvals = node.approvals.filter((a) => a.id !== id);
      },
      update: async () => null,
      chatDevice: {
        accountScope: () => node.scope,
        save: async (c) => {
          const i = node.conversations.findIndex((value) => value.id === c.id);
          if (i < 0) node.conversations.push(c);
          else node.conversations[i] = c;
          return c;
        },
        release: async () => null,
        blob: async (digest) => {
          const bytes = node.blobs.get(digest);
          assert.ok(bytes);
          return bytes;
        },
      },
    };
    node.methods = new DeviceMethods(host);
    nodes.set(id, node);
  }
  let live = true,
    fallback = 0;
  let failSave = false;
  const attachments = new Map<string, Attachment>();
  const runnerHost: ChatDeviceRunnerHost = {
    accountScope: "7",
    trustScope: proof ? "https://fixture.example/account/7" : undefined,
    root,
    current: () => live,
    conversations: () => cloud,
    settings: () => ({ ...defaultSettings, taskPermission: "default" }),
    attachment: (id) => attachments.get(id),
    save: async (c) => {
      if (failSave) {
        failSave = false;
        throw new Error("Binding save failed");
      }
      const i = cloud.findIndex((value) => value.id === c.id);
      if (i < 0) cloud.push(c);
      else cloud[i] = c;
    },
    request: async (op, raw) => {
      const body = raw as any;
      if (op === "device.list")
        return {
          version: 1,
          ...(proof ? { deviceTrustRelayVersion: 1 as const } : {}),
          accountScope: "7",
          organizationId: null,
          devices: [...nodes].map(([id, node]) => ({
            id,
            name: id,
            platform: "test",
            version: "1",
            connectedAt: new Date().toISOString(),
            online: node.online,
            computerAccess: node.access,
            chatBindingVersion: node.version,
            chatModes: ["chat", "cowork"],
            chatPermissionModes: node.permissions,
          })),
        };
      assert.equal(body.version, 1);
      assert.equal(body.args.length, 1);
      const node = nodes.get(body.deviceId)!;
      if (proof) {
        assert.deepEqual(body.scope, {
          version: 1,
          accountScope: "7",
          organizationId: null,
        });
        if (body.method === "deviceTrustChallenge")
          return node.trust.challenge(body.args[0]);
        if (body.method === "deviceTrustEnroll")
          return node.trust.enroll(body.args[0]);
      }
      const args = proof
        ? node.trust.authorize(body.method, body.args)
        : body.args;
      const input = structuredClone(args[0]);
      calls.push({ device: body.deviceId, method: body.method, input });
      return node.methods.call(body.method, [input]);
    },
    push: (event) => events.push(event),
    release: async () => null,
  };
  const controller = new ChatDeviceController(runnerHost);
  const send = (patch: Partial<ChatDeviceSendInput> = {}) =>
    controller.send({
      version: 1,
      accountScope: "7",
      organizationId: null,
      requestId: randomUUID(),
      deviceId: "device-a",
      mode: "chat",
      text: "Neutral reference",
      providerId: "p",
      model: "m",
      taskPermission: "default",
      attachments: [],
      ...patch,
    });
  return {
    controller,
    send,
    cloud,
    nodes,
    events,
    calls,
    root,
    runnerHost,
    attachments,
    failNextSave: () => {
      failSave = true;
    },
    leave: () => {
      live = false;
    },
    fallback: async () => {
      fallback++;
      return "ordinary";
    },
    fallbackCount: () => fallback,
    clean: async () => {
      controller.dispose();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("V1 invokes actual device Chat execution with explicit model/permission, persists distinct logical mapping, and deduplicates the request", async () => {
  const h = await setup();
  try {
    const requestId = randomUUID();
    const first = await h.send({
      requestId,
      taskPermission: "auto",
      options: { effort: "high", webSearch: true },
    });
    assert.equal(first.id, requestId);
    assert.equal(first.mode, "chat");
    assert.equal(first.threadId, undefined);
    const binding = first.chatDeviceBinding!;
    assert.notEqual(binding.remoteConversationId, first.id);
    assert.equal(binding.accountScope, "7");
    assert.equal(binding.permission, "auto");
    assert.equal(h.nodes.get("device-a")!.sent.length, 1);
    assert.equal(h.nodes.get("device-a")!.sent[0].model, "m");
    assert.equal(h.nodes.get("device-a")!.sent[0].permission, "auto");
    assert.equal(h.nodes.get("device-a")!.sent[0].effort, "high");
    assert.equal(h.nodes.get("device-a")!.sent[0].webSearch, true);
    assert.equal(first.turns[0].items[0].text, "Real remote reply");
    await h.send({
      requestId,
      conversationId: first.id,
      expectedBindingRevision: binding.revision,
    });
    assert.equal(h.nodes.get("device-a")!.sent.length, 1);
    await h.send({
      conversationId: first.id,
      expectedBindingRevision: binding.revision,
    });
    assert.equal(h.nodes.get("device-a")!.sent.length, 2);
    assert.equal(h.fallbackCount(), 0);
  } finally {
    await h.clean();
  }
});

test("the stored Cowork execution kind is preserved by the new explicit protocol without using legacy newSession", async () => {
  const h = await setup();
  try {
    const c = await h.send({ mode: "cowork" });
    assert.equal(c.mode, "cowork");
    assert.equal(h.nodes.get("device-a")!.sent[0].mode, "cowork");
    assert.equal(
      h.calls.some(
        (call) =>
          call.method === "newSession" || call.method === "exportCoworkTask",
      ),
      false,
    );
  } finally {
    await h.clean();
  }
});

test("wrong versions, account/org scope, offline/access, permissions and model reject without ordinary fallback or a fabricated binding", async () => {
  const h = await setup();
  try {
    await assert.rejects(
      h.send({ accountScope: "other" }),
      /account or organization/,
    );
    await assert.rejects(h.controller.send({ version: 2 }), /Invalid/);
    await assert.rejects(h.send({ organizationId: "org" } as never), /Invalid/);
    const node = h.nodes.get("device-a")!;
    for (const [part, error] of [
      [{ version: 0 }, /version 1/],
      [{ online: false }, /offline/],
      [{ access: false }, /access is off/],
      [{ permissions: ["default"] }, /permission mode/],
    ] as const) {
      Object.assign(
        node,
        {
          version: 1,
          online: true,
          access: true,
          permissions: ["default", "auto"],
        },
        part,
      );
      await assert.rejects(h.send({ taskPermission: "auto" }), error);
    }
    Object.assign(node, {
      version: 1,
      online: true,
      access: true,
      permissions: ["default", "auto"],
    });
    await assert.rejects(h.send({ model: "not-offered" }), /selected model/);
    assert.equal(h.cloud.length, 0);
    assert.equal(node.sent.length, 0);
    assert.equal(h.fallbackCount(), 0);
  } finally {
    await h.clean();
  }
});

test("a complete idle text history really migrates and cancels, preserving logical identity and monotonically increasing revisions", async () => {
  const h = await setup();
  try {
    const c = await h.send();
    const a = c.chatDeviceBinding!;
    const moved = await h.controller.select({
      version: 1,
      accountScope: "7",
      organizationId: null,
      conversationId: c.id,
      deviceId: "device-b",
      expectedBindingRevision: 1,
      taskPermission: "default",
    });
    assert.equal(moved.id, c.id);
    assert.equal(moved.chatDeviceBinding!.deviceId, "device-b");
    assert.equal(moved.chatDeviceRevision, 2);
    assert.equal(
      h.nodes.get("device-a")!.conversations[0].deviceChatOrigin!.active,
      false,
    );
    const b = h.nodes.get("device-b")!.conversations[0];
    assert.equal(b.threadId, undefined);
    assert.equal(b.importedHistory, true);
    assert.deepEqual(b.turns, c.turns);
    const ordinary = await h.controller.select({
      version: 1,
      accountScope: "7",
      organizationId: null,
      conversationId: c.id,
      deviceId: null,
      expectedBindingRevision: 2,
      taskPermission: "default",
    });
    assert.equal(ordinary.chatDeviceBinding, undefined);
    assert.equal(ordinary.chatDeviceRevision, 3);
    assert.equal(
      h.nodes.get("device-b")!.conversations[0].deviceChatOrigin!.active,
      false,
    );
    assert.equal(
      await h.controller.route("send", [{ conversationId: c.id }], h.fallback),
      "ordinary",
    );
    await assert.rejects(
      h.controller.select({
        version: 1,
        accountScope: "7",
        organizationId: null,
        conversationId: c.id,
        deviceId: "device-a",
        expectedBindingRevision: a.revision,
        taskPermission: "default",
      }),
      /binding changed/,
    );
  } finally {
    await h.clean();
  }
});

test("rich, truncated or fixed-owning Cowork history stays bound instead of pretending a checkbox moved it", async () => {
  const h = await setup();
  try {
    const c = await h.send();
    c.turns[0].items.push({ id: "tool", type: "commandExecution" });
    h.nodes.get("device-a")!.conversations[0].turns[0].items.push({
      id: "tool",
      type: "commandExecution",
    });
    await assert.rejects(
      h.controller.select({
        version: 1,
        accountScope: "7",
        organizationId: null,
        conversationId: c.id,
        deviceId: "device-b",
        expectedBindingRevision: 1,
        taskPermission: "default",
      }),
      /complete context/,
    );
    assert.equal(h.cloud[0].chatDeviceBinding!.deviceId, "device-a");
    assert.equal(
      h.nodes.get("device-a")!.conversations[0].deviceChatOrigin!.active,
      true,
    );
    assert.equal(h.nodes.get("device-b")!.conversations.length, 0);
    assert.throws(
      () =>
        portableChatDeviceConversation(
          source({
            turns: [
              {
                id: "t",
                prompt: "x".repeat(1501),
                attachments: [],
                status: "completed",
                createdAt: 1,
                items: [],
              },
            ],
          }),
        ),
      /complete context/,
    );
    const fixed = source({
      mode: "cowork",
      linkedToComputer: true,
      linkedComputerId: "device-a",
    });
    h.cloud.push(fixed);
    await assert.rejects(
      h.controller.select({
        version: 1,
        accountScope: "7",
        organizationId: null,
        conversationId: fixed.id,
        deviceId: null,
        expectedBindingRevision: 0,
        taskPermission: "default",
      }),
      /owning computer/,
    );
  } finally {
    await h.clean();
  }
});

test("closing the account context rejects retained device actions before any transport or ordinary execution", async () => {
  const h = await setup();
  try {
    h.leave();
    await assert.rejects(h.send(), /account changed/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.nodes.get("device-a")!.sent.length, 0);
  } finally {
    await h.clean();
  }
});

test("real remote streaming, approvals and stop return to the same logical Chat while the private runtime identity stays remote", async () => {
  const h = await setup();
  try {
    const c = await h.send(),
      node = h.nodes.get("device-a")!;
    const remote = node.conversations[0];
    remote.turns[0].status = "inProgress";
    remote.turns[0].items[0].text = "Streaming actual text";
    node.approvals.push({
      id: 9,
      conversationId: remote.id,
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd" },
    });
    await h.controller.refresh();
    assert.equal(h.cloud[0].id, c.id);
    assert.equal(h.cloud[0].threadId, undefined);
    assert.equal(h.cloud[0].turns[0].status, "inProgress");
    assert.equal(h.cloud[0].turns[0].items[0].text, "Streaming actual text");
    const approval = h.controller.pendingApprovals()[0];
    assert.equal(approval.conversationId, c.id);
    assert.match(String(approval.id), /^chat-device:/);
    await h.controller.route(
      "approve",
      [approval.id, { decision: "accept" }],
      () => assert.fail("not the runner engine"),
    );
    assert.deepEqual(node.approved, [9]);
    await h.controller.route("interrupt", [c.id], () =>
      assert.fail("not the runner engine"),
    );
    assert.deepEqual(node.interrupted, [remote.id]);
    await h.controller.refresh();
    assert.equal(h.cloud[0].turns[0].status, "interrupted");
    assert.equal(h.controller.pendingApprovals().length, 0);
    assert.equal(
      h.events
        .filter((event) => event.type === "conversation")
        .every(
          (event) =>
            event.type === "conversation" && event.conversation.id === c.id,
        ),
      true,
    );
  } finally {
    await h.clean();
  }
});

test("actual authorized attachment bytes transfer and a generated blob returns in verified chunks without exposing device paths", async () => {
  const h = await setup();
  try {
    const file = {
      id: "upload",
      name: "reference.txt",
      path: path.join(h.root, "reference.txt"),
      kind: "text" as const,
      size: 5,
    };
    await fs.writeFile(file.path, "hello");
    h.attachments.set(file.id, file);
    const c = await h.send({ attachments: [file] });
    const node = h.nodes.get("device-a")!,
      remote = node.conversations[0];
    assert.notEqual(node.sent[0].attachments[0].id, file.id);
    assert.equal(c.turns[0].attachments[0].id, file.id);
    assert.equal(c.turns[0].attachments[0].path, file.path);
    const bytes = new Uint8Array(300_000).fill(42),
      digest = createHash("sha256").update(bytes).digest("hex");
    node.blobs.set(digest, bytes);
    remote.turns[0].items.push({
      id: "generated",
      type: "fileChange",
      generatedFiles: [
        {
          id: "../private",
          name: "output.bin",
          path: "/private/device/output.bin",
          state: "ready",
          operation: "create",
          language: "",
          digest,
          blob: true,
        },
      ],
    });
    await h.controller.refresh();
    const output = h.cloud[0].turns[0].items[1].generatedFiles![0];
    assert.ok(output.path.startsWith(h.root + path.sep));
    assert.ok(!output.path.includes("/private/device"));
    assert.deepEqual(new Uint8Array(await fs.readFile(output.path)), bytes);
    assert.equal(
      h.calls.filter((call) => call.method === "chatDeviceBlob").length,
      2,
    );
    await assert.rejects(
      h.send({
        conversationId: c.id,
        attachments: [{ ...file, id: "not-authorized" }],
      }),
      /no longer available/,
    );
    assert.equal(node.sent.length, 1);
  } finally {
    await h.clean();
  }
});

test("a binding persistence failure reactivates the original real device and discards the prepared destination", async () => {
  const h = await setup();
  try {
    const c = await h.send();
    h.failNextSave();
    await assert.rejects(
      h.controller.select({
        version: 1,
        accountScope: "7",
        organizationId: null,
        conversationId: c.id,
        deviceId: "device-b",
        expectedBindingRevision: 1,
        taskPermission: "default",
      }),
      /Binding save failed/,
    );
    assert.equal(h.cloud[0].chatDeviceBinding!.deviceId, "device-a");
    assert.equal(
      h.nodes.get("device-a")!.conversations[0].deviceChatOrigin!.active,
      true,
    );
    assert.equal(
      h.nodes.get("device-b")!.conversations[0].deviceChatOrigin!.active,
      false,
    );
  } finally {
    await h.clean();
  }
});

test("a pending request owns the conversation until settlement and another request cannot race into a second actual send", async () => {
  const h = await setup();
  try {
    const id = randomUUID();
    const first = h.send({ requestId: id });
    const duplicate = h.send({ requestId: id });
    await assert.rejects(h.send({ conversationId: id }), /already being sent/);
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(a.id, b.id);
    assert.equal(h.nodes.get("device-a")!.sent.length, 1);
  } finally {
    await h.clean();
  }
});

test("actual handler routing rejects bound deletion/release in idle and running states without losing the logical mapping or pretending to stop the remote task", async () => {
  const h = await setup();
  try {
    const c = await h.send(),
      node = h.nodes.get("device-a")!;
    for (const status of ["completed", "inProgress"] as const) {
      h.cloud[0].turns[0].status = status;
      node.conversations[0].turns[0].status = status;
      for (const method of ["deleteConversation", "releaseRunner"]) {
        await assert.rejects(
          h.controller.route(method, [c.id], h.fallback),
          /isn't supported/,
        );
        assert.equal(h.cloud[0].chatDeviceBinding!.deviceId, "device-a");
        assert.equal(h.cloud[0].turns[0].status, status);
        assert.equal(node.conversations[0].turns[0].status, status);
      }
    }
    assert.deepEqual(node.interrupted, []);
    assert.equal(h.fallbackCount(), 0);
    const ordinary = source();
    h.cloud.push(ordinary);
    assert.equal(
      await h.controller.route("deleteConversation", [ordinary.id], h.fallback),
      "ordinary",
    );
    assert.equal(h.fallbackCount(), 1);
  } finally {
    await h.clean();
  }
});

test("a device account A→B→A store replacement retires an attachment-waiting request before it can append to the re-entered account", async () => {
  const h = await setup();
  try {
    await h.send();
    const node = h.nodes.get("device-a")!;
    const host = (node.methods as unknown as { host: DeviceHost }).host;
    let generation = {};
    host.chatDevice!.scope = () => generation;
    let finish!: (file: Attachment) => void;
    host.addAttachment = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const remote = node.conversations[0];
    const pending = node.methods.call("chatDeviceSend", [
      {
        version: 1,
        accountScope: "7",
        organizationId: null,
        logicalConversationId: remote.deviceChatOrigin!.logicalConversationId,
        remoteConversationId: remote.id,
        requestId: randomUUID(),
        text: "Retired request",
        providerId: "p",
        model: "m",
        taskPermission: "default",
        attachments: [{ name: "reference.txt", data: "aGVsbG8=" }],
      },
    ]);
    await Promise.resolve();
    assert.equal(typeof finish, "function");
    node.scope = "8";
    generation = {};
    node.methods.forget();
    node.scope = "7";
    generation = {};
    finish({
      id: "retired",
      name: "reference.txt",
      path: "/remote/retired",
      kind: "text",
      size: 5,
    });
    await assert.rejects(pending, /account changed/);
    assert.equal(node.sent.length, 1);
  } finally {
    await h.clean();
  }
});

test("the actual Engine thread and per-turn approval policies use the explicit device permission rather than local account bypass/auto defaults", () => {
  const engine = Object.create(Engine.prototype) as any;
  engine.options = {};
  engine.store = {
    root: "/synthetic",
    settings: {
      ...defaultSettings,
      taskPermission: "bypass",
      allowBypassPermissions: true,
    },
  };
  Object.defineProperty(engine, "platform", { value: "linux" });
  engine.policy = () => openPolicy;
  engine.extensions = {
    turnContext: () => undefined,
    widensSandbox: () => false,
    turnSandboxExtras: () => [],
    developerInstructions: () => [],
    dynamicTools: () => [],
    threadConfigOverrides: () => ({}),
    builtinMcpServers: () => [],
  };
  engine.mcpConfig = () => "{}";
  engine.contextConfig = () => ({});
  const provider = {
    id: "p",
    model: "m",
    models: ["m"],
    baseUrl: "https://example.invalid",
    protocol: "responses",
  };
  for (const mode of ["chat", "cowork"] as const)
    for (const permission of ["default", "auto"] as const) {
      const c = source({
        mode,
        cwd: "/synthetic/work",
        deviceChatOrigin: {
          version: 1,
          accountScope: "7",
          logicalConversationId: randomUUID(),
          active: true,
          permission,
        },
      });
      const context = engine.turnContext(c, provider, "m", mode);
      assert.equal(context.settings.taskPermission, permission);
      assert.equal(context.sandbox, "workspace-write");
      const expected = permission === "auto" ? "auto_review" : "user";
      assert.equal(
        engine.threadOptions(c, provider, "m", mode).approvalsReviewer,
        expected,
      );
      assert.equal(engine.turnExtras(context).approvalsReviewer, expected);
    }
  assert.equal(
    engine.store.settings.taskPermission,
    "bypass",
    "a remote request never edits local preferences",
  );
  const legacy = source({ cwd: "/synthetic/work" });
  assert.equal(
    engine.turnContext(legacy, provider, "m", "chat").settings.taskPermission,
    "bypass",
  );
  const imported = source({
    importedHistory: true,
    turns: [
      {
        id: "old",
        prompt: "Earlier prompt",
        status: "completed",
        createdAt: 1,
        attachments: [],
        items: [{ id: "reply", type: "agentMessage", text: "Earlier reply" }],
      },
      {
        id: "pending",
        prompt: "Current prompt",
        status: "inProgress",
        createdAt: 2,
        attachments: [],
        items: [],
      },
    ],
  });
  const options = engine.threadOptions(imported, provider, "m", "chat");
  assert.match(options.developerInstructions, /Earlier prompt/);
  assert.doesNotMatch(options.developerInstructions, /Person: Current prompt/);
});

test("protected runner Chat waits for real approval, then signs actual import/send/open/approval polling", async () => {
  const h = await setup(true);
  try {
    await assert.rejects(h.send(), /Approve this device/);
    const node = h.nodes.get("device-a")!;
    assert.equal(node.sent.length, 0);
    assert.equal(node.conversations.length, 0);
    const pending = node.trust.state().pending[0];
    assert.ok(pending);
    node.trust.approve(pending.id, pending.fingerprint);
    const c = await h.send();
    assert.equal(node.sent.length, 1);
    assert.ok(c.chatDeviceBinding);
    assert.equal(c.turns[0].items[0].text, "Real remote reply");
    const remote = node.conversations[0];
    node.approvals.push({
      id: 99,
      conversationId: remote.id,
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd" },
    });
    await h.controller.refresh();
    const approval = h.controller.pendingApprovals()[0];
    assert.ok(approval);
    await h.controller.route(
      "approve",
      [approval.id, { decision: "accept" }],
      () => assert.fail("runner fallback forbidden"),
    );
    assert.deepEqual(node.approved, [99]);
    assert.ok(h.calls.some((call) => call.method === "chatDeviceOpen"));
    assert.ok(h.calls.some((call) => call.method === "chatDeviceApprove"));
  } finally {
    await h.clean();
  }
});
test("protected runner Chat revocation denies later execution without an unsigned fallback", async () => {
  const h = await setup(true);
  try {
    await assert.rejects(h.send(), /Approve this device/);
    const node = h.nodes.get("device-a")!;
    const pending = node.trust.state().pending[0];
    node.trust.approve(pending.id, pending.fingerprint);
    const c = await h.send();
    node.trust.revoke(pending.id);
    const count = node.sent.length;
    await h.controller.refresh();
    assert.match(
      h.cloud.find((item) => item.id === c.id)!.chatDeviceError ?? "",
      /revoked/,
    );
    await assert.rejects(
      h.send({
        conversationId: c.id,
        expectedBindingRevision: c.chatDeviceBinding!.revision,
      }),
      /revoked/,
    );
    assert.equal(node.sent.length, count);
    assert.equal(h.fallbackCount(), 0);
  } finally {
    await h.clean();
  }
});
test("a retired runner cannot enroll or execute after an awaited challenge", async () => {
  const h = await setup(true);
  try {
    const original = h.runnerHost.request;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    h.runnerHost.request = async (op, body) => {
      const result = await original(op, body);
      if ((body as any).method === "deviceTrustChallenge") {
        entered();
        await gate;
      }
      return result;
    };
    const sending = h.send();
    await ready;
    h.leave();
    release();
    await assert.rejects(sending, /account changed/);
    const node = h.nodes.get("device-a")!;
    assert.equal(node.trust.state().pending.length, 0);
    assert.equal(node.sent.length, 0);
  } finally {
    await h.clean();
  }
});
