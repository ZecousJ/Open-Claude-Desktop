import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CodeSessionAssistance,
  inPersonsVoice,
} from "../../electron/engine/code-session-assistance";
import CodeNewTaskCard from "../../src/code-session/CodeNewTaskCard";
import { defaultSettings } from "../../electron/store/store";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { dynamicWorkflowsEnabled } from "../../shared/code-session-settings";
import {
  safeguardFallbackModel,
  safeguardFlagged,
} from "../../shared/safeguard-fallback";
import { workflowSettings } from "../../electron/workflows/extension-support";
import { codeSandboxFor } from "../../shared/sandbox-policy";
import { openPolicy } from "../../shared/client-policy";
import {
  ClaudeCodeTab,
  bypassPermissionsDescription,
} from "../../src/settings/tabs/ClaudeCode";
import { attentionKind } from "../../src/code-home/CodeLanding";
import { historyNeedsAttention } from "../../src/collections/history/history-rows";
import type { Conversation, Settings, Turn } from "../../shared/types";

const turn = (): Turn => ({
  id: "turn",
  prompt: "Fix the tests",
  attachments: [],
  items: [
    { id: "edit", type: "fileChange", changes: [] },
    {
      id: "reply",
      type: "agentMessage",
      text: "Fixed the tests. Please review the changes.",
    },
  ],
  status: "completed",
  createdAt: 1,
});
const session = (extra: Partial<Conversation> = {}): Conversation => ({
  id: "session",
  title: "Tests",
  mode: "code",
  providerId: "default",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  classifySessionStates: true,
  turns: [turn()],
  ...extra,
});

test("Code settings use the official defaults and only one local fallback switch", () => {
  for (const key of [
    "classifySessionStates",
    "ccPromptSuggestions",
    "switchModelsOnFlag",
  ] as const) {
    assert.equal(preference(defaultSettings, key), true);
    assert.equal(preferenceFields[key].safeParse(false).success, true);
    assert.equal(preferenceFields[key].safeParse("false").success, false);
  }
  // Bypass stays available by default; the original starts it off.
  assert.equal(preference(defaultSettings, "allowBypassPermissions"), true);
  const render = (settings: Settings) =>
    renderToStaticMarkup(
      createElement(ClaudeCodeTab, {
        settings,
        save() {},
        platform: "darwin",
        engine: { state: "ready" },
        onError() {},
        goTo() {},
      }),
    );
  const markup = render(defaultSettings);
  for (const label of [
    "Classify session states",
    "Prompt suggestions",
    "Switch models when a message is flagged",
  ])
    assert.match(
      markup,
      new RegExp(
        `aria-label="${label}" aria-checked="true" class="settings-toggle"`,
      ),
    );
  assert.equal(
    (
      markup.match(
        /role="switch" aria-label="Switch models when a message is flagged"/g,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(markup, /Applies to cloud sessions\.<\/p>/);
  assert.ok(markup.includes(bypassPermissionsDescription));
  assert.match(markup, /href="\/help\/code-security"/);
  assert.doesNotMatch(markup, /uninterrupted in folders you confirm/);
  const off = render({
    ...defaultSettings,
    classifySessionStates: false,
    ccPromptSuggestions: false,
    switchModelsOnFlag: false,
  });
  for (const label of [
    "Classify session states",
    "Prompt suggestions",
    "Switch models when a message is flagged",
  ])
    assert.match(
      off,
      new RegExp(
        `aria-label="${label}" aria-checked="false" class="settings-toggle"`,
      ),
    );
});

test("workflow defaults follow the account, explicit opt-ins and policy in UI and runtime", () => {
  // On unless the service or the user says otherwise.
  for (const [planLabel, expected] of [
    [null, true],
    ["Pro", true],
    ["Max", true],
    ["Raven", true],
  ] as const) {
    const policy = { ...openPolicy, planLabel };
    assert.equal(dynamicWorkflowsEnabled(defaultSettings, policy), expected);
    assert.equal(workflowSettings(defaultSettings, policy).enabled, expected);
  }
  assert.equal(
    dynamicWorkflowsEnabled(
      {},
      { planLabel: "Custom", workflowsDefaultOn: true },
    ),
    true,
  );
  assert.equal(
    dynamicWorkflowsEnabled(
      {},
      { planLabel: "Max", workflowsDefaultOn: false },
    ),
    false,
  );
  assert.equal(
    dynamicWorkflowsEnabled(
      { workflows: { enabled: false } },
      { planLabel: "Max" },
    ),
    false,
  );
  assert.equal(
    dynamicWorkflowsEnabled(
      { workflows: { enabled: true } },
      { planLabel: "Pro" },
    ),
    true,
  );
  assert.equal(
    dynamicWorkflowsEnabled(
      { workflows: { enabled: true } },
      { planLabel: "Max", workflows: false },
    ),
    false,
  );
});

test("unrelated-task preference defaults to Ask me and validates all three choices", () => {
  assert.equal(preference(defaultSettings, "ccNewTaskPrompt"), "ask");
  for (const value of ["ask", "here", "new_session"])
    assert.equal(
      preferenceFields.ccNewTaskPrompt.safeParse(value).success,
      true,
    );
  assert.equal(
    preferenceFields.ccNewTaskPrompt.safeParse("other").success,
    false,
  );
  const markup = renderToStaticMarkup(
    createElement(ClaudeCodeTab, {
      settings: defaultSettings,
      save() {},
      platform: "darwin",
      engine: { state: "ready" },
      onError() {},
      goTo() {},
    }),
  );
  assert.match(markup, /When you ask for an unrelated task/);
  assert.match(markup, /Ask me/);
  assert.doesNotMatch(markup, /Authorization tokens/);
});

test("until a task is done here, a request is the first task, never a new one", async () => {
  let calls = 0;
  const greeting = session({
    turns: [
      {
        ...turn(),
        prompt: "hey",
        items: [
          {
            id: "reply",
            type: "agentMessage",
            text: "What would you like to work on?",
          },
        ],
      },
    ],
  });
  const assistance = new CodeSessionAssistance(
    () => ({ ...defaultSettings }),
    () => async () => {
      calls++;
      return '{"scope":"new_task"}';
    },
    () => greeting,
    () => {},
  );
  assert.equal(
    await assistance.unrelatedTask(greeting, "Make an SVG animation page"),
    false,
  );
  assert.equal(calls, 0);
});

test("unrelated-task detection is capped, conservative and skips Always do it here", async () => {
  const conversation = session();
  let calls = 0;
  let answer = '{"scope":"new_task"}';
  const settings = { ...defaultSettings };
  const assistance = new CodeSessionAssistance(
    () => settings,
    () => async (prompt, options) => {
      calls++;
      assert.equal(options?.maxOutputTokens, 64);
      assert.ok(JSON.parse(prompt.input).request.length <= 4000);
      assert.ok(JSON.parse(prompt.input).transcript.length <= 12000);
      return answer;
    },
    () => conversation,
    () => {},
  );
  assert.equal(
    await assistance.unrelatedTask(conversation, "new work ".repeat(1000)),
    true,
  );
  for (const response of ['{"scope":"continuation"}', "malformed", "{}"]) {
    answer = response;
    assert.equal(
      await assistance.unrelatedTask(conversation, "Follow up"),
      false,
    );
  }
  const before = calls;
  settings.ccNewTaskPrompt = "here";
  assert.equal(await assistance.unrelatedTask(conversation, "New task"), false);
  settings.ccNewTaskPrompt = "ask";
  assert.equal(await assistance.unrelatedTask(conversation, "/review"), false);
  assert.equal(
    await assistance.unrelatedTask(session({ turns: [] }), "New task"),
    false,
  );
  assert.equal(calls, before);
});

test("stopping or changing a session discards its pending task check", async () => {
  const conversation = session();
  let resolve!: (answer: string) => void;
  const assistance = new CodeSessionAssistance(
    () => defaultSettings,
    () => () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    () => conversation,
    () => {},
  );
  const stopped = assistance.unrelatedTask(conversation, "New work");
  assistance.stop();
  assert.equal(await stopped, false);
  const stale = assistance.unrelatedTask(conversation, "New work");
  conversation.turns.push(turn());
  resolve('{"scope":"new_task"}');
  assert.equal(await stale, false);
});

test("task detection times out even when its completer ignores cancellation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const conversation = session();
  const assistance = new CodeSessionAssistance(
    () => defaultSettings,
    () => () => new Promise<string>(() => {}),
    () => conversation,
    () => {},
  );
  const pending = assistance.unrelatedTask(conversation, "New work");
  context.mock.timers.tick(4000);
  assert.equal(await pending, false);
});

test("the new-task card offers both paths without translating the user's prompt", () => {
  const conversation = session({
    codeNewTask: {
      id: "offer",
      text: "Fix <the> project",
      attachments: [],
      providerId: "p",
      model: "m",
    },
  });
  const markup = renderToStaticMarkup(
    createElement(CodeNewTaskCard, {
      conversation,
      onStarted() {},
      onError() {},
    }),
  );
  for (const label of [
    "Start this in its own session?",
    "Don’t ask again",
    "Do it here",
    "New session",
  ])
    assert.ok(markup.includes(label));
  assert.match(markup, /data-no-translate="true">Fix &lt;the&gt; project/);
});

test("a completed session generates a paid classification and a next prompt through its host completer", async () => {
  const conversation = session();
  let saves = 0;
  const assistance = new CodeSessionAssistance(
    () => defaultSettings,
    () => async (prompt, options) => {
      assert.match(prompt.instructions, /untrusted session data/);
      assert.match(prompt.instructions, /ready_for_review/);
      assert.match(prompt.input, /Fixed the tests/);
      assert.equal(options?.maxOutputTokens, 512);
      return '{"state":"ready_for_review","prompt":" Commit the changes "}';
    },
    () => conversation,
    () => saves++,
  );
  await assistance.afterTurn(conversation, conversation.turns[0]);
  assert.equal(conversation.sessionState, "ready_for_review");
  assert.deepEqual(conversation.promptSuggestion, {
    turnId: "turn",
    text: "Commit the changes",
  });
  assert.equal(attentionKind(conversation, []), "review");
  assert.equal(historyNeedsAttention(conversation, false), true);
  assert.equal(saves, 1);
});

test("classification opt-out is captured by the session; prompt opt-out stops requests", async () => {
  const settings = { ...defaultSettings, ccPromptSuggestions: false };
  const conversation = session({ classifySessionStates: false });
  let calls = 0;
  const assistance = new CodeSessionAssistance(
    () => settings,
    () => async () => {
      calls++;
      return '{"state":"done","prompt":"More work"}';
    },
    () => conversation,
    () => {},
  );
  await assistance.afterTurn(conversation, conversation.turns[0]);
  assert.equal(calls, 0);
  conversation.classifySessionStates = true;
  await assistance.afterTurn(conversation, conversation.turns[0]);
  assert.equal(calls, 1);
  assert.equal(conversation.sessionState, "done");
  assert.equal(conversation.promptSuggestion, undefined);
});

test("stale, stopped, malformed and failed assistance never overwrites a newer turn", async () => {
  const conversation = session();
  let resolve!: (value: string) => void;
  const assistance = new CodeSessionAssistance(
    () => defaultSettings,
    () => () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    () => conversation,
    () => assert.fail("stale completion saved"),
  );
  const pending = assistance.afterTurn(conversation, conversation.turns[0]);
  assistance.stop();
  resolve('{"state":"blocked","prompt":"Continue"}');
  await pending;
  assert.equal(conversation.sessionState, undefined);
  const failed = { ...turn(), status: "failed" as const };
  conversation.turns = [failed];
  await assistance.afterTurn(conversation, failed);
  assert.equal(conversation.sessionState, "blocked");
  assert.equal(attentionKind(conversation, []), "blocked");
  for (const answer of ["not json", '{"state":"invented","prompt":123}']) {
    conversation.turns = [turn()];
    const invalid = new CodeSessionAssistance(
      () => defaultSettings,
      () => async () => answer,
      () => conversation,
      () => {},
    );
    await invalid.afterTurn(conversation, conversation.turns[0]);
    assert.equal(conversation.promptSuggestion, undefined);
  }
});

test("safeguard fallback only handles explicit flags and never repeats a model", () => {
  for (const code of [
    "content_policy_violation",
    "content_filter",
    "safety_violation",
    "model_refusal",
  ])
    assert.equal(safeguardFlagged({ code }), true);
  for (const code of [
    "429",
    "model_access",
    "usage_limit",
    "ECONNRESET",
    "unauthorized",
  ])
    assert.equal(safeguardFlagged({ code }), false);
  assert.equal(
    safeguardFlagged({ message: "a safeguard was mentioned" }),
    false,
  );
  const provider = {
    ...defaultSettings.providers[0],
    model: "first",
    models: ["first", "second", "third"],
  };
  assert.equal(safeguardFallbackModel(provider, ["first"]), "second");
  assert.equal(safeguardFallbackModel(provider, ["first", "second"]), "third");
  assert.equal(
    safeguardFallbackModel(provider, ["first", "second", "third"]),
    undefined,
  );
});

test("the bypass switch is enforced even in a confirmed folder", () => {
  const settings = {
    ...defaultSettings,
    codeSandbox: "danger-full-access" as const,
    bypassFolders: ["/work"],
  };
  assert.equal(
    codeSandboxFor({ ...settings, allowBypassPermissions: false }, "/work"),
    "workspace-write",
  );
  assert.equal(
    codeSandboxFor({ ...settings, allowBypassPermissions: true }, "/work"),
    "danger-full-access",
  );
});

test("Capabilities' switch lets Chat and Cowork move to another model, on by default", () => {
  assert.equal(preference(defaultSettings, "modelAutoFallback"), true);
  assert.equal(
    preferenceFields.modelAutoFallback.safeParse(false).success,
    true,
  );
});

test("a suggested prompt is the person's own words, never Claude's offer or reply", () => {
  const reply =
    "页面已完成。打开预览地址看看效果，需要我再调整鹈鹕造型或动画细节吗？";
  assert.equal(
    inPersonsVoice(
      "打开预览地址看看效果，需要我再调整鹈鹕造型或动画细节吗？",
      reply,
    ),
    false,
  );
  assert.equal(inPersonsVoice("Do you want me to add tests?", ""), false);
  assert.equal(inPersonsVoice("打开预览地址看看效果", reply), false);
  assert.equal(inPersonsVoice("把车轮转得再快一点", reply), true);
  assert.equal(inPersonsVoice("Add tests for the parser", reply), true);
});
