import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import { newConversation, type SendInput } from "../electron/engine/new-conversation";
import { Store } from "../electron/store/store";
import type { AppEvent, Conversation, Project, Provider } from "../shared/types";
import { useElectronShim } from "./runner/runner-core-support.test";

useElectronShim();
const { registerConversationManageHandlers } =
  await import("../electron/ipc/conversation-manage-handlers");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const id = "b72616c0-b401-48f7-8df6-d20cf3057e88";
  const sessionId = `local_${id}`;
  const session: Conversation = {
    id,
    title: "Cowork task",
    mode: "cowork",
    cwd: root,
    providerId: "inert",
    model: "inert",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [
      {
        id: "turn",
        prompt: "Existing task",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [],
      },
    ],
  };
  const project: Project = {
    id: "alpha",
    name: "Alpha",
    instructions: "",
    description: "",
    createdAt: 2,
    cwd: path.dirname(root),
  };
  store.conversations = [
    session,
    { ...session, id: "code", mode: "code" },
    { ...session, id: "cloud", cloudHosted: true },
  ];
  store.projects = [
    project,
    { ...project, id: "beta", name: "Beta", createdAt: 3 },
    { ...project, id: "local", kind: "local" },
    { ...project, id: "shared", visibility: "shared" },
    { ...project, id: "archived", archivedAt: 4 },
    { ...project, id: "cloud-copy" },
  ];
  store.flush();

  let activation = {};
  let beforeSnapshot: (() => void) | undefined;
  let updateCalls = 0;
  const starts: SendInput[] = [];
  let listener: ((event: AppEvent) => void) | undefined;
  const nativeEvents: unknown[][] = [];
  const writes = new Map<string, (...args: any[]) => unknown>();
  registerConversationManageHandlers({
    context: {
      store,
      engine: {},
      accountGeneration: () => activation,
      push: (event: AppEvent) => listener?.(event),
    },
    engineOf: () => undefined,
    handle: (name: string, handler: (...args: any[]) => unknown) =>
      writes.set(name, handler),
  } as never);
  const handlers = new Map<string, (...args: any[]) => any>();
  const provider: Provider = {
    id: "inert", name: "Fixture", model: "inert", models: ["inert"],
    baseUrl: "https://model.example.test", protocol: "responses",
  };
  const ctx = {
    readOnly: false,
    account: () => ({ id: "owner" }),
    sessionIdentity: () => activation,
    isCurrent: () => true,
    isCloudProject: (id: string) => id === "cloud-copy",
    settings: () => ({ activeProviderId: provider.id, providers: [provider] }),
    modelCatalog: async () => ({ items: [{ id: provider.model, efforts: ["medium", "high"] }] }),
    localListConversations: async () => structuredClone(store.conversations),
    localLoadConversation: async (id: string) =>
      structuredClone(store.conversations.find((c) => c.id === id)),
    onEvent(handler: (event: AppEvent) => void) {
      listener = handler;
      return () => {};
    },
    async localCall(name: string, ...args: unknown[]) {
      if (name === "snapshot") {
        const projects = structuredClone(store.projects);
        beforeSnapshot?.();
        return { projects, approvals: [] };
      }
      if (name === "updateConversation") {
        updateCalls++;
        return writes.get(name)!(...args);
      }
      if (name === "send") {
        const input = args[0] as SendInput;
        starts.push(input);
        const conversation = newConversation(input, provider, root);
        conversation.effort = input.effort;
        conversation.thinkingMode = input.thinkingMode;
        store.conversations.unshift(conversation);
        store.flush();
        return conversation;
      }
      throw Error(`Unexpected fixture call ${name}`);
    },
  };
  registerExperimentalCoworkSessions({
    ctx,
    on: (name: string, handler: (...args: any[]) => unknown) =>
      handlers.set(name, handler),
    emit: (...args: unknown[]) => nativeEvents.push(args),
  } as never);
  const call = (method: string, ...args: unknown[]) =>
    handlers.get(`LocalAgentModeSessions.${method}`)!(...args);
  return {
    root,
    store,
    id,
    sessionId,
    session,
    ctx,
    call,
    nativeEvents,
    starts,
    get updateCalls() {
      return updateCalls;
    },
    retireDuringSnapshot() {
      beforeSnapshot = () => {
        activation = {};
      };
    },
  };
}

test("Cowork starts with the selected project, reasoning, and session permission", async (t) => {
  const f = fixture(t);
  const result = await f.call("start", {
    message: "Start in Alpha",
    userSelectedProjectUuids: ["alpha"],
    model: "inert",
    effortLevel: "high",
    extendedThinkingEnabled: true,
    permissionMode: "auto",
  });
  const stored = new Store(f.root).conversation(result.sessionId.slice(6));
  assert.equal(stored.projectId, "alpha");
  assert.equal(stored.effort, "high");
  assert.equal(stored.thinkingMode, "extended");
  assert.equal(stored.coworkPermissionMode, "auto");
  const row = await f.call("getSession", result.sessionId);
  assert.deepEqual(row.userSelectedProjectUuids, ["alpha"]);
  assert.equal(row.effortLevel, "high");
  assert.equal(row.extendedThinkingEnabled, true);
  assert.equal(row.permissionMode, "auto");
  for (const target of ["shared", "archived", "cloud-copy", "unknown"]) {
    await assert.rejects(f.call("start", {
      message: "Not an eligible project",
      userSelectedProjectUuids: [target],
    }), /Project not found/);
  }
  await assert.rejects(f.call("start", { message: "Unavailable effort", effortLevel: "max" }), /not supported/);
  await assert.rejects(f.call("start", { message: "Invalid approval mode", permissionMode: "plan" }));
  assert.equal(f.starts.length, 1);
});

test("the original Cowork calls move, change and remove persisted project membership", async (t) => {
  const f = fixture(t);
  const transcript = await f.call("getTranscript", f.sessionId);
  for (const [selection, target] of [
    [{ userSelectedProjectUuids: ["alpha"] }, "alpha"],
    [{ userSelectedProjectUuids: ["beta"] }, "beta"],
    [{ spaceId: "", userSelectedProjectUuids: [] }, undefined],
  ] as const) {
    await f.call("updateSession", f.sessionId, selection);
    const persisted = new Store(f.root).conversation(f.id);
    assert.equal(persisted.projectId, target);
    assert.equal(persisted.cwd, f.session.cwd);
    assert.deepEqual(persisted.turns, f.session.turns);
    const expected = target ? [target] : [];
    const row = await f.call("getSession", f.sessionId);
    assert.deepEqual(row.userSelectedProjectUuids, expected);
    assert.equal(row.spaceId, undefined);
    assert.deepEqual(
      (await f.call("getSessionList")).sessions[0].userSelectedProjectUuids,
      expected,
    );
    assert.deepEqual(
      (await f.call("getAll"))[0].userSelectedProjectUuids,
      expected,
    );
    assert.deepEqual(await f.call("getTranscript", f.sessionId), transcript);
  }
  assert.equal(f.updateCalls, 3);
  assert.equal(
    f.nativeEvents.filter(
      ([, , event]) => (event as { type: string }).type === "session_updated",
    ).length,
    3,
  );
});

test("unsupported Cowork mutations and ineligible projects cannot write membership", async (t) => {
  const f = fixture(t);
  await f.call("updateSession", f.sessionId, { title: "An unrelated update" });
  await f.call("updateSession", f.sessionId, { spaceId: "an-execution-space" });
  for (const fields of [
    { userSelectedProjectUuids: ["alpha", "beta"] },
    { userSelectedProjectUuids: ["alpha"], title: "A mixed update" },
    { userSelectedProjectUuids: [], spaceId: "an-execution-space" },
  ]) {
    await assert.rejects(
      f.call("updateSession", f.sessionId, fields),
      /Invalid Cowork project selection/,
    );
  }
  for (const target of [
    "local",
    "shared",
    "archived",
    "cloud-copy",
    "unknown",
  ]) {
    await assert.rejects(
      f.call("updateSession", f.sessionId, {
        userSelectedProjectUuids: [target],
      }),
      /Project not found/,
    );
  }
  for (const id of ["local_code", "local_cloud"]) {
    await assert.rejects(
      f.call("updateSession", id, { userSelectedProjectUuids: ["alpha"] }),
      /session not found/,
    );
  }
  f.ctx.readOnly = true;
  await assert.rejects(
    f.call("updateSession", f.sessionId, {
      userSelectedProjectUuids: ["alpha"],
    }),
    /unavailable/,
  );
  f.ctx.readOnly = false;
  f.retireDuringSnapshot();
  await assert.rejects(
    f.call("updateSession", f.sessionId, {
      userSelectedProjectUuids: ["alpha"],
    }),
    /account changed/,
  );
  assert.equal(f.updateCalls, 0);
  assert.deepEqual(f.nativeEvents, []);
});
