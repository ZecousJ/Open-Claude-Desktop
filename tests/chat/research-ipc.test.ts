/**
 * The Research switch and reports over IPC (R45c): who may turn Research
 * on, what turning it on changes, reading a report only from the account's
 * reports folder, and the account lifecycle (extension, catalog binding,
 * stale turns, orphaned reports).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { EngineExtensions } from "../../electron/engine/engine-extensions";
import { ResearchReports } from "../../electron/ipc/research";
import {
  registerResearchHandlers,
  settleResearchTurns,
} from "../../electron/ipc/research-handlers";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { ModelCatalogItem } from "../../shared/model-catalog-api";
import type { AppContext } from "../../electron/app/app-context";
import type { AppEvent, Conversation } from "../../shared/types";

function chat(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c-1",
    title: "Density",
    mode: "chat",
    providerId: "claudex",
    model: "grok-4",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...overrides,
  };
}

function setup(
  options: {
    conversations?: Conversation[];
    policy?: Partial<ClientPolicy>;
    catalog?: Partial<ModelCatalogItem>[];
    protocol?: "responses" | "chat";
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-research-ipc-"));
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "claudex",
      name: "Claudex",
      baseUrl: "https://service.example/v1",
      protocol: options.protocol ?? "responses",
      backend: "sub2api",
      model: "grok-4",
      models: ["grok-4", "gpt-5"],
    } as any,
  ];
  store.conversations = options.conversations ?? [chat()];
  const events: AppEvent[] = [];
  let stops = 0;
  let noActiveCalls = 0;
  const engine = {
    extensions: new EngineExtensions(),
    searchCapabilities: (() => undefined) as any,
    stop: async () => {
      stops++;
    },
  };
  let deactivate: (() => void) | undefined;
  const policy = { ...openPolicy, ...options.policy } as ClientPolicy;
  const catalog = {
    defaultModel: null,
    items: (options.catalog ?? []).map((item) => ({
      id: "grok-4",
      ...item,
    })) as ModelCatalogItem[],
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const ctx = {
    store,
    engine,
    engineFor: () => engine,
    remote: { modelCatalog: () => catalog },
    policy: () => policy,
    push: (event: AppEvent) => events.push(event),
    noActive: () => {
      noActiveCalls++;
    },
    callerWindow: () => undefined,
    onAccountActivated: (cb: () => void) => {
      cb();
      return () => {};
    },
    onAccountDeactivating: (cb: () => void) => {
      deactivate = cb;
      return () => {};
    },
  } as unknown as AppContext;
  registerResearchHandlers((name, fn) => handlers.set(name, fn), ctx);
  return {
    root,
    store,
    engine,
    events,
    get stops() {
      return stops;
    },
    get noActiveCalls() {
      return noActiveCalls;
    },
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
    deactivate: () => deactivate?.(),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("turning Research on brings web search with it and reloads the agent once", async () => {
  const env = setup();
  try {
    const updated = await env.call("setConversationResearch", "c-1", true);
    assert.equal(updated.research, true);
    assert.equal(updated.webSearch, true);
    assert.equal(env.stops, 1);
    assert.equal(env.noActiveCalls, 1);
    assert.equal(env.store.conversations[0].research, true);
    const pushed = env.events.find((event) => event.type === "conversation");
    assert.equal(
      pushed?.type === "conversation" && pushed.conversation.research,
      true,
    );
    // Again: nothing changes.
    await env.call("setConversationResearch", "c-1", true);
    assert.equal(env.stops, 1);
    // Off keeps web search on and needs no reload.
    const off = await env.call("setConversationResearch", "c-1", false);
    assert.equal(off.research, undefined);
    assert.equal(off.webSearch, true);
    assert.equal(env.stops, 1);
    // On again with web search already on: no reload either.
    await env.call("setConversationResearch", "c-1", true);
    assert.equal(env.stops, 1);
  } finally {
    env.close();
  }
});

test("an enabled search integration supports Research without native web search", async () => {
  const env = setup({ protocol: "chat", catalog: [{ webSearch: "none" }] });
  try {
    env.store.settings.mcpServers = { search: { command: "search-server" } };
    const updated = await env.call("setConversationResearch", "c-1", true);
    assert.equal(updated.research, true);
    assert.equal(updated.webSearch, undefined);
    assert.equal(env.stops, 0);
    await env.call("setConversationResearch", "c-1", false);
    env.store.conversations[0].connectorOverrides = { search: false };
    await assert.rejects(
      env.call("setConversationResearch", "c-1", true),
      /Responses-compatible/,
    );
  } finally {
    env.close();
  }
});

test("Research is refused where it can't run", async () => {
  const cases: [Parameters<typeof setup>[0], RegExp][] = [
    [{ policy: { webSearch: false } }, /administrator has turned off Research/],
    [
      {
        policy: {
          research: { enabled: false, xSearch: false, maxSearchesPerTurn: 30 },
        },
      },
      /administrator has turned off Research/,
    ],
    [
      { conversations: [chat({ mode: "cowork" })] },
      /Research isn.t available for this session\./,
    ],
    [{ conversations: [chat({ incognito: true })] }, /incognito/],
    [{ protocol: "chat" }, /Responses-compatible/],
    [{ catalog: [{ webSearch: "none" }] }, /isn't available for this model/],
    [
      {
        conversations: [
          chat({
            turns: [
              {
                id: "t",
                prompt: "p",
                attachments: [],
                createdAt: 1,
                status: "inProgress",
                items: [],
              },
            ],
          }),
        ],
      },
      /still running/,
    ],
  ];
  for (const [options, message] of cases) {
    const env = setup(options);
    try {
      await assert.rejects(
        env.call("setConversationResearch", "c-1", true),
        message,
      );
      assert.equal(env.store.conversations[0].research, undefined);
      assert.equal(env.stops, 0);
    } finally {
      env.close();
    }
  }
  const env = setup();
  try {
    await assert.rejects(env.call("setConversationResearch", "c-1", "yes"));
    await assert.rejects(env.call("setConversationResearch", "", true));
    await assert.rejects(
      env.call("setConversationResearch", "missing", true),
      /not found/,
    );
  } finally {
    env.close();
  }
});

test("a report is read only from the account's reports folder", async () => {
  const env = setup();
  try {
    const reports = new ResearchReports(env.root);
    const stored = reports.write("c-1", "turn-1", "# Report\n\nBody");
    const conversation = env.store.conversations[0];
    conversation.turns.push({
      id: "turn-1",
      prompt: "p",
      attachments: [],
      createdAt: 1,
      status: "completed",
      items: [],
      research: {
        state: "done",
        startedAt: 1,
        sourceCount: 2,
        report: { title: "Report", ...stored },
      },
    });
    assert.deepEqual(await env.call("readResearchReport", "c-1", "turn-1"), {
      title: "Report",
      markdown: "# Report\n\nBody",
    });
    await assert.rejects(
      env.call("readResearchReport", "c-1", "other"),
      /isn't available/,
    );
    // A stored path pointing elsewhere is refused.
    fs.writeFileSync(path.join(env.root, "secret.md"), "secret");
    for (const bad of ["../secret.md", "secret.md", "research/../secret.md"]) {
      conversation.turns[0].research!.report!.path = bad;
      await assert.rejects(
        env.call("readResearchReport", "c-1", "turn-1"),
        /isn't available/,
      );
    }
    conversation.turns[0].research!.report!.path = "research/c-1/gone.md";
    await assert.rejects(
      env.call("readResearchReport", "c-1", "turn-1"),
      /no longer available/,
    );
    // A report in a saved branch can still be read.
    conversation.savedBranches = [
      {
        id: "b",
        providerId: "claudex",
        model: "grok-4",
        visited: 0,
        turns: [
          {
            id: "turn-old",
            prompt: "p",
            attachments: [],
            createdAt: 1,
            status: "completed",
            items: [],
            research: {
              state: "done",
              startedAt: 1,
              sourceCount: 0,
              report: { title: "Old", ...stored },
            },
          },
        ],
      },
    ];
    assert.equal(
      (await env.call("readResearchReport", "c-1", "turn-old")).title,
      "Old",
    );
  } finally {
    env.close();
  }
});

test("report files are private, named by turn, and never outside the folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-reports-"));
  try {
    const reports = new ResearchReports(root);
    assert.throws(() => reports.write("../x", "t", "r"), /can't keep reports/);
    const odd = reports.write("c-1", "../../evil", "r");
    assert.match(odd.path, /^research\/c-1\/[0-9a-f-]{36}\.md$/);
    const stored = reports.write("c-1", "t-1", "héllo");
    assert.deepEqual(stored, { path: "research/c-1/t-1.md", bytes: 6 });
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(root, "research", "c-1")).mode & 0o777,
        0o700,
      );
      assert.equal(
        fs.statSync(path.join(root, stored.path)).mode & 0o777,
        0o600,
      );
      fs.symlinkSync(
        path.join(root, stored.path),
        path.join(root, "research", "c-1", "link.md"),
      );
      assert.throws(() => reports.read("research/c-1/link.md"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("signing in adds the extension, binds X search to the catalog, settles and tidies", () => {
  const stale = chat({
    id: "c-2",
    turns: [
      {
        id: "t",
        prompt: "p",
        attachments: [],
        createdAt: 1,
        status: "interrupted",
        items: [],
        research: { state: "gathering", startedAt: 5, sourceCount: 4 },
      },
    ],
  });
  const env = setup({
    conversations: [chat(), stale],
    catalog: [
      { id: "grok-4", webSearch: "native", xSearch: true },
      { id: "gpt-5", webSearch: "native", xSearch: false },
    ],
  });
  try {
    // Activation ran in setup; leftover folders go on the next tidy.
    const reports = new ResearchReports(env.root);
    reports.write("deleted-chat", "t", "old");
    reports.write("c-1", "t", "kept");
    assert.equal(env.engine.extensions.has("research"), true);
    assert.deepEqual(env.engine.searchCapabilities("claudex", "grok-4"), {
      xSearch: true,
    });
    assert.deepEqual(env.engine.searchCapabilities("claudex", "gpt-5"), {
      xSearch: false,
    });
    assert.equal(env.engine.searchCapabilities("claudex", "other"), undefined);
    assert.equal(env.engine.searchCapabilities("local", "grok-4"), undefined);
    assert.equal(stale.turns[0].research!.state, "interrupted");
    assert.equal(stale.turns[0].research!.completedAt, 5);
    reports.removeOrphans(new Set(env.store.conversations.map((c) => c.id)));
    assert.equal(
      fs.existsSync(path.join(env.root, "research", "deleted-chat")),
      false,
    );
    assert.equal(fs.existsSync(path.join(env.root, "research", "c-1")), true);
    env.deactivate();
    assert.equal(env.engine.extensions.has("research"), false);
  } finally {
    env.close();
  }
});

test("settling leaves running and finished Research turns alone", () => {
  const turn = (status: any, state: any) => ({
    id: "t",
    prompt: "p",
    attachments: [],
    createdAt: 1,
    status,
    items: [],
    research: { state, startedAt: 1, sourceCount: 0 },
  });
  const conversations = [
    chat({
      turns: [
        turn("inProgress", "gathering"),
        turn("completed", "done"),
        turn("failed", "planning"),
      ],
    }),
  ];
  assert.equal(settleResearchTurns(conversations), true);
  assert.deepEqual(
    conversations[0].turns.map((t) => t.research!.state),
    ["gathering", "done", "failed"],
  );
  assert.equal(settleResearchTurns(conversations), false);
});
