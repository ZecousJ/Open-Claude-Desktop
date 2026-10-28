import test from "node:test";
import assert from "node:assert/strict";
import { capabilityTips } from "../../shared/chat-suggestions";
import {
  capabilityTipKey,
  capabilityTipResult,
  eligibleCapabilityTips,
  inBandCapabilityTip,
  tipAvailability,
} from "../../shared/capability-tips";
import type { Conversation, Turn } from "../../shared/types";
import { CapabilityTipJudge } from "../../electron/engine/capability-tips";
import {
  initialTipRotation,
  tipRotationMs,
} from "../../src/chat-suggestions/tip-rotation";
import { actOnCapabilityTip } from "../../src/chat-suggestions/tip-actions";
import { capabilityTipCopy } from "../../src/chat-suggestions/capability-tip-copy";
import type { AppController } from "../../src/app/AppContext";
import { emptyTipPacing } from "../../shared/chat-suggestions";

const base = (turns: Turn[] = []): Conversation =>
  ({
    id: "conversation",
    mode: "chat",
    turns,
    incognito: false,
  }) as Conversation;

test("capability tip keys stay constrained to the supported feature pool", () => {
  assert.equal(capabilityTipKey("scheduled_tasks"), "scheduled_tasks");
  assert.equal(capabilityTipKey("office_addin"), undefined);
  assert.equal(capabilityTipKey("__proto__"), undefined);
  assert.ok(capabilityTips.includes("chat_history_search"));
});

test("eligibility drops unavailable or context-specific features", () => {
  const result = eligibleCapabilityTips(
    base(),
    { aiArtifacts: true },
    {
      ...tipAvailability(
        { localFolders: false, cloudCowork: false, scheduledTasks: false },
        true,
      ),
      memory: undefined,
    },
  );
  assert.ok(result.includes("skills"));
  assert.ok(result.includes("temporary_chat"));
  assert.ok(!result.includes("cowork"));
  assert.ok(!result.includes("scheduled_tasks"));
  assert.ok(!result.includes("projects"));
});

test("in-band feature results are preferred and read from completed tool calls", () => {
  const turn = {
    id: "turn",
    status: "completed",
    items: [
      {
        id: "tip",
        type: "dynamicToolCall",
        tool: "suggest_capability",
        status: "completed",
        success: true,
        arguments: { feature: "projects" },
        contentItems: [
          {
            type: "inputText",
            text: '{"suggest":true,"feature":"projects","tier":1}',
          },
        ],
      },
    ],
  } as unknown as Turn;
  assert.equal(inBandCapabilityTip(base([turn])), "projects");
  assert.equal(
    inBandCapabilityTip(base([{ ...turn, status: "inProgress" }])),
    undefined,
  );
});

const reply = (): Turn => ({
  id: "reply",
  prompt: "Repeat this every week",
  attachments: [],
  createdAt: 1,
  status: "completed",
  items: [{ id: "answer", type: "agentMessage", text: "A weekly report" }],
});

test("judge writes a typed scheduled tip once per conversation and caps output", async () => {
  const turn = reply();
  const conversation = base([turn]);
  let requests = 0;
  const judge = new CapabilityTipJudge(
    () => async (input, options) => {
      requests++;
      assert.equal(options?.maxOutputTokens, 96);
      assert.match(input.input, /eligible_features/);
      return '{"feature":"scheduled_tasks","tier":2}';
    },
    () => conversation,
    () => ["scheduled_tasks"],
    () => {},
  );
  await judge.afterTurn(conversation, turn);
  assert.deepEqual(turn.capabilityTip, { feature: "scheduled_tasks", tier: 2 });
  await judge.afterTurn(conversation, turn);
  assert.equal(requests, 1);
});

test("judge never checks incognito, failed replies, or an empty eligible pool", async () => {
  const turn = reply();
  const conversation = base([turn]);
  let requests = 0;
  const judge = new CapabilityTipJudge(
    () => async () => {
      requests++;
      return "{}";
    },
    () => conversation,
    () => [],
    () => {},
  );
  await judge.afterTurn(conversation, turn);
  conversation.incognito = true;
  await judge.afterTurn(conversation, turn);
  conversation.incognito = false;
  turn.status = "failed";
  await judge.afterTurn(conversation, turn);
  assert.equal(requests, 0);
});

test("null classifications are capped at three checks and spaced three turns apart", async () => {
  const conversation = base();
  let requests = 0;
  const judge = new CapabilityTipJudge(
    () => async () => {
      requests++;
      return '{"feature":null,"tier":2}';
    },
    () => conversation,
    () => ["scheduled_tasks"],
    () => {},
  );
  for (let index = 0; index < 12; index++) {
    const turn = { ...reply(), id: `turn-${index}` };
    conversation.turns.push(turn);
    await judge.afterTurn(conversation, turn);
    assert.equal(requests, Math.min(3, Math.floor(index / 3) + 1));
  }
});

test("stopped or stale judge completions cannot annotate a reply", async () => {
  const turn = reply();
  const conversation = base([turn]);
  let resolve!: (value: string) => void;
  const judge = new CapabilityTipJudge(
    () => () =>
      new Promise((done) => {
        resolve = done;
      }),
    () => conversation,
    () => ["scheduled_tasks"],
    () => {},
  );
  const pending = judge.afterTurn(conversation, turn);
  judge.stop();
  resolve('{"feature":"scheduled_tasks","tier":2}');
  await pending;
  assert.equal(turn.capabilityTip, undefined);
});

test("in-band tips require successful, completed, structured results rather than tool arguments", () => {
  const item = {
    id: "tip",
    type: "dynamicToolCall",
    tool: "suggest_capability",
    status: "completed",
    success: true,
    arguments: { feature: "projects" },
    contentItems: [
      {
        type: "inputText",
        text: '{"suggest":true,"feature":"scheduled_tasks","tier":2}',
      },
    ],
  };
  assert.deepEqual(capabilityTipResult(item), {
    feature: "scheduled_tasks",
    tier: 2,
  });
  assert.equal(
    capabilityTipResult({ ...item, contentItems: undefined }),
    undefined,
  );
  assert.equal(
    capabilityTipResult({ ...item, status: "inProgress" }),
    undefined,
  );
  assert.equal(capabilityTipResult({ ...item, success: false }), undefined);
  for (const text of [
    "not json",
    '{"suggest":false,"feature":"projects","tier":2}',
    '{"suggest":true,"feature":"__proto__","tier":2}',
    '{"suggest":true,"feature":"projects","tier":3}',
  ])
    assert.equal(
      capabilityTipResult({
        ...item,
        contentItems: [{ type: "inputText", text }],
      }),
      undefined,
    );
});

test("attachments, projects, policy and persisted dismissals filter the same pool", () => {
  const turn = reply();
  turn.attachments = [{ id: "image", kind: "image" }] as Turn["attachments"];
  turn.items.push({
    id: "search",
    type: "mcpToolCall",
    tool: "conversation_search",
  });
  const conversation = { ...base([turn]), projectId: "project" };
  const available = {
    ...tipAvailability(
      { localFolders: true, cloudCowork: false, scheduledTasks: true },
      false,
    ),
    incognito: false,
  };
  const result = eligibleCapabilityTips(
    conversation,
    { capabilityTipState: { ...emptyTipPacing(), dismissed: ["skills"] } },
    available,
  );
  for (const key of [
    "file_uploads",
    "screenshots",
    "chat_history_search",
    "projects",
    "temporary_chat",
    "skills",
  ])
    assert.ok(!result.includes(key as (typeof result)[number]), key);
  assert.ok(result.includes("scheduled_tasks"));
  assert.deepEqual(
    eligibleCapabilityTips({ ...conversation, incognito: true }, {}, available),
    [],
  );
});

test("rotation resumes within five seconds and advances once after a longer absence", () => {
  assert.equal(tipRotationMs, 5000);
  assert.deepEqual(initialTipRotation("rotation-test", 11, 100), {
    index: 0,
    shownAt: 100,
  });
  assert.deepEqual(initialTipRotation("rotation-test", 11, 5099), {
    index: 0,
    shownAt: 100,
  });
  assert.deepEqual(initialTipRotation("rotation-test", 11, 5100), {
    index: 1,
    shownAt: 5100,
  });
  assert.deepEqual(initialTipRotation("rotation-test", 11, 99999), {
    index: 2,
    shownAt: 99999,
  });
  assert.deepEqual(initialTipRotation("single", 1, 123), {
    index: 0,
    shownAt: 123,
  });
});

test("scheduled, project, memory, Cowork and incognito actions use existing working routes", () => {
  const actions: unknown[] = [];
  const app = {
    setPage: (page: string) => actions.push(page),
    openSettingsTab: (tab: string) => actions.push(tab),
    newChat: (...args: unknown[]) => actions.push(args),
  } as unknown as AppController;
  for (const feature of [
    "scheduled_tasks",
    "projects",
    "memory",
    "cowork",
    "temporary_chat",
  ] as const)
    actOnCapabilityTip(app, feature);
  assert.deepEqual(actions, [
    "scheduled",
    "projects",
    "memory",
    ["cowork"],
    ["chat", undefined, true],
  ]);
});

test("a reply that fails while its judge is pending cannot receive a tip", async () => {
  const turn = reply();
  const conversation = base([turn]);
  let resolve!: (value: string) => void;
  const judge = new CapabilityTipJudge(
    () => () =>
      new Promise((done) => {
        resolve = done;
      }),
    () => conversation,
    () => ["scheduled_tasks"],
    () => {},
  );
  const pending = judge.afterTurn(conversation, turn);
  turn.status = "failed";
  resolve('{"feature":"scheduled_tasks","tier":2}');
  await pending;
  assert.equal(turn.capabilityTip, undefined);
});

test("the entire tip pool and its actions are translated into all eleven locales", async () => {
  const strings = [
    ...Object.values(capabilityTipCopy).flatMap((copy) => [
      copy.body,
      ...(copy.action ? [copy.action] : []),
    ]),
    "Tip:",
    "Dismiss tip",
    "Search my past chats for",
  ];
  for (const locale of [
    "zh-CN",
    "ja-JP",
    "ko-KR",
    "de-DE",
    "fr-FR",
    "es-ES",
    "es-419",
    "it-IT",
    "pt-BR",
    "id-ID",
    "hi-IN",
  ]) {
    const catalog = (await import(`../../shared/i18n/catalogs/${locale}.ts`))
      .default;
    for (const text of strings) assert.ok(catalog[text], `${locale}: ${text}`);
  }
});
