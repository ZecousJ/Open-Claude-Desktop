import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../shared/types";
import { ownedSideQuestionGateway } from "../electron/engine/side-question-gateway-host";

test("side gateway preserves account, session, project and memory instructions, then detects changes", async () => {
  let current = true,
    closed = 0;
  const conversation = {
    id: "c",
    mode: "chat",
    providerId: "p",
    model: "m",
    projectId: "project",
    sessionInstructions: "Session rule",
  } as Conversation;
  const project = { id: "project", instructions: "Project rule" };
  const store = {
    settings: {
      instructions: "Account rule",
      providers: [{ id: "p", model: "m", models: ["m"] }],
    },
    projects: [project],
  };
  const gateway = {
    url: "http://127.0.0.1/v1",
    token: "token",
    openSidePath: async () => "a".repeat(64),
    closeSidePath: async () => {
      closed++;
    },
  };
  const engine = {
    providerId: "p",
    gateway,
    gatewayEndpoint: () => ({ url: gateway.url, token: gateway.token }),
    policy: () => ({}),
    threadOptions: (c: any, _p: any, _m: any, _mode: any, pr: any) => ({
      developerInstructions: [
        store.settings.instructions,
        c.sessionInstructions,
        pr?.instructions,
        "Synthetic memory",
      ].join("\n"),
    }),
  };
  const host = await ownedSideQuestionGateway({
    engine: engine as any,
    store: store as any,
    conversation,
    model: "m",
    signal: new AbortController().signal,
    current: () => current,
  });
  assert.match(host.instructions!, /Account rule/);
  assert.match(host.instructions!, /Session rule/);
  assert.match(host.instructions!, /Project rule/);
  assert.match(host.instructions!, /Synthetic memory/);
  assert.match(host.instructions!, /Do not use tools/);
  host.verifyContext!(conversation);
  const target = await host.open();
  assert.equal(target.path, "a".repeat(64));
  await host.close(target.path);
  assert.equal(closed, 1);
  project.instructions = "Changed";
  assert.throws(
    () => host.verifyContext!(conversation),
    /instructions changed/,
  );
  current = false;
  assert.equal(host.current(), false);
});

test("side gateway refuses missing projects and cannot switch an active model service", async () => {
  const conversation = {
    id: "c",
    mode: "chat",
    providerId: "p",
    model: "m",
    projectId: "missing",
  } as Conversation;
  const store = {
    settings: { providers: [{ id: "p", model: "m", models: ["m"] }] },
    projects: [],
  };
  const gateway = {
    url: "http://127.0.0.1/v1",
    token: "token",
    openSidePath: async () => "a".repeat(64),
    closeSidePath: async () => {},
  };
  const engine = {
    providerId: "p",
    gateway,
    gatewayEndpoint: () => ({ url: gateway.url, token: gateway.token }),
    policy: () => ({}),
    threadOptions: () => ({ developerInstructions: "x" }),
  };
  const options = {
    engine: engine as any,
    store: store as any,
    conversation,
    model: "m",
    signal: new AbortController().signal,
    current: () => true,
  };
  await assert.rejects(
    ownedSideQuestionGateway(options),
    /project is unavailable/,
  );
  engine.providerId = "other";
  await assert.rejects(
    ownedSideQuestionGateway(options),
    /service is not active/,
  );
});

test("side gateway uses the actual memory extension with project and incognito scope", async () => {
  const { createMemoryExtension } = await import("../electron/memory/inject");
  const projectId = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const memory = createMemoryExtension({
    service: () =>
      ({
        effective: () => ({ generate: true }),
        memoryFor: (scope: string) => ({
          doc: {
            content: scope === "global" ? "GLOBAL_MEMORY" : "PROJECT_MEMORY",
            updatedAt: 0,
          },
          edits: [],
        }),
      }) as any,
  });
  const store = {
    settings: { providers: [{ id: "p", model: "m", models: ["m"] }] },
    projects: [{ id: projectId, instructions: "" }],
  };
  const gateway = {
    url: "http://127.0.0.1/v1",
    token: "token",
    openSidePath: async () => "a".repeat(64),
    closeSidePath: async () => {},
  };
  const engine = {
    providerId: "p",
    gateway,
    gatewayEndpoint: () => ({ url: gateway.url, token: gateway.token }),
    policy: () => ({}),
    threadOptions: (conversation: any) => ({
      developerInstructions:
        memory.developerInstructions!({ conversation, mode: "chat" } as any) ??
        "",
    }),
  };
  const source = {
    id: "c",
    mode: "chat",
    providerId: "p",
    model: "m",
    projectId,
  } as Conversation;
  const create = (conversation: Conversation) =>
    ownedSideQuestionGateway({
      engine: engine as any,
      store: store as any,
      conversation,
      model: "m",
      signal: new AbortController().signal,
      current: () => true,
    });
  const project = await create(source);
  assert.match(project.instructions!, /PROJECT_MEMORY/);
  assert.doesNotMatch(project.instructions!, /GLOBAL_MEMORY/);
  const incognito = await create({ ...source, incognito: true });
  assert.doesNotMatch(incognito.instructions!, /PROJECT_MEMORY|GLOBAL_MEMORY/);
});
