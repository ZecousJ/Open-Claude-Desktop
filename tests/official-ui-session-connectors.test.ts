import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveSessionConnectorPreference } from "../electron/ipc/session-connector-preference";
import {
  sessionConnectors,
  initialSessionConnectors,
} from "../electron/official-ui/native/session-connectors";
import {
  connectorUuid,
  permissionKeys,
} from "../electron/official-ui/api/connectors";
import { Store } from "../electron/store/store";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH } from "../shared/knowledge-api";
import type { Conversation } from "../shared/types";
import type { McpServerState } from "../shared/settings-desktop-api";

test("native Code and Cowork keep the offered knowledge choice in the opening and reopened session", async () => {
  const service = "https://service.test";
  const choice = { [HIWONDER_KNOWLEDGE_SERVER]: true };
  const url = `${service}/v1/claudex/knowledge/${HUANER_TECH}/mcp`;
  const row = { uuid: connectorUuid(HIWONDER_KNOWLEDGE_SERVER), type: "remote", url };
  const tools = { [row.uuid + ":rag_search"]: true, [row.uuid + ":rag_read"]: true };
  const ctx = {
    settings: () => ({ mcpServers: {} }),
    knowledgeOffer: async () => ({
      baseUrl: service,
      bases: [{ id: HUANER_TECH, name: "Hiwonder Knowledge", description: "Manuals", available: true }],
    }),
  } as never;
  const discovery = async () => ({ servers: [] });
  assert.deepEqual((await initialSessionConnectors(ctx, discovery, { remoteMcpServers: [row] })).connectorOverrides, {});
  assert.deepEqual((await initialSessionConnectors(ctx, discovery, { remoteMcpServers: [row], enabledMcpTools: tools })).connectorOverrides, choice);
  for (const mode of ["code", "cowork"] as const) {
    let c = {
      id: mode, mode, knowledgeBases: [HUANER_TECH], turns: [], connectorOverrides: {},
    } as unknown as Conversation;
    const methods = sessionConnectors(async () => c, async (method, ...args) => {
      if (method === "mcpServers") return discovery();
      assert.equal(method, "updateConversation");
      const { value } = (args[1] as { connectorToolOverrides: { value: Partial<Conversation> } }).connectorToolOverrides;
      c = { ...c, ...value };
      return c;
    }, ctx);
    assert.equal(methods.cachedEnabledMcpTools(c)[row.uuid + ":rag_search"], true);
    await methods.setMcpServers(mode, [{ ...row, enabled: false, toolKeys: Object.keys(tools) }]);
    assert.deepEqual(c.connectorOverrides, { [HIWONDER_KNOWLEDGE_SERVER]: false });
    await methods.replaceRemoteMcpServers(mode, [row]);
    assert.equal(methods.cachedEnabledMcpTools(c)[row.uuid + ":rag_search"], false);
    await methods.setMcpServers(mode, [{ ...row, enabled: true, toolKeys: Object.keys(tools) }]);
    assert.equal(methods.cachedEnabledMcpTools(c)[row.uuid + ":rag_read"], true);
  }
});

test("a clean Code homepage can start with disabled built-in tool preferences before MCP discovery", async () => {
  const ctx = { settings: () => ({ mcpServers: {} }) };
  const call = async () => { throw Error("MCP discovery is not running"); };
  const snapshot = {
    remoteMcpServers: [],
    enabledMcpTools: {
      "local:mcp-registry:search_mcp_registry": false,
      "local:mcp-registry:suggest_connectors": false,
    },
  };
  assert.deepEqual(await initialSessionConnectors(ctx as never, call, snapshot), {});
});

test("homepage connector snapshots are validated before the first turn without installing renderer definitions", async () => {
  const server = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    toolList: [
      {
        name: "lookup",
        description: "Lookup",
        enabled: true,
        approval: "prompt",
      },
    ],
  } as McpServerState;
  const ctx = {
    settings: () => ({ mcpServers: { wiki: { url: server.url } } }),
  };
  const calls: string[] = [];
  const call = async (method: string) => {
    calls.push(method);
    assert.equal(method, "mcpServers");
    return { servers: [server] };
  };
  const row = {
    uuid: connectorUuid(server.name),
    url: server.url,
    tools: [{ name: "lookup" }],
  };
  const key = permissionKeys(server, server.toolList![0]);
  const selected = await initialSessionConnectors(ctx as never, call, {
    remoteMcpServers: [row],
    enabledMcpTools: { [key.enabled]: false },
  });
  assert.deepEqual(selected, {
    connectorOverrides: {},
    connectorToolOverrides: { wiki: { lookup: false } },
  });
  assert.deepEqual(
    (
      await initialSessionConnectors(ctx as never, call, {
        remoteMcpServers: [],
      })
    ).connectorOverrides,
    { wiki: false },
  );
  await assert.rejects(
    initialSessionConnectors(ctx as never, call, {
      remoteMcpServers: [{ ...row, url: "https://forged.test/mcp" }],
    }),
    /connector list changed/,
  );
  await assert.rejects(
    initialSessionConnectors(ctx as never, call, {
      remoteMcpServers: [{ ...row, tools: [{ name: "forged" }] }],
    }),
    /no longer available/,
  );
  await assert.rejects(
    initialSessionConnectors(ctx as never, call, {
      enabledMcpTools: { [key.approved]: true },
    }),
    /approval changes/,
  );
  assert.ok(calls.length > 0);
});

test("local session connector snapshots persist only session choices and cannot install a URL or lift account policy", async () => {
  const server = {
    name: "wiki",
    displayName: "Wiki",
    url: "https://example.test/mcp",
    state: "ready",
    toolList: [
      {
        name: "search",
        description: "Search",
        enabled: true,
        approval: "prompt",
      },
      { name: "write", enabled: false, approval: "prompt" },
    ],
  } as McpServerState;
  let c = {
    id: "one",
    title: "One",
    mode: "cowork",
    turns: [],
    connectorOverrides: {},
    connectorToolOverrides: {},
  } as unknown as Conversation;
  const calls: string[] = [];
  const methods = sessionConnectors(
    async (id) => (id === "local_one" ? structuredClone(c) : undefined),
    async (method, ...args) => {
      if (method === "mcpServers") return { servers: [server] };
      assert.equal(method, "updateConversation");
      calls.push(method);
      assert.equal(args[0], c.id);
      c = { ...c, ...(args[1] as any).connectorToolOverrides.value };
      return structuredClone(c);
    },
  );
  const keys = permissionKeys(server, server.toolList![0]);
  const blocked = permissionKeys(server, server.toolList![1]);
  const snapshot = [
    {
      uuid: connectorUuid(server.name),
      name: server.displayName,
      url: server.url,
      tools: [{ name: "search" }, { name: "write" }],
    },
  ];
  assert.equal(
    (await methods.replaceRemoteMcpServers("local_one", snapshot))
      .enabledMcpTools[keys.enabled],
    true,
  );
  assert.equal(
    calls.length,
    0,
    "unchanged automatic sync must not change a running engine",
  );
  await methods.replaceEnabledMcpTools("local_one", {
    tools: { [keys.enabled]: false },
  });
  assert.equal(c.connectorToolOverrides!.wiki.search, false);
  const updated = await methods.replaceEnabledMcpTools("local_one", {
    tools: { [blocked.enabled]: true },
  });
  assert.equal(
    updated.enabledMcpTools[blocked.enabled],
    false,
    "session choices cannot lift account blocks",
  );
  await assert.rejects(
    methods.replaceRemoteMcpServers("local_one", [
      { ...snapshot[0], url: "https://another.test/mcp" },
    ]),
    /connector list changed/,
  );
  await assert.rejects(
    methods.replaceRemoteMcpServers("local_one", [
      { ...snapshot[0], tools: [{ name: "other-tool" }] },
    ]),
    /no longer available/,
  );
  await assert.rejects(
    methods.replaceEnabledMcpTools("local_one", {
      tools: { [keys.approved]: true },
    }),
    /approval changes/,
  );
  await assert.rejects(
    methods.replaceEnabledMcpTools("local_one", {
      tools: { "other-account:search": true },
    }),
    /no longer available/,
  );
  const disabled = await methods.replaceRemoteMcpServers("local_one", []);
  assert.equal(c.connectorOverrides!.wiki, false);
  assert.equal(disabled.enabledMcpTools[keys.enabled], false);
  assert.equal(
    (await methods.getEnabledMcpTools("local_one"))[keys.enabled],
    false,
    "session detail hydration must restore the persisted disabled choice",
  );
  await methods.replaceRemoteMcpServers("local_one", snapshot);
  assert.equal(
    c.connectorOverrides!.wiki,
    false,
    "background catalog refresh must retain a session's off choice",
  );
  const enabled = await methods.setMcpServers("local_one", [
    { ...snapshot[0], type: "remote", enabled: true, toolKeys: [keys.enabled] },
  ]);
  assert.equal(enabled.enabledMcpTools[keys.enabled], true);
  await methods.setMcpServers("local_one", [
    {
      ...snapshot[0],
      type: "remote",
      enabled: false,
      toolKeys: [keys.enabled],
    },
  ]);
  await methods.replaceRemoteMcpServers("local_one", snapshot);
  const afterRemount = await methods.replaceEnabledMcpTools("local_one", {
    tools: { [keys.enabled]: true },
  });
  assert.equal(
    afterRemount.enabledMcpTools[keys.enabled],
    false,
    "account defaults cannot re-enable a session after remount",
  );
  await assert.rejects(
    methods.setMcpServers("local_one", [
      { ...snapshot[0], enabled: true, toolKeys: [keys.approved] },
    ]),
    /no longer available/,
  );
  await assert.rejects(
    methods.setMcpServers("local_one", [
      { ...snapshot[0], enabled: true, url: "https://forged.test/mcp" },
    ]),
    /connector list changed/,
  );
  await assert.rejects(
    methods.replaceRemoteMcpServers("another-account", []),
    /Session not found/,
  );
});

test("an unchanged connector sync is allowed during a turn; actual changes wait until it ends", async () => {
  const server = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    toolList: [{ name: "search", enabled: true }],
  } as McpServerState;
  const c = {
    id: "one",
    mode: "code",
    turns: [{ status: "inProgress" }],
  } as Conversation;
  let writes = 0;
  const methods = sessionConnectors(
    async () => c,
    async (method) => {
      if (method === "mcpServers") return { servers: [server] };
      writes++;
      throw Error("Must not write during a turn");
    },
  );
  const keys = permissionKeys(server, server.toolList![0]);
  await methods.replaceRemoteMcpServers("local_one", [
    { uuid: connectorUuid(server.name), tools: [{ name: "search" }] },
  ]);
  await methods.replaceEnabledMcpTools("local_one", {
    tools: { [keys.enabled]: true },
  });
  await assert.rejects(
    methods.replaceEnabledMcpTools("local_one", {
      tools: { [keys.enabled]: false },
    }),
    /while message is processing/,
  );
  await assert.rejects(
    methods.replaceRemoteMcpServers("local_one", []),
    /while message is processing/,
  );
  await assert.rejects(
    methods.setMcpServers("local_one", [
      { uuid: connectorUuid(server.name), enabled: false },
    ]),
    /while message is processing/,
  );
  assert.equal(writes, 0);
});

test("the Code menu saves its session choice across the companion account tool settings write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "claudex-code-connectors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const tool = { name: "search", description: "Search", enabled: true };
  const server = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    tools: 1,
    toolList: [tool],
  } satisfies McpServerState;
  const id = "local_one";
  store.conversations.push({
    id,
    mode: "code",
    title: "One",
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  });
  const account = { id: "account-a", email: "a@example.test", name: "A" };
  const updatePolicy = (blocked: boolean) => {
    store.settings.mcpServers = {
      wiki: {
        url: server.url,
        ...(blocked
          ? { disabled_tools: [tool.name] }
          : { tools: { [tool.name]: { approval_mode: "approve" } } }),
      },
    };
  };
  updatePolicy(false);
  let duringDiscovery = () => updatePolicy(true);
  let afterSave = () => {};
  const methods = sessionConnectors(
    async (id) => store.conversations.find((row) => row.id === id),
    async (method, ...args) => {
      if (method === "mcpServers") {
        duringDiscovery();
        return { servers: [server] };
      }
      assert.equal(method, "updateConversation");
      assert.equal(args[0], id);
      const saved = await saveSessionConnectorPreference(
        { store, activeAccount: account, accountGeneration: () => store },
        id,
        args[1],
      );
      afterSave();
      return saved;
    },
    {
      root,
      account: () => account,
      settings: () => store.settings,
      sessionIdentity: () => store,
      listConversations: async () => store.conversations,
      loadConversation: async (id) => store.conversation(id),
      onEvent: () => () => {},
      call: async () => {},
      modelCatalog: async () => null,
      snapshot: async () => {
        throw Error("The connector menu does not read the global snapshot.");
      },
      appVersion: "fixture",
      log: () => {},
    },
  );
  const keys = permissionKeys(server, tool);
  const change = (enabled: boolean) =>
    methods.setMcpServers(id, [
      {
        uuid: connectorUuid(server.name),
        type: "remote",
        url: server.url,
        enabled,
        toolKeys: [keys.enabled],
      },
    ]);
  const persisted = () => new Store(root).conversation(id);

  assert.equal((await change(false)).enabledMcpTools[keys.enabled], false);
  assert.deepEqual(persisted().connectorOverrides, { wiki: false });
  assert.deepEqual(persisted().connectorToolOverrides, {
    wiki: { search: false },
  });
  duringDiscovery = () => {};
  updatePolicy(false);
  assert.equal((await methods.getEnabledMcpTools(id))[keys.enabled], false);

  afterSave = () => updatePolicy(true);
  const enabled = await change(true);
  assert.equal(enabled.enabledMcpTools[keys.enabled], false);
  assert.equal(enabled.enabledMcpTools[keys.approved], false);
  assert.deepEqual(persisted().connectorOverrides, { wiki: true });
  assert.deepEqual(persisted().connectorToolOverrides, {
    wiki: { search: true },
  });
  updatePolicy(false);
  assert.equal((await methods.getEnabledMcpTools(id))[keys.enabled], true);

  duringDiscovery = () => {
    store.settings.mcpServers = { wiki: { url: "https://replacement.example.test/mcp" } };
  };
  await assert.rejects(change(false), /configuration or account changed/);
  assert.deepEqual(persisted().connectorOverrides, { wiki: true });
});
