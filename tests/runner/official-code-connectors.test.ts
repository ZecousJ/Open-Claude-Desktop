import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { connectorUuid } from "../../electron/official-ui/api/connectors";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { AppEvent, Conversation } from "../../shared/types";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH, hiwonderKnowledgeRelayUrl } from "../../shared/knowledge-api";
import { openPolicy } from "../../shared/client-policy";
import { encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the original Cloud Code connector selection persists through the Runner and reopens", async (t) => {
  useElectronShim();
  const [{ CloudStore }, { run, newSession, resumedSetup }] = await Promise.all(
    [
      import("../../runner/src/cloud-store"),
      import("../../runner/src/dispatcher-sessions"),
    ],
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-code-connectors-"),
  );
  const user = { id: 1, accessToken: "fixture-token" };
  const account = { id: "fixture-owner" };
  const organization = organizationUuid(account.id);
  const web = memoryWebstore();
  const writeStarted = signal();
  const releaseWrite = signal();
  let pauseWrite = false;
  const transport = {
    async request(op: string, userId: number, body?: unknown) {
      if (op === "store.conversations.put" && pauseWrite) {
        pauseWrite = false;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return web.request(op, userId, body);
    },
  };
  const open = (name: string) =>
    CloudStore.open({
      root: path.join(root, name),
      userId: user.id,
      transport,
    });
  const connectorConfig = {
    one: {
      url: "https://one.invalid/mcp",
      display_name: "Connector One",
      http_headers: { Authorization: "Bearer private" },
    },
    two: { url: "https://two.invalid/mcp" },
    disabled: { url: "https://disabled.invalid/mcp", enabled: false },
    local: { command: "fixture-mcp" },
  };
  const original: Conversation = {
    id: "code",
    mode: "code",
    title: "Saved Cloud Code session",
    model: "code-model",
    providerId: "fixture-provider",
    updatedAt: 1,
    createdAt: 1,
    pinned: false,
    archived: false,
    connectorOverrides: { local: false },
    connectorToolOverrides: { one: { lookup: false } },
    turns: [],
  };
  const foreign: Conversation = {
    ...original,
    id: "foreign",
    sessionAuthors: {
      ownerAccountUuid: "other",
      viewerAccountUuid: account.id,
    },
  };
  const other: Conversation = { ...original, id: "chat", mode: "chat" };
  const archived: Conversation = {
    ...original,
    id: "archived",
    archived: true,
  };
  const events: AppEvent[] = [];
  let activation = {};
  const handlers = new Map<string, () => unknown>();
  const knowledgeService = "https://knowledge.example.test";
  let knowledgeAvailable = true;
  const ctx = {
    userId: user.id,
    activeAccount: account,
    get accountActivationIdentity() {
      return activation;
    },
    officialSessionIdentity: () => activation,
    remote: { ready: true, backend: {
      accounts: { baseUrl: knowledgeService }, session: { authorized: async () => ({
        bases: [{ id: HUANER_TECH, name: "Hiwonder Knowledge", available: knowledgeAvailable }],
      }) },
    } },
    policy: () => openPolicy,
    store: await open("before-restart"),
    handlers,
    selectedAttachments: new Map(),
    services: {},
    closedFlag: false,
    signedOut: false,
    setAccessToken() {},
    onEvent: () => () => {},
    push: (event: AppEvent) => events.push(event),
    appVersion: "fixture",
    log() {},
  };
  handlers.set("snapshot", () => ({ conversations: ctx.store.conversations }));
  t.after(async () => {
    releaseWrite.resolve();
    await ctx.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  ctx.store.conversations.push(
    structuredClone(original),
    foreign,
    other,
    archived,
  );
  ctx.store.settings.mcpServers = connectorConfig;
  await ctx.store.sync();
  const dispatcher = {
    options: {
      officialUiRoot: "/fixture-assets",
      officialUiActions: true,
      link: web,
    },
    guard: { modes: ["chat", "code"] },
    methods: ["snapshot"],
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    run,
    newSession,
    resumedSetup,
  } as unknown as Dispatcher;
  const call = (method: string, request: OfficialUiReadRequest) =>
    dispatcher.run({
      method,
      user,
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request);
  const action = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request);
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    read,
    async () => assert.fail("Code request escaped the local bridge"),
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: String(user.id),
      isCurrent: () => true,
      read,
      action,
    }),
  );
  const session = (conversation: Conversation) =>
    "/v1/code/sessions/cse_" + cloudCodeSessionKey(conversation, account.id);
  const detail = async () => {
    const response = await fetch(session(original), {
      headers: { "x-organization-uuid": organization },
    });
    assert.equal(response.status, 200);
    return (await response.json()).session.session_context.mcp_config
      .mcpServers;
  };
  const change = (
    rows: unknown[],
    endpoint = session(original),
    org: string | null = organization,
  ) =>
    fetch(endpoint + "/mcp-servers", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(org ? { "x-organization-uuid": org } : {}),
      },
      body: JSON.stringify({ mcp_servers: rows }),
    });
  const one = {
    type: "http",
    url: connectorConfig.one.url,
    headers: { "X-MCP-Server-ID": connectorUuid("one") },
  };
  const two = {
    type: "http",
    url: connectorConfig.two.url,
    headers: { "X-MCP-Server-ID": connectorUuid("two") },
  };
  const initial = { [connectorUuid("one")]: one, [connectorUuid("two")]: two };
  assert.deepEqual(await detail(), initial);

  const initialWrites = web.log.filter(
    ({ op }) => op === "store.conversations.put",
  ).length;
  assert.equal((await change([], session(foreign))).status, 404);
  assert.equal((await change([], session(other))).status, 404);
  assert.equal((await change([], session(archived))).status, 404);
  assert.equal(
    (await change([], session(original), organizationUuid("other"))).status,
    404,
  );
  assert.equal((await change([], session(original), null)).status, 404);
  assert.equal((await change([{ name: "stale name", ...one }])).status, 409);
  assert.equal(
    (
      await change([
        { name: "Connector One", ...one, url: "https://changed.invalid" },
      ])
    ).status,
    409,
  );
  assert.equal(
    (
      await change([
        {
          name: "unknown",
          ...one,
          headers: { "X-MCP-Server-ID": connectorUuid("unknown") },
        },
      ])
    ).status,
    409,
  );
  assert.equal(
    (
      await change([
        {
          name: "disabled",
          type: "http",
          url: connectorConfig.disabled.url,
          headers: { "X-MCP-Server-ID": connectorUuid("disabled") },
        },
      ])
    ).status,
    409,
  );
  assert.equal(
    (
      await change([
        {
          name: "Connector One",
          ...one,
          headers: { ...one.headers, Authorization: "Bearer from-browser" },
        },
      ])
    ).status,
    400,
  );
  assert.equal(
    (
      await change([
        { name: "Connector One", ...one },
        { name: "Connector One", ...one },
      ])
    ).status,
    409,
  );
  assert.equal(
    (await change([{ name: "x".repeat(65536), ...one }])).status,
    413,
  );
  assert.equal(
    web.log.filter(({ op }) => op === "store.conversations.put").length,
    initialWrites,
  );
  assert.deepEqual(await detail(), initial);

  const loaded = ctx.store.conversation(original.id);
  loaded.turns.push({
    id: "working",
    prompt: "working",
    attachments: [],
    items: [],
    createdAt: 1,
    status: "inProgress",
  });
  assert.equal((await change([])).status, 409);
  loaded.turns.pop();
  const onlyTwo = { [connectorUuid("two")]: two };
  pauseWrite = true;
  const pending = change([{ name: connectorUuid("two"), ...two }]);
  await writeStarted.promise;
  const accountToolChange = {
    ...connectorConfig,
    one: { ...connectorConfig.one, disabled_tools: ["lookup"] },
  };
  ctx.store.settings.mcpServers = accountToolChange;
  ctx.store.flush();
  try {
    assert.equal((await change([])).status, 409);
  } finally {
    releaseWrite.resolve();
  }
  const disabled = await pending;
  assert.equal(disabled.status, 200);
  assert.deepEqual((await disabled.json()).mcp_config.mcpServers, onlyTwo);
  assert.deepEqual(await detail(), onlyTwo);
  assert.deepEqual(loaded.connectorOverrides, { one: false, local: false });
  assert.deepEqual(
    loaded.connectorToolOverrides,
    original.connectorToolOverrides,
  );
  assert.deepEqual(ctx.store.settings.mcpServers, accountToolChange);
  const repeat = await change([{ name: connectorUuid("two"), ...two }]);
  assert.equal(repeat.status, 200);
  assert.equal(
    web.log.filter(({ op }) => op === "store.conversations.put").length,
    initialWrites + 1,
  );
  assert.equal(events.length, 1);

  await ctx.store.close();
  ctx.store = await open("after-disable");
  activation = {};
  assert.deepEqual(await detail(), onlyTwo);
  const enabled = await change([
    { name: "Connector One", ...one },
    { name: connectorUuid("two"), ...two },
  ]);
  assert.equal(enabled.status, 200);
  assert.deepEqual((await enabled.json()).mcp_config.mcpServers, initial);
  assert.deepEqual(ctx.store.conversation(original.id).connectorOverrides, {
    local: false,
  });
  assert.deepEqual(
    ctx.store.conversation(original.id).connectorToolOverrides,
    original.connectorToolOverrides,
  );

  web.failNext("store.conversations.put");
  assert.equal((await change([])).status, 409);
  assert.equal(events.length, 2);
  assert.deepEqual(await detail(), initial);
  await ctx.store.close();
  ctx.store = await open("after-failed-save");
  activation = {};
  assert.deepEqual(await detail(), initial);
  assert.deepEqual(ctx.store.conversation(original.id).connectorOverrides, {
    local: false,
  });
  assert.deepEqual(
    ctx.store.conversation(original.id).connectorToolOverrides,
    original.connectorToolOverrides,
  );

  const knowledgeUuid = connectorUuid(HIWONDER_KNOWLEDGE_SERVER);
  const knowledge = {
    type: "http", url: hiwonderKnowledgeRelayUrl(knowledgeService),
    headers: { "X-MCP-Server-ID": knowledgeUuid },
  };
  assert.equal((await change([{ name: knowledgeUuid, ...knowledge }, { name: connectorUuid("two"), ...two }])).status, 200);
  assert.deepEqual(await detail(), { [knowledgeUuid]: knowledge, [connectorUuid("two")]: two });
  knowledgeAvailable = false;
  assert.deepEqual(await detail(), onlyTwo);
  assert.equal((await change([{ name: "Connector One", ...one }])).status, 200);
  assert.equal(ctx.store.conversation(original.id).connectorOverrides?.[HIWONDER_KNOWLEDGE_SERVER], true);
  knowledgeAvailable = true;
  assert.deepEqual(await detail(), { [knowledgeUuid]: knowledge, [connectorUuid("one")]: one });
  assert.equal((await change([{ name: "Connector One", ...one }])).status, 200);
  assert.equal(ctx.store.conversation(original.id).connectorOverrides?.[HIWONDER_KNOWLEDGE_SERVER], false);
});
