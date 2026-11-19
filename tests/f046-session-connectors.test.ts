import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionConnectors } from "../electron/official-ui/native/session-connectors";
import {
  connectorUuid,
  permissionKeys,
} from "../electron/official-ui/api/connectors";
import { sessionConnectorPreferenceSnapshot } from "../shared/session-connector-preference";
import type { Conversation } from "../shared/types";
import type { McpServerState } from "../shared/settings-desktop-api";

const server = {
  name: "wiki",
  url: "https://example.test/mcp",
  state: "ready",
  toolList: [
    {
      name: "search",
      enabled: true,
      approval: "prompt",
      definition: { name: "search" },
    },
  ],
} as McpServerState;
const key = permissionKeys(server, server.toolList![0]).enabled;
const row = (enabled: boolean) => [{ uuid: connectorUuid("wiki"), enabled }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let conversation = {
    id: "one",
    turns: [],
    connectorOverrides: {},
    connectorToolOverrides: {},
  } as unknown as Conversation;
  let identity = { owner: "account-a" };
  let url = server.url;
  let policy: Record<string, unknown> = {};
  let writes = 0;
  let catalogHook = async () => {};
  let writeHook = async () => {};
  let getHook = async () => {};
  let ignoreWrite = false;
  const ctx = {
    settings: () => ({ mcpServers: { wiki: { url, ...policy } } }),
    sessionIdentity: () => identity,
  };
  const api = sessionConnectors(
    async () => {
      await getHook();
      return structuredClone(conversation);
    },
    async (name, ...args) => {
      if (name === "mcpServers") {
        await catalogHook();
        return { servers: [server] };
      }
      assert.equal(name, "updateConversation");
      writes++;
      await writeHook();
      const patch = args[1] as any;
      assert.deepEqual(Object.keys(patch), ["connectorToolOverrides"]);
      const envelope = patch.connectorToolOverrides;
      assert.equal(envelope.version, 1);
      assert.deepEqual(envelope.identity, {
        id: conversation.id,
        createdAt: conversation.createdAt ?? null,
        mode: conversation.mode ?? null,
      });
      if (
        envelope.expected !== sessionConnectorPreferenceSnapshot(conversation)
      )
        throw Error("Preference snapshot changed");
      if (!ignoreWrite) conversation = { ...conversation, ...envelope.value };
      return structuredClone(conversation);
    },
    ctx as never,
  );
  return {
    api,
    get c() {
      return conversation;
    },
    set c(value) {
      conversation = value;
    },
    get writes() {
      return writes;
    },
    set identity(value: string) {
      identity = { owner: value };
    },
    set policy(value: Record<string, unknown>) {
      policy = value;
    },
    set url(value: string | undefined) {
      url = value;
    },
    set catalogHook(value: () => Promise<void>) {
      catalogHook = value;
    },
    set getHook(value: () => Promise<void>) {
      getHook = value;
    },
    set writeHook(value: () => Promise<void>) {
      writeHook = value;
    },
    set ignoreWrite(value: boolean) {
      ignoreWrite = value;
    },
  };
}

test("F046 cold hydration restores connector disable using actual tool catalog", async () => {
  const f = fixture();
  f.c.connectorOverrides = { wiki: false };
  assert.equal((await f.api.getEnabledMcpTools("one"))[key], false);
});

test("Code history projects saved denials and warm tool metadata without discovery", async () => {
  const f = fixture();
  f.c.connectorToolOverrides = {
    wiki: { search: false },
    retired: { search: false },
  };
  assert.deepEqual(f.api.cachedEnabledMcpTools(f.c), { [key]: false });

  // Actual connector synchronization learns the schema and the cached
  // history view can now use the same permission fingerprint.
  const discovered = await f.api.getEnabledMcpTools("one");
  f.catalogHook = async () => {
    throw Error("Opening history must not discover connectors");
  };
  assert.deepEqual(f.api.cachedEnabledMcpTools(f.c), discovered);
  f.c.connectorToolOverrides = {};
  f.c.connectorOverrides = { wiki: false };
  assert.equal(f.api.cachedEnabledMcpTools(f.c)[key], false);

  f.url = "https://example.test/replacement";
  assert.deepEqual(f.api.cachedEnabledMcpTools(f.c), {});
  f.url = server.url;
  f.catalogHook = async () => {};
  await f.api.getEnabledMcpTools("one");
  assert.equal(f.api.cachedEnabledMcpTools(f.c)[key], false);

  f.identity = "account-b";
  assert.deepEqual(f.api.cachedEnabledMcpTools(f.c), {});
  assert.equal(f.writes, 0);
});

test("F046 catalog wait uses latest preferences and turn status", async () => {
  const f = fixture();
  f.catalogHook = async () => {
    f.c.connectorOverrides = { wiki: false };
  };
  assert.equal((await f.api.getEnabledMcpTools("one"))[key], false);
  f.catalogHook = async () => {
    f.c.turns = [{ status: "inProgress" }] as Conversation["turns"];
  };
  await assert.rejects(
    f.api.setMcpServers("one", row(true)),
    /while message is processing/,
  );
  assert.equal(f.writes, 0);
});

test("F046 catalog account and configuration races reject without writing", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.identity = "account-b";
    },
    (f: ReturnType<typeof fixture>) => {
      f.url = "https://changed.test/mcp";
    },
  ]) {
    const f = fixture();
    f.catalogHook = async () => {
      change(f);
    };
    await assert.rejects(
      f.api.setMcpServers("one", row(false)),
      /configuration or account changed/,
    );
    assert.equal(f.writes, 0);
  }
});

test("F046 preserves orphan preferences across known connector changes", async () => {
  const f = fixture();
  f.c.connectorOverrides = { removed: false };
  f.c.connectorToolOverrides = {
    removed: { oldTool: false },
    wiki: { oldTool: false },
  };
  await f.api.setMcpServers("one", row(false));
  assert.deepEqual(f.c.connectorOverrides, { removed: false, wiki: false });
  assert.deepEqual(f.c.connectorToolOverrides, {
    removed: { oldTool: false },
    wiki: { oldTool: false },
  });
  await assert.rejects(
    f.api.setMcpServers("one", [
      { uuid: connectorUuid("removed"), enabled: true },
    ]),
    /connector list changed/,
  );
});

test("F046 refuses stale guarded writes and false success from ignored updates", async () => {
  const f = fixture();
  f.writeHook = async () => {
    f.c.connectorToolOverrides = { wiki: { search: false } };
  };
  await assert.rejects(
    f.api.setMcpServers("one", row(false)),
    /snapshot changed/,
  );
  assert.deepEqual(f.c.connectorOverrides, {});
  const ignored = fixture();
  ignored.ignoreWrite = true;
  await assert.rejects(
    ignored.api.setMcpServers("one", row(false)),
    /choices were not saved/,
  );
});

test("F046 queued mutations serialize and merge latest state", async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  f.writeHook = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = f.api.setMcpServers("one", row(false));
  await entered.promise;
  const second = f.api.setMcpServers("one", row(true));
  assert.equal(f.writes, 1);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.writes, 2);
  assert.equal(f.c.connectorOverrides!.wiki, true);
});

test("F046 queued mutation cannot migrate to a different account", async () => {
  const f = fixture();
  const entered = deferred(),
    release = deferred();
  f.catalogHook = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = f.api.setMcpServers("one", row(false));
  await entered.promise;
  const second = f.api.setMcpServers("one", row(true));
  const rejected = [
    assert.rejects(first, /configuration or account changed/),
    assert.rejects(second, /configuration or account changed/),
  ];
  f.identity = "account-b";
  release.resolve();
  await Promise.all(rejected);
  assert.equal(f.writes, 0);
});

test("F046 account changes during save cannot report success", async () => {
  const f = fixture();
  f.writeHook = async () => {
    f.identity = "account-b";
  };
  await assert.rejects(
    f.api.setMcpServers("one", row(false)),
    /configuration or account changed/,
  );
});

test("F046 rechecks context after the post-catalog conversation read", async () => {
  const f = fixture();
  let reads = 0;
  f.getHook = async () => {
    if (++reads === 2) f.identity = "account-b";
  };
  await assert.rejects(
    f.api.setMcpServers("one", row(false)),
    /configuration or account changed/,
  );
  assert.equal(f.writes, 0);
});

test("F046 null and obsolete false tool choices cannot create grants or erase orphans", async () => {
  const f = fixture();
  f.c.connectorToolOverrides = { removed: { old: false } };
  await f.api.replaceEnabledMcpTools("one", {
    tools: { [key]: null, "obsolete:tool": false },
  });
  assert.equal(f.writes, 0);
  assert.deepEqual(f.c.connectorToolOverrides, { removed: { old: false } });
  await assert.rejects(
    f.api.replaceEnabledMcpTools("one", { tools: { "obsolete:tool": true } }),
    /no longer available/,
  );
});

test("F046 rejects conversation replacement during catalog discovery", async () => {
  const f = fixture();
  f.c.createdAt = 1;
  f.catalogHook = async () => {
    f.c = { ...f.c, createdAt: 2 };
  };
  await assert.rejects(
    f.api.setMcpServers("one", row(false)),
    /session changed/,
  );
  assert.equal(f.writes, 0);
});

test("policy drift suppresses an in-flight snapshot and explicit enable persists", async () => {
  const f = fixture();
  f.c.connectorOverrides = { wiki: false };
  f.c.connectorToolOverrides = { wiki: { search: false } };
  f.policy = { disabled_tools: ["search"] };
  const entered = deferred(),
    release = deferred();
  let first = true;
  f.catalogHook = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
  };
  const snapshot = f.api.replaceEnabledMcpTools("one", {
    tools: { [key]: false },
  });
  await entered.promise;
  const enable = f.api.setMcpServers("one", [
    { ...row(true)[0], toolKeys: [key] },
  ]);
  f.policy = { tools: { search: { approval_mode: "prompt" } } };
  release.resolve();
  await Promise.all([snapshot, enable]);
  assert.deepEqual(f.c.connectorOverrides, { wiki: true });
  assert.deepEqual(f.c.connectorToolOverrides, { wiki: { search: true } });
  assert.equal(f.writes, 1);
  await f.api.replaceEnabledMcpTools("one", { tools: { [key]: false } });
  assert.equal(f.c.connectorToolOverrides!.wiki.search, true);
  assert.equal(f.writes, 1);
});

test("first explicit true is durable and stale snapshots cannot undo it", async () => {
  const f = fixture();
  const enable = [{ ...row(true)[0], toolKeys: [key] }];
  await f.api.setMcpServers("one", enable);
  await f.api.setMcpServers("one", enable);
  await f.api.replaceEnabledMcpTools("one", { tools: { [key]: false } });
  assert.deepEqual(f.c.connectorOverrides, { wiki: true });
  assert.deepEqual(f.c.connectorToolOverrides, { wiki: { search: true } });
  assert.equal(f.writes, 1);
});

test("current snapshots seed false choices and empty lists disable", async () => {
  const f = fixture();
  await f.api.replaceEnabledMcpTools("one", { tools: { [key]: false } });
  assert.equal(f.c.connectorToolOverrides!.wiki.search, false);
  await f.api.replaceRemoteMcpServers("one", []);
  assert.equal(f.c.connectorOverrides!.wiki, false);
});

test("snapshot preserves a concurrent preference edit", async () => {
  const f = fixture();
  f.catalogHook = async () => {
    f.c.connectorOverrides = { wiki: true };
  };
  await f.api.replaceEnabledMcpTools("one", { tools: { [key]: false } });
  assert.deepEqual(f.c.connectorOverrides, { wiki: true });
  assert.deepEqual(f.c.connectorToolOverrides, {});
  assert.equal(f.writes, 0);
});

test("acknowledged projection uses current account policy", async () => {
  const f = fixture();
  f.writeHook = async () => {
    f.policy = { disabled_tools: ["search"] };
  };
  const result = await f.api.setMcpServers("one", [
    { ...row(true)[0], toolKeys: [key] },
  ]);
  assert.equal(result.enabledMcpTools[key], false);
  assert.equal(f.c.connectorToolOverrides!.wiki.search, true);
  f.policy = {};
  assert.equal((await f.api.getEnabledMcpTools("one"))[key], true);
});

test("credential changes reject during discovery", async () => {
  const f = fixture();
  f.policy = { headers: { Authorization: "first" } };
  f.catalogHook = async () => {
    f.policy = { headers: { Authorization: "second" } };
  };
  await assert.rejects(
    f.api.setMcpServers("one", row(false)),
    /configuration or account changed/,
  );
  assert.equal(f.writes, 0);
});
