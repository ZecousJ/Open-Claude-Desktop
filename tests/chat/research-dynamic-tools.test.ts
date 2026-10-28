/**
 * Research through the engine extension (R45c): what a Research thread and
 * turn get, the research_plan / research_report tools, the report file,
 * source counting from gateway signals, and the reply that stands in for a
 * report the model never submitted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import {
  createResearchExtension,
  ResearchReports,
} from "../../electron/ipc/research";
import {
  parseResearchPlan,
  parseResearchReport,
  researchInstructions,
  researchTools,
} from "../../electron/engine/research-instructions";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { ModelCatalogItem } from "../../shared/model-catalog-api";
import type { AppEvent, Conversation } from "../../shared/types";
import {
  formatResearchElapsed,
  maxResearchReportBytes,
  reportFileName,
  reportHeading,
  researchUnavailable,
  researchConnectorEnabled,
  turnSourceUrls,
} from "../../shared/research";

function setup(
  options: {
    policy?: Partial<ClientPolicy>;
    catalog?: Partial<ModelCatalogItem>;
    conversation?: Partial<Conversation>;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-research-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "conv-1",
    title: "Sidebar density",
    mode: "chat",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread-a",
    webSearch: true,
    research: true,
    cwd: root,
    turns: [
      {
        id: "turn-1",
        prompt: "Research sidebar density",
        attachments: [],
        createdAt: 1000,
        status: "inProgress",
        items: [],
      },
    ],
    ...options.conversation,
  };
  store.conversations = [c];
  const events: AppEvent[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event) => events.push(event),
  );
  const policy = { ...openPolicy, ...options.policy } as ClientPolicy;
  engine.policy = () => policy;
  let clock = 5000;
  const reports = new ResearchReports(root);
  engine.extensions.add(
    createResearchExtension({
      policy: () => policy,
      catalogItem: () =>
        options.catalog
          ? ({ id: "m", ...options.catalog } as ModelCatalogItem)
          : undefined,
      reports,
      push: (event) => events.push(event),
      now: () => clock,
    }),
  );
  const internals = engine as any;
  internals.routes.set("thread-a", c.id);
  const provider = store.settings.providers[0];
  return {
    root,
    store,
    engine,
    internals,
    c,
    events,
    reports,
    provider,
    tick(ms: number) {
      clock += ms;
    },
    threadOptions(conversation = c) {
      return internals.threadOptions(conversation, provider, "m", "chat");
    },
    turnExtras(conversation = c) {
      return internals.turnExtras(
        internals.turnContext(conversation, provider, "m", "chat"),
      );
    },
    call(tool: string, args: unknown, turnId = "turn-1") {
      return engine.extensions.handleDynamicTool({
        conversation: c,
        turn: c.turns.find((turn) => turn.id === turnId),
        threadId: "thread-a",
        turnId,
        callId: `call-${tool}`,
        namespace: null,
        tool,
        arguments: args,
        changed: () => {},
      });
    },
    complete(status: "completed" | "interrupted" | "failed" = "completed") {
      internals.notification({
        method: "turn/completed",
        params: {
          threadId: "thread-a",
          turnId: "turn-1",
          turn: { id: "turn-1", status },
        },
      });
    },
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const planArgs = {
  title: "Sidebar density and tooltips",
  questions: ["What density do desktop apps use?", "  How do tooltips help? "],
};
const reportMarkdown =
  "# Desktop Sidebar Density\n\nIntro.\n\n## TL;DR\n\n- Rows of 28px ([source](https://a.example/)).\n";

test("connector Research runs with its tools and instructions, not forced native web search", () => {
  const env = setup({
    catalog: { webSearch: "none" },
    conversation: { webSearch: false },
  });
  try {
    env.provider.protocol = "chat";
    env.store.settings.mcpServers = { search: { command: "search-server" } };
    assert.doesNotThrow(() =>
      env.engine.extensions.beforeSend(
        env.internals.turnContext(env.c, env.provider, "m", "chat"),
      ),
    );
    const options = env.threadOptions();
    assert.notEqual(options.config.web_search, "live");
    assert.ok(
      options.dynamicTools.some(
        (tool: { name: string }) => tool.name === "research_plan",
      ),
    );
    assert.match(
      env.turnExtras().additionalContext["research.instructions"].value,
      /using the enabled search integrations/,
    );
    assert.equal(
      researchConnectorEnabled(env.store.settings, openPolicy),
      true,
    );
    assert.equal(
      researchConnectorEnabled(env.store.settings, openPolicy, {
        search: false,
      }),
      false,
    );
    env.store.settings.mcpServers.search = {
      command: "search-server",
      enabled_tools: [],
    };
    assert.equal(
      researchConnectorEnabled(env.store.settings, openPolicy),
      false,
    );
  } finally {
    env.close();
  }
});

test("a Research chat gets the tools at thread/start, and web search live", () => {
  const env = setup();
  try {
    const options = env.threadOptions();
    assert.deepEqual(
      options.dynamicTools.map((tool: { name: string }) => tool.name),
      [
        "offer_next_step_v0",
        "suggest_capability",
        "search_connector_directory",
        "research_plan",
        "research_report",
        "research_start_report",
      ],
    );
    assert.equal(options.config.web_search, "live");
    // Instructions go with each turn (they must follow the switch).
    assert.doesNotMatch(options.developerInstructions, /Research mode is on/);
    const extras = env.turnExtras();
    assert.match(
      extras.additionalContext["research.instructions"].value,
      /Research mode is on[\s\S]*at most 30 searches/,
    );
    // The turn now shows as a Research turn that is planning.
    assert.deepEqual(env.c.turns[0].research, {
      state: "starting",
      startedAt: 5000,
      sourceCount: 0,
      searchCount: 0,
    });
  } finally {
    env.close();
  }
});

test("the administrator's search cap reaches the instructions", () => {
  const env = setup({
    policy: {
      research: { enabled: true, xSearch: true, maxSearchesPerTurn: 12 },
    },
  });
  try {
    assert.match(
      env.turnExtras().additionalContext["research.instructions"].value,
      /at most 12 searches/,
    );
  } finally {
    env.close();
  }
});

test("a chat without Research gets only suggestion tools; after Research it is told it is off", () => {
  const env = setup({ conversation: { research: false, webSearch: false } });
  try {
    const options = env.threadOptions();
    assert.deepEqual(
      options.dynamicTools.map((tool: { name: string }) => tool.name),
      [
        "offer_next_step_v0",
        "suggest_capability",
        "search_connector_directory",
      ],
    );
    assert.equal(options.config.web_search, "disabled");
    assert.equal(
      env.turnExtras().additionalContext["research.instructions"],
      undefined,
    );
    assert.equal(env.c.turns[0].research, undefined);
    env.c.turns.unshift({
      id: "old",
      prompt: "p",
      attachments: [],
      createdAt: 0,
      status: "completed",
      items: [],
      research: { state: "done", startedAt: 0, sourceCount: 3 },
    });
    assert.match(
      env.turnExtras().additionalContext["research.instructions"].value,
      /Research mode is off/,
    );
  } finally {
    env.close();
  }
});

test("Research turned off by the administrator lets the chat continue without it", () => {
  const env = setup({
    policy: {
      research: { enabled: false, xSearch: true, maxSearchesPerTurn: 30 },
    },
  });
  try {
    env.engine.extensions.beforeSend(
      env.internals.turnContext(env.c, env.provider, "m", "chat"),
    );
    assert.deepEqual(
      env
        .threadOptions()
        .dynamicTools.map((tool: { name: string }) => tool.name),
      [
        "offer_next_step_v0",
        "suggest_capability",
        "search_connector_directory",
      ],
    );
    assert.equal(
      env.turnExtras().additionalContext["research.instructions"],
      undefined,
    );
    assert.equal(env.c.turns[0].research, undefined);
  } finally {
    env.close();
  }
});

test("a model the catalog says cannot search refuses a Research message", () => {
  const env = setup({ catalog: { webSearch: "none" } });
  try {
    assert.throws(
      () =>
        env.engine.extensions.beforeSend(
          env.internals.turnContext(env.c, env.provider, "m", "chat"),
        ),
      /isn't available for this model\. Turn off Research/,
    );
  } finally {
    env.close();
  }
});

test("a new Chat starts in Research only when asked, and never incognito", () => {
  const env = setup();
  try {
    // send() describes a new conversation to beforeSend before creating it.
    const seen: Conversation[] = [];
    env.engine.extensions.add({
      id: "probe",
      incognito: true,
      beforeSend: (ctx) => {
        seen.push(ctx.conversation as Conversation);
      },
    });
    env.store.settings.providers[0].model = "m";
    const assertExtensions = (input: Record<string, unknown>) =>
      env.internals.assertExtensions(env.provider, {
        text: "hi",
        mode: "chat",
        attachments: [],
        providerId: "default",
        model: "m",
        ...input,
      });
    assertExtensions({ research: true });
    assertExtensions({ research: true, incognito: true });
    assertExtensions({ research: true, mode: "cowork" });
    assertExtensions({});
    assert.deepEqual(
      seen.map((c) => [c.research ?? false, c.webSearch]),
      [
        [true, true],
        [false, false],
        [false, false],
        [false, false],
      ],
    );
  } finally {
    env.close();
  }
});

test("research_plan records the title and questions; the card starts gathering", async () => {
  const env = setup();
  try {
    env.turnExtras();
    const result = await env.call(
      "research_plan",
      JSON.stringify({
        ...planArgs,
        plan: "Compare primary evidence and investigate conflicting findings.",
      }),
    );
    assert.equal(result.success, true);
    const research = env.c.turns[0].research!;
    assert.equal(research.title, "Sidebar density and tooltips");
    assert.deepEqual(research.questions, [
      "What density do desktop apps use?",
      "How do tooltips help?",
    ]);
    assert.equal(research.state, "gathering");
    assert.equal(
      research.plan,
      "Compare primary evidence and investigate conflicting findings.",
    );
    const event = env.events
      .filter((event) => event.type === "research")
      .at(-1);
    assert.equal(
      event?.type === "research" && event.research.state,
      "gathering",
    );
  } finally {
    env.close();
  }
});

test("research_report saves the report as a private file and finishes the research", async () => {
  const env = setup();
  try {
    env.turnExtras();
    env.tick(65_000);
    const result = await env.call("research_report", {
      title: "Desktop Sidebar Density",
      markdown: reportMarkdown,
    });
    assert.equal(result.success, true);
    assert.match(
      result.contentItems[0].type === "inputText"
        ? result.contentItems[0].text
        : "",
      /brief summary/,
    );
    const research = env.c.turns[0].research!;
    assert.equal(research.state, "done");
    assert.equal(research.completedAt, 70_000);
    assert.equal(research.reportSource, "tool");
    assert.deepEqual(research.report, {
      title: "Desktop Sidebar Density",
      path: "research/conv-1/turn-1.md",
      bytes: Buffer.byteLength(reportMarkdown),
    });
    const file = path.join(env.root, "research", "conv-1", "turn-1.md");
    assert.equal(fs.readFileSync(file, "utf8"), reportMarkdown);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(env.reports.read(research.report!.path), reportMarkdown);
    // Completing the turn keeps the submitted report.
    env.c.turns[0].items.push({
      id: "msg",
      type: "agentMessage",
      text: "Short summary.",
    });
    env.complete();
    assert.equal(env.c.turns[0].research!.reportSource, "tool");
    assert.equal(env.c.turns[0].research!.completedAt, 70_000);
  } finally {
    env.close();
  }
});

test("report writing is a published phase before the report is submitted", async () => {
  const env = setup();
  try {
    env.turnExtras();
    const turn = env.c.turns[0];
    assert.equal(turn.research?.state, "starting");
    env.engine.extensions.recordItem(env.c, {
      id: "thought",
      type: "reasoning",
    });
    assert.equal(turn.research?.state, "planning");
    await env.call("research_plan", planArgs);
    const invalid = await env.call("research_start_report", {
      unexpected: true,
    });
    assert.equal(invalid.success, false);
    assert.equal(turn.research?.state, "gathering");
    const result = await env.call("research_start_report", {});
    assert.equal(result.success, true);
    assert.equal(turn.research?.state, "writing");
    assert.equal(turn.research?.writingStartedAt, 5000);
    assert.equal(turn.research?.report, undefined);
    assert.equal(
      env.events.filter((event) => event.type === "research").at(-1)?.type,
      "research",
    );
    assert.ok(
      env.events.some(
        (event) =>
          event.type === "research" && event.research.state === "writing",
      ),
    );
    await env.call("research_report", {
      title: "Report",
      markdown: reportMarkdown,
    });
    assert.equal(turn.research?.state, "done");
    await env.call("research_start_report", {});
    assert.equal(turn.research?.state, "done");
  } finally {
    env.close();
  }
});

test("a final-answer item starts report writing when thread tools are unavailable", () => {
  const env = setup();
  try {
    env.turnExtras();
    env.engine.extensions.recordItem(env.c, {
      id: "reply",
      type: "agentMessage",
      phase: "final_answer",
    });
    assert.equal(env.c.turns[0].research?.state, "writing");
    assert.equal(env.c.turns[0].research?.writingStartedAt, 5000);
    env.complete("interrupted");
    assert.equal(env.c.turns[0].research?.state, "interrupted");
    assert.equal(env.c.turns[0].research?.writingStartedAt, 5000);
  } finally {
    env.close();
  }
});

test("bad arguments, unknown tools and Research turned off are refused, never thrown", async () => {
  const env = setup();
  try {
    env.turnExtras();
    const text = (result: {
      contentItems: { type: string; text?: string }[];
    }) => result.contentItems[0].text ?? "";
    let result = await env.call("research_plan", "{not json");
    assert.equal(result.success, false);
    assert.match(text(result), /JSON object/);
    result = await env.call("research_plan", { title: "t", questions: [] });
    assert.equal(result.success, false);
    result = await env.call("research_plan", {
      title: "t",
      questions: ["q"],
      extra: 1,
    });
    assert.match(text(result), /Unknown argument: extra/);
    result = await env.call("research_report", {
      title: "t",
      markdown: "x".repeat(maxResearchReportBytes + 1),
    });
    assert.equal(result.success, false);
    assert.match(text(result), /larger than 200 KB/);
    result = await env.call("other_tool", {});
    assert.equal(result.success, false);
    assert.match(text(result), /other_tool isn't available/);
    // A thread keeps its tools after Research is turned off.
    env.c.research = false;
    result = await env.call("research_plan", planArgs);
    assert.equal(result.success, false);
    assert.match(text(result), /Research mode is off/);
    assert.equal(env.c.turns[0].research!.title, undefined);
  } finally {
    env.close();
  }
});

test("a call routed by the engine reaches the extension with its turn", async () => {
  const env = setup();
  try {
    env.turnExtras();
    await env.internals.answerDynamicTool(
      {
        id: 7,
        params: {
          threadId: "thread-a",
          turnId: "turn-1",
          callId: "c1",
          tool: "research_plan",
          arguments: planArgs,
        },
      },
      env.c.id,
    );
    assert.equal(env.c.turns[0].research!.title, planArgs.title);
  } finally {
    env.close();
  }
});

test("gateway signals count distinct pages and searches, children included", () => {
  const env = setup();
  try {
    env.turnExtras();
    const search = (callId: string, urls: string[], threadId = "thread-a") =>
      env.internals.signals.webSources({
        kind: "search",
        threadId,
        callId,
        tool: "web_search",
        queries: ["q"],
        sources: urls.map((url) => ({ url })),
        status: "completed",
      });
    search("ws_1", ["https://a.example/", "https://b.example/#part"]);
    search("ws_1", ["https://a.example/"]);
    search("ws_2", ["https://b.example/", "https://c.example/"]);
    const research = env.c.turns[0].research!;
    assert.equal(research.state, "gathering");
    assert.equal(research.searchCount, 2);
    assert.equal(research.sourceCount, 3);
    // xAI's citation list adds pages the searches did not list.
    env.internals.signals.webSources({
      kind: "citations",
      threadId: "thread-a",
      responseId: "r1",
      urls: ["https://d.example/", "https://a.example/"],
    });
    assert.equal(research.sourceCount, 4);
    const progress = env.events.filter((event) => event.type === "research");
    assert.equal(progress.length, 4);
    // A child agent's search counts toward its parent's research.
    env.c.turns[0].items.push({
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      receiverThreadIds: ["child-1"],
    });
    search("ws_3", ["https://e.example/"], "child-1");
    assert.equal(research.sourceCount, 5);
    assert.equal(research.searchCount, 3);
  } finally {
    env.close();
  }
});

test("without research_report the final reply becomes the report", () => {
  const env = setup();
  try {
    env.turnExtras();
    env.c.turns[0].items.push(
      { id: "m1", type: "agentMessage", text: "Looking into it." },
      {
        id: "ws",
        type: "webSearch",
        query: "q",
        sources: [{ url: "https://a.example/" }],
      },
      {
        id: "m2",
        type: "agentMessage",
        text: "Intro line\n\n```\n# not a title\n```\n# Findings on density\n\nBody.",
      },
    );
    env.tick(1000);
    env.complete();
    const research = env.c.turns[0].research!;
    assert.equal(research.state, "done");
    assert.equal(research.reportSource, "reply");
    assert.equal(research.report?.title, "Findings on density");
    assert.equal(research.sourceCount, 1);
    assert.equal(research.completedAt, 6000);
    assert.match(env.reports.read(research.report!.path), /Body\./);
  } finally {
    env.close();
  }
});

test("a stopped or failed Research turn says so and keeps no report", () => {
  for (const status of ["interrupted", "failed"] as const) {
    const env = setup();
    try {
      env.turnExtras();
      env.complete(status);
      const research = env.c.turns[0].research!;
      assert.equal(research.state, status);
      assert.equal(research.report, undefined);
      assert.ok(research.completedAt);
    } finally {
      env.close();
    }
  }
});

test("tool specs, argument parsing and shared helpers", () => {
  const [plan, report] = researchTools();
  assert.equal(plan.type === "function" && plan.name, "research_plan");
  assert.deepEqual(
    (report as { inputSchema: { required: string[] } }).inputSchema.required,
    ["title", "markdown"],
  );
  assert.deepEqual(
    parseResearchPlan({ title: " a\u0000b ", questions: ["x", 1, " "] }),
    {
      title: "a b",
      questions: ["x"],
    },
  );
  assert.equal(
    parseResearchPlan({
      title: "t",
      questions: Array.from({ length: 12 }, (_, i) => `q${i}`),
    }).questions.length,
    8,
  );
  assert.equal(
    parseResearchReport({ title: "t", markdown: "a\r\nb" }).markdown,
    "a\nb",
  );
  assert.throws(() => parseResearchReport({ title: "t", markdown: "  " }));
  assert.match(researchInstructions({ maxSearches: 0 }), /at most 1 searches/);
  assert.equal(formatResearchElapsed(46_900), "46s");
  assert.equal(formatResearchElapsed(178_000), "2m 58s");
  assert.equal(formatResearchElapsed(3_840_000), "1h 4m");
  assert.equal(reportHeading("no heading"), undefined);
  assert.equal(reportHeading("  # Title #\ntext"), "Title");
  assert.equal(reportFileName("a/b:c?"), "a b c.md");
  assert.equal(reportFileName(""), "Research report.md");
  assert.equal(
    turnSourceUrls({
      items: [
        {
          id: "1",
          type: "webSearch",
          sources: [{ url: "https://a.example/#x" }],
        },
        {
          id: "2",
          type: "agentMessage",
          citations: [{ url: "https://a.example/", start: 0, end: 1 }],
          webCitations: ["javascript:alert(1)", "https://b.example/"],
        },
      ],
    }).size,
    2,
  );
  const policy = { webSearch: true } as ClientPolicy;
  const responses = { protocol: "responses" as const };
  assert.equal(
    researchUnavailable({ policy, mode: "chat", provider: responses }),
    undefined,
  );
  assert.equal(
    researchUnavailable({
      policy: { ...policy, webSearch: false },
      mode: "chat",
      provider: responses,
    }),
    "policy",
  );
  assert.equal(
    researchUnavailable({ policy, mode: "cowork", provider: responses }),
    "mode",
  );
  assert.equal(
    researchUnavailable({
      policy,
      mode: "chat",
      incognito: true,
      provider: responses,
    }),
    "incognito",
  );
  assert.equal(
    researchUnavailable({
      policy,
      mode: "chat",
      provider: { protocol: "chat" },
    }),
    "service",
  );
  assert.equal(
    researchUnavailable({
      policy,
      mode: "chat",
      provider: responses,
      catalogItem: { webSearch: "none" },
    }),
    "model",
  );
});
