import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../electron/store/store";
import { CloudStore, type StoreTransport } from "../runner/src/cloud-store";
import { splitConversation } from "../shared/web-docs";
import type { Conversation } from "../shared/types";
import type { McpServerState } from "../shared/settings-desktop-api";
import { mcpConnectionIdentity } from "../shared/mcp-connection-identity";
import {
  connectorUuid,
  permissionKeys,
} from "../electron/official-ui/api/connectors";
import { connectorInventory } from "../electron/official-ui/api/connector-inventory";
import { sessionConnectors } from "../electron/official-ui/native/session-connectors";
import { saveSessionConnectorPreference } from "../electron/ipc/session-connector-preference";

const url = "https://example.test/mcp";
const row = (): Conversation => ({
  id: "one",
  title: "One",
  mode: "code",
  createdAt: 1,
  updatedAt: 1,
  providerId: "provider",
  model: "model",
  pinned: false,
  archived: false,
  turns: [],
});
const server = (
  description: string,
  state: McpServerState["state"] = "ready",
): McpServerState => ({
  name: "wiki",
  url,
  state,
  tools: 1,
  toolList: [
    {
      name: "search",
      description,
      enabled: true,
      definition: { name: "search", description },
    },
  ],
});
const original = server("Original schema");
const keys = permissionKeys(original, original.toolList![0]);
const enable = [
  { uuid: connectorUuid("wiki"), enabled: true, toolKeys: [keys.enabled] },
];
const falseMap = { tools: { [keys.enabled]: false } };
const d = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};
const root = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "f046-native-review-store-"));
const allow = { wiki: { url, tools: { search: { approval_mode: "prompt" } } } };
const blocked = { wiki: { url, disabled_tools: ["search"] } };
function fixture(
  store: Store,
  onSave: (save: () => Promise<Conversation>) => Promise<Conversation>,
  onGet?: () => void,
  discover = () => original,
) {
  store.settings.mcpServers = allow;
  const conversation = store.conversations[0];
  const events: unknown[] = [];
  const ctx = {
    settings: () => store.settings,
    sessionIdentity: () => store,
    account: () => ({ id: "account" }),
  };
  const ipcContext = {
    store,
    accountGeneration: () => 1,
    activeAccount: { id: "account" },
    push: (event: unknown) => events.push(event),
  };
  const adapter = sessionConnectors(
    async () => {
      onGet?.();
      return structuredClone(conversation);
    },
    async (method, ...args) => {
      if (method === "mcpServers") return { servers: [discover()] };
      assert.equal(method, "updateConversation");
      return onSave(() =>
        saveSessionConnectorPreference(
          ipcContext as never,
          conversation.id,
          args[1],
        ),
      );
    },
    ctx as never,
  );
  return { adapter, conversation, ctx, events };
}

test("explicit ACK cannot overwrite a newer catalog definition", async () => {
  const dir = root();
  try {
    const store = new Store(dir);
    store.conversations.push(row());
    const { adapter, conversation, ctx } = fixture(store, async (save) => {
      connectorInventory(ctx as never, [server("New discovery")]);
      return save();
    });
    await adapter.setMcpServers("one", enable);
    const fresh = server("New discovery");
    const freshKey = permissionKeys(fresh, fresh.toolList![0]).approved;
    const projection = adapter.cachedEnabledMcpTools(conversation);
    assert.ok(
      Object.hasOwn(projection, freshKey),
      "acknowledging the session save replaced a newer discovered definition",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("policy drift while local IPC is queued must not save a stale snapshot", async () => {
  const dir = root();
  try {
    const store = new Store(dir);
    store.conversations.push(row());
    const { adapter, conversation, events } = fixture(store, (save) => {
      const pending = save();
      queueMicrotask(() => {
        store.settings.mcpServers = blocked;
      });
      return pending;
    });
    const result = await adapter.replaceEnabledMcpTools("one", falseMap);
    assert.equal(result.enabledMcpTools[keys.enabled], false);
    assert.equal(store.settings.mcpServers, blocked);
    assert.equal(events.length, 0);
    const reopened = new Store(dir);
    store.settings.mcpServers = allow;
    assert.equal(
      (await adapter.getEnabledMcpTools("one"))[keys.enabled],
      true,
      "removing the account block should restore the inherited tool",
    );
    assert.equal(
      reopened.conversations[0]?.connectorToolOverrides?.wiki?.search,
      undefined,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("policy drift during a pending cloud ACK quarantines the unpublished snapshot", async () => {
  const dir = root();
  try {
    const hold = d(),
      entered = d();
    let doc = splitConversation(row()).doc;
    let puts = 0;
    const transport: StoreTransport = {
      async request(op, _userId, body) {
        if (op === "store.settings.get") return { settings: null };
        if (op === "store.projects.list") return { projects: [] };
        if (op === "store.conversations.list")
          return { items: [{ doc, position: 0 }] };
        if (op === "store.turns.list") return { turns: [] };
        if (op === "store.conversations.put") {
          puts++;
          entered.resolve();
          await hold.promise;
          doc = structuredClone((body as { doc: typeof doc }).doc);
        }
        return {};
      },
    };
    const store = await CloudStore.open({
      root: dir,
      userId: 7,
      transport,
      log: () => {},
    });
    const { adapter, conversation, events } = fixture(store, (save) => save());
    const pending = adapter.replaceEnabledMcpTools("one", falseMap);
    await entered.promise;
    assert.equal(conversation.connectorToolOverrides, undefined);
    assert.equal(events.length, 0);
    store.settings.mcpServers = blocked;
    hold.resolve();
    await assert.rejects(pending, /outcome is unknown/);
    assert.equal(conversation.connectorToolOverrides, undefined);
    assert.equal(events.length, 0);
    assert.equal(doc.conversation.connectorToolOverrides?.wiki?.search, false);
    assert.throws(() => store.conversation("one"), /could not be confirmed/);
    await store.sync();
    assert.equal(puts, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identity canonicalizes canonically equivalent nested key order", () => {
  const a = "\u00e9",
    b = "e\u0301";
  const first = { wiki: { url, env: { [a]: "x", [b]: "y" } } };
  const second = { wiki: { url, env: { [b]: "y", [a]: "x" } } };
  assert.deepEqual(first, second);
  assert.equal(mcpConnectionIdentity(first), mcpConnectionIdentity(second));
});

test("fresh get reflects account policy while the second row read is in flight", async () => {
  const dir = root();
  try {
    const store = new Store(dir);
    store.conversations.push(row());
    let reads = 0;
    const { adapter } = fixture(
      store,
      (save) => save(),
      () => {
        if (++reads === 2) store.settings.mcpServers = blocked;
      },
    );
    assert.equal(
      (await adapter.getEnabledMcpTools("one"))[keys.enabled],
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same discovered disabled state reflects current account policy after explicit ACK", async () => {
  const dir = root();
  try {
    const store = new Store(dir);
    store.conversations.push(row());
    let discovered = original;
    const { adapter, conversation } = fixture(
      store,
      async (save) => {
        const saved = await save();
        store.settings.mcpServers = allow;
        return saved;
      },
      undefined,
      () => discovered,
    );
    assert.equal((await adapter.getEnabledMcpTools("one"))[keys.enabled], true);
    store.settings.mcpServers = { wiki: { url, enabled: false } };
    discovered = { ...original, state: "disabled", toolList: [], tools: 0 };
    assert.equal(
      (await adapter.getEnabledMcpTools("one"))[keys.enabled],
      false,
    );
    assert.equal(
      (await adapter.setMcpServers("one", enable)).enabledMcpTools[
        keys.enabled
      ],
      true,
    );
    assert.deepEqual(conversation.connectorOverrides, { wiki: true });
    assert.deepEqual(conversation.connectorToolOverrides, {
      wiki: { search: true },
    });
    assert.equal((await adapter.getEnabledMcpTools("one"))[keys.enabled], true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
