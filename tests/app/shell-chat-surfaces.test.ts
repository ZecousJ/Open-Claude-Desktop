import test, { before } from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, createRef } from "react";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Conversation, Turn } from "../../shared/types";
import {
  ReplyToolbar,
  CodeReplyToolbar,
} from "../../src/transcript/ReplyToolbar";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";
import { routineDom as baseRoutineDom } from "../support/routine-dom";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { defaultSettings } from "../../electron/store/store";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { MicrophoneMenu } from "../../src/composer/MicrophoneMenu";

async function routineDom(...args: Parameters<typeof baseRoutineDom>) {
  const [bridge, options] = args;
  const env = await baseRoutineDom(
    {
      voiceAvailability: async () => ({
        transcription: false,
        maxTranscriptionBytes: null,
        maxSeconds: null,
      }),
      memoryStatus: async () => ({
        available: false,
        reason: "unsupported",
        allowed: { searchChats: false, generate: false },
        prefs: { searchChats: false, generate: false },
        synthesizing: false,
      }),
      ...bridge,
    },
    options,
  );
  const globals = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    dispatchEvent: env.window.dispatchEvent.bind(env.window),
    Event: env.window.Event,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

before(async () => {
  await Promise.all([
    preloadChatSteps(),
    preloadMarkdownRenderer(),
    preloadCodeTurnError(),
  ]);
});
const turn = (id: string, text: string): Turn => ({
  id,
  prompt: `Question ${id}`,
  createdAt: 1,
  attachments: [],
  status: "completed",
  items: [{ id: `${id}-answer`, type: "agentMessage", text }],
});
const conversation = (mode: Conversation["mode"] = "chat"): Conversation => ({
  id: "b21-message-feed",
  title: "Actual rendered feed",
  mode,
  providerId: "test",
  model: "test",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    turn("first", "**First answer.** Additional detail."),
    turn("second", "Second answer. Other text."),
  ],
});
const noop = () => {};
async function waitFor(label: string, ready: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!ready()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await act(async () => {
      await nextTurn();
    });
  }
}
function transcript(value: Conversation, presentation?: "chat") {
  const owner = {
    accountId: "b21-owner",
    controllerScope: {},
    mode: value.mode,
    snapshot: {
      settings: defaultSettings,
      projects: [],
      conversations: [value],
    },
  } as unknown as AppController;
  return h(
    AppContext.Provider,
    { value: owner },
    h(ConversationTranscript, {
      conversation: value,
      mode: value.mode,
      presentation,
      sending: false,
      running: false,
      approvals: [],
      replyFeedback: {},
      onReplyFeedback: async () => {},
      onArtifact: noop,
      onOpenWorkflow: noop,
      onEditPrompt: async () => true,
      onRetryResponse: noop,
      onContinue: noop,
      onSelectVersion: noop,
      onError: noop,
      scrollRef: createRef<HTMLDivElement>(),
      onScroll: noop,
      onWheel: noop,
      away: false,
      onJumpToLatest: noop,
    }),
  );
}
for (const mode of ["chat", "cowork"] as const) {
  test(`69: actual unified ${mode} reply action entry identifies its own message and moves focus into that row`, async () => {
    const copied: string[] = [];
    const env = await routineDom(
      {
        copyText: async (text) => {
          copied.push(text);
        },
      },
      { jsdom: true },
    );
    try {
      const value = conversation(mode);
      await env.render(transcript(value, "chat"));
      const entries = [
        ...env.document.querySelectorAll<HTMLButtonElement>(
          ".assistant-message .show-message-actions",
        ),
      ];
      assert.equal(entries.length, 2);
      assert.equal(
        entries[0].textContent,
        "Show message actions for Claudex responded: First answer.",
      );
      assert.equal(
        entries[1].textContent,
        "Show message actions for Claudex responded: Second answer.",
      );
      assert.equal(
        env.document.querySelectorAll('.assistant-message[role="article"]')
          .length,
        2,
      );
      assert.equal(
        env.document.querySelectorAll('.user-message-article[role="article"]')
          .length,
        2,
      );
      const firstRow = entries[0].parentElement!;
      await env.event(entries[0], "click");
      const copy = firstRow.querySelector<HTMLButtonElement>(
        '[aria-label="Copy"]',
      )!;
      assert.equal(env.document.activeElement, copy);
      assert.equal(
        firstRow.hasAttribute("data-revealed"),
        false,
        "focus-within now owns the row reveal",
      );
      await env.event(copy, "click");
      await waitFor("the actual reply copy", () => copied.length === 1);
      assert.equal(copied[0], value.turns[0].items[0].text);
      assert.equal(
        firstRow.querySelector('[aria-label="Copied"]') !== null,
        true,
      );
      assert.equal(
        entries[1].parentElement!.querySelector('[aria-label="Copied"]'),
        null,
      );
    } finally {
      await env.clean();
    }
  });
}

test("69: source contextual labels do not manufacture a summary for empty content or rewrite independent legacy/Code actions", async () => {
  const env = await routineDom({}, { jsdom: true });
  const value = conversation("cowork");
  const toolbar = (text: string, contextualActions = false) =>
    h(ReplyToolbar, {
      conversation: value,
      turn: turn("standalone", text),
      busy: false,
      contextualActions,
      onRating: async () => {},
      onRetry: noop,
      onSelect: noop,
      onError: noop,
    });
  try {
    await env.render(toolbar("", true));
    assert.equal(
      env.document.querySelector(".show-message-actions")!.textContent,
      "Show message actions",
    );
    await env.render(toolbar("Legacy task reply."));
    assert.equal(
      env.document.querySelector(".show-message-actions")!.textContent,
      "Show message actions",
    );
    await env.render(
      h(CodeReplyToolbar, { turn: turn("code", "Code output"), onFork: noop }),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll("button[aria-label]")].map((button) =>
        button.getAttribute("aria-label"),
      ),
      ["Copy", "Fork from here", "Pin as chapter"],
    );
  } finally {
    await env.clean();
  }
});

for (const presentation of ["web-chat", "native-chat"] as const) {
  test(`48 reuse: actual ${presentation} Add root preserves current order, separator and real Devices capability`, async () => {
    let sends = 0;
    const env = await routineDom(
      {
        customizeSkills: async () => [],
        listDesignSystems: async () => [],
        chatDevices: async () => ({
          version: 1,
          accountScope: "7",
          organizationId: null,
          devices: [
            {
              id: "actual-device",
              name: "Actual workstation",
              platform: "darwin",
              version: "1",
              connectedAt: "2026-10-14T00:00:00Z",
              online: true,
            },
          ],
        }),
        send: async () => {
          sends++;
          throw new Error("Opening a menu must not send");
        },
      },
      { jsdom: true },
    );
    const app = {
      accountId: "b21-owner",
      controllerScope: {},
      mode: "chat",
      incognitoShown: false,
      snapshot: { settings: defaultSettings },
      composerDraft: {},
    } as unknown as AppController;
    const closed: string[] = [];
    try {
      const menu = (owner = app) =>
        h(
          HostContext.Provider,
          { value: presentation === "web-chat" ? webHost : desktopHost },
          h(
            AppContext.Provider,
            { value: owner },
            h(ComposerAddMenu, {
              presentation,
              platform: "darwin",
              projects: [],
              webSearch: false,
              webSearchAvailable: true,
              onWebSearch: noop,
              onResearch: noop,
              researchAvailable: true,
              onClose: () => {
                closed.push("closed");
              },
              onFiles: noop,
              onProject: noop,
              onCreateProject: noop,
              onSettings: noop,
              onUnavailable: noop,
            }),
          ),
        );
      await env.render(menu());
      await waitFor("the actual Devices directory", () =>
        Boolean(env.document.querySelector('[data-add-branch="devices"]')),
      );
      const root = env.document.querySelector(".composer-add-menu")!;
      const rows = [...root.querySelectorAll('[role^="menuitem"]')].filter(
        (child) => child.closest('[role="menu"]') === root,
      );
      assert.deepEqual(
        rows.map(
          (row) =>
            row.querySelector(":scope > span:not([aria-hidden])")?.textContent,
        ),
        [
          "Upload or add files",
          "Skills",
          "Add connector",
          "Design system",
          "Add plugins",
          "Devices",
          "Research",
        ],
      );
      const device = env.document.querySelector('[data-add-branch="devices"]')!;
      assert.equal(
        device.parentElement?.nextElementSibling?.getAttribute("role"),
        "separator",
      );
      assert.equal(root.querySelector('[data-add-branch="project"]'), null);
      await env.event(device, "click");
      assert.ok(env.document.querySelector('[data-add-panel="devices"]'));
      assert.match(
        env.document.querySelector('[data-add-panel="devices"]')!.textContent!,
        /Actual workstation/,
      );
      assert.equal(sends, 0);
      await env.render(menu({ ...app, incognitoShown: true }));
      assert.equal(
        env.document.querySelector('[data-add-branch="devices"]'),
        null,
      );
    } finally {
      await env.clean();
    }
  });
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`57/61 reuse: actual idle microphone at ${size.width}px keeps real enumeration/language and closes without recording`, async () => {
    const env = await routineDom({}, { jsdom: true });
    const globals = {
      innerWidth: size.width,
      innerHeight: size.height,
      addEventListener: env.window.addEventListener.bind(env.window),
      removeEventListener: env.window.removeEventListener.bind(env.window),
    };
    const previous = new Map(
      Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    const media = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    let records = 0,
      closed = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          records++;
          throw new Error("Menu must not record");
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const anchor = createRef<HTMLButtonElement>();
    try {
      await env.render(
        h(
          "div",
          {},
          h("button", { ref: anchor }, "Microphone"),
          h(MicrophoneMenu, {
            anchor,
            variant: "idle",
            onClose: () => {
              closed++;
            },
          }),
        ),
      );
      await waitFor(
        "real empty microphone enumeration",
        () =>
          env.document
            .querySelector(".microphone-menu")
            ?.textContent?.includes("No devices found") === true,
      );
      assert.ok(env.document.querySelector(".microphone-menu-idle"));
      assert.ok(env.document.querySelector(".microphone-language-status"));
      assert.equal(
        env.document.querySelector('[role="menuitemcheckbox"]'),
        null,
        "idle does not inherit legacy Hold to record",
      );
      const language = env.document.querySelector<HTMLButtonElement>(
        ".microphone-language-status",
      )!;
      await env.event(language, "click");
      assert.ok(env.document.querySelector(".dictation-language-menu"));
      await env.event(
        env.document.querySelector(".dictation-language-menu")!,
        "keydown",
        { key: "Escape" },
      );
      assert.equal(
        env.document.querySelector(".dictation-language-menu"),
        null,
      );
      assert.equal(env.document.activeElement, language);
      assert.equal(closed, 0);
      assert.equal(records, 0);
    } finally {
      await env.clean();
      if (media) Object.defineProperty(navigator, "mediaDevices", media);
      else Reflect.deleteProperty(navigator, "mediaDevices");
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
  });
}
