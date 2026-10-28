import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { AppEvent, Conversation } from "../../shared/types";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { ChatSharePopover } from "../../src/conversation/ChatSharePopover";
import { ConversationHeader } from "../../src/conversation/ConversationHeader";
import { ShareEmailCombobox } from "../../src/sharing/ShareEmailCombobox";
import { useConversationSharingStatus } from "../../src/sharing/useConversationSharingStatus";
import { routineDom } from "../support/routine-dom";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import { ConversationShareDialog } from "../../src/conversation/ConversationShareDialog";

const noop = () => {};
const allowed: SharingStatus = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 1000,
  maxArtifactBytes: 1000,
};
const blocked: SharingStatus = {
  ...allowed,
  conversations: false,
  blocked: true,
};
const conversation = (id = "chat", slim = false): Conversation => ({
  id,
  title: "Reference",
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  slim,
  turns: [
    {
      id: "turn",
      prompt: "Streaming prompt",
      attachments: [],
      createdAt: 1,
      status: "inProgress",
      items: [],
    },
  ],
});
const state = {
  share: null,
  busy: false,
  confirmStop: false,
  copied: false,
  repository: false,
} as const;
const share = {
  id: "share",
  kind: "conversation" as const,
  sourceKey: "chat",
  title: "Reference",
  url: "https://share.example.test/s/chat",
  createdAt: 1,
  snapshotAt: 1,
  status: "active" as const,
};
const popoverProps = {
  status: allowed,
  state,
  onClose: noop,
  onAccess: noop,
  onInvite: async () => true,
  onUninvite: noop,
  onCopy: noop,
  onUpdate: noop,
  onUsagePolicy: noop,
};

test("the actual Header exposes ready/busy/lock/audience dialog semantics while Code and incognito keep their branches", () => {
  const target = conversation();
  const render = (
    shareProps: Parameters<typeof ConversationHeader>[0]["share"],
    mode: Conversation["mode"] = "chat",
    incognito = false,
  ) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(ConversationHeader, {
          conversation: { ...target, mode, incognito },
          mode,
          projects: [],
          panel: null,
          running: true,
          titleActions: {
            onPin: noop,
            onRename: noop,
            onMoveToProject: noop,
            onCreateProject: noop,
            onOpenProjects: noop,
            onArchive: noop,
            onDelete: noop,
          },
          onTogglePanel: noop,
          onRename: noop,
          onPin: noop,
          onExport: noop,
          onArchive: noop,
          onDelete: noop,
          share: shareProps,
        }),
      ),
    ).document;
  let button = render({
    shared: false,
    ready: false,
    busy: true,
    disabledReason: "Available once loading finishes",
    onOpen: noop,
  }).querySelector<HTMLButtonElement>(".conversation-share-button")!;
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.title, "Available once loading finishes");
  button = render({
    shared: false,
    ready: true,
    onOpen: noop,
    open: true,
  }).querySelector(".conversation-share-button")!;
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-haspopup"), "dialog");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  button = render({
    shared: true,
    audience: "invited",
    onOpen: noop,
  }).querySelector(".conversation-share-button")!;
  assert.equal(
    button.getAttribute("aria-label"),
    "Shared · Only people invited",
  );
  button = render({
    shared: false,
    disabledReason: "Sharing is disabled by your organization.",
    onOpen: noop,
  }).querySelector(".conversation-share-button")!;
  assert.equal(button.disabled, true);
  assert.ok(button.querySelector("[data-icon]"));
  assert.equal(
    render(undefined).querySelector<HTMLButtonElement>(
      ".conversation-share-button",
    )?.disabled,
    true,
  );
  assert.equal(
    render({ shared: true, onOpen: noop }, "chat", true).querySelector(
      ".conversation-share-button",
    ),
    null,
  );
  assert.equal(
    render({ shared: true, onOpen: noop }, "code").querySelector(
      ".conversation-share-button",
    )?.textContent,
    "Shared",
  );
});

test("real typed-email option commits a recipient without sending; only Invite invokes its actual callback", async () => {
  const env = await routineDom();
  const sent: string[] = [];
  try {
    await env.render(
      createElement(ShareEmailCombobox, {
        disabled: false,
        busy: false,
        onInvite: async (email) => {
          sent.push(email);
          return true;
        },
      }),
    );
    const input =
      env.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const submit = env.document.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    assert.equal(submit.disabled, true);
    assert.equal(input.getAttribute("aria-expanded"), "false");
    await env.change("input", "Reference@Example.test");
    assert.equal(submit.disabled, true, "a raw query is not a recipient");
    await env.event(env.document.querySelector("form")!, "submit");
    assert.deepEqual(sent, [], "form submission cannot bypass the commit gate");
    assert.equal(input.getAttribute("aria-expanded"), "true");
    const option = env.document.querySelector('[role="option"]')!;
    assert.equal(
      option.textContent,
      "Invite reference@example.test tab to add",
    );
    assert.equal(input.getAttribute("aria-activedescendant"), option.id);
    await env.click('[role="option"]');
    assert.equal(input.value, "");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(submit.disabled, false);
    assert.equal(
      env.document.querySelector(".share-recipient-chip > span")?.textContent,
      "reference@example.test",
    );
    assert.deepEqual(sent, []);
    await env.event(env.document.querySelector("form")!, "submit");
    assert.deepEqual(sent, ["reference@example.test"]);
    assert.equal(env.document.querySelector(".share-recipient-chip"), null);
  } finally {
    await env.clean();
  }
});

test("Tab and Enter commit typed emails before Invite and retain input focus; only a committed option cancels native Tab traversal", async () => {
  const env = await routineDom();
  const sent: string[] = [];
  try {
    await env.render(
      createElement(ShareEmailCombobox, {
        disabled: false,
        busy: false,
        onInvite: async (email) => {
          sent.push(email);
          return true;
        },
      }),
    );
    const input = env.document.querySelector<HTMLInputElement>("input")!;
    const submit = env.document.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    for (const key of ["Tab", "Enter"]) {
      await env.change("input", `${key.toLowerCase()}@example.test`);
      assert.equal(submit.disabled, true);
      input.focus();
      const event = await env.event(input, "keydown", { key });
      assert.equal(event.defaultPrevented, true);
      assert.equal(env.document.activeElement, input);
      assert.equal(submit.disabled, false);
      await env.change("input", "uncommitted@example.test");
      await env.event(env.document.querySelector("form")!, "submit");
      assert.equal(input.value, "uncommitted@example.test");
      assert.equal(submit.disabled, true);
    }
    assert.deepEqual(sent, ["tab@example.test", "enter@example.test"]);
    await env.change("input", "");
    assert.equal(
      (await env.event(input, "keydown", { key: "Tab" })).defaultPrevented,
      false,
      "with no option to commit, native Tab navigation remains available",
    );
    await env.change("input", "backwards@example.test");
    assert.equal(
      (await env.event(input, "keydown", { key: "Tab", shiftKey: true }))
        .defaultPrevented,
      false,
      "Shift+Tab navigates backwards without committing a recipient",
    );
    assert.equal(input.value, "backwards@example.test");
    assert.equal(submit.disabled, true);
    assert.equal(env.document.querySelector(".share-recipient-chip"), null);
  } finally {
    await env.clean();
  }
});

test("a known share's background check preserves recipient chips, the typed query, focus and IME without replacing the editor", async () => {
  const env = await routineDom();
  try {
    const render = (checking: boolean) =>
      env.render(
        createElement(ChatSharePopover, {
          ...popoverProps,
          state: { ...state, checking },
        }),
      );
    await render(false);
    const input = env.document.querySelector<HTMLInputElement>("input")!;
    await env.event(input, "paste", {
      clipboardData: { getData: () => "one@example.test two@example.test" },
    });
    await env.change("input", "composition@example.test");
    input.focus();
    await env.event(input, "compositionstart");
    for (const checking of [true, false]) {
      await render(checking);
      assert.equal(env.document.querySelector("input"), input);
      assert.equal(input.value, "composition@example.test");
      assert.equal(input.disabled, false);
      assert.equal(env.document.activeElement, input);
      assert.equal(
        env.document.querySelectorAll(".share-recipient-chip").length,
        2,
      );
      assert.equal(
        env.document
          .querySelector('[role="dialog"]')
          ?.getAttribute("aria-busy"),
        "false",
      );
      await env.event(input, "keydown", { key: "Enter", isComposing: true });
      assert.equal(input.value, "composition@example.test");
    }
    await env.event(input, "compositionend");
    await env.event(input, "keydown", { key: "Enter" });
    assert.equal(input.value, "");
    assert.equal(
      env.document.querySelectorAll(".share-recipient-chip").length,
      3,
    );
  } finally {
    await env.clean();
  }
});

test("IME is not committed by Enter, duplicate recipients are disabled, and Escape closes the list before the popover", async () => {
  const env = await routineDom();
  let close = 0,
    invites = 0;
  try {
    await env.render(
      createElement(ChatSharePopover, {
        ...popoverProps,
        state: {
          ...state,
          share: { ...share, invites: ["known@example.test"] },
        },
        onClose: () => close++,
        onInvite: async () => {
          invites++;
          return true;
        },
      }),
    );
    const input = env.document.querySelector('[role="combobox"]')!;
    await env.change("input", "new@example.test");
    await env.event(input, "keydown", {
      key: "Enter",
      keyCode: 13,
      isComposing: true,
    });
    assert.equal(env.document.querySelector(".share-recipient-chip"), null);
    assert.equal(invites, 0);
    await env.event(input, "keydown", { key: "Escape", keyCode: 27 });
    assert.equal(close, 0);
    assert.equal(input.getAttribute("aria-expanded"), "false");
    await env.event(input, "keydown", { key: "Escape", keyCode: 27 });
    assert.equal(close, 1);
    await env.change("input", "known@example.test");
    assert.equal(
      env.document
        .querySelector('[role="option"]')
        ?.getAttribute("aria-disabled"),
      "true",
    );
    await env.click('[role="option"]');
    assert.equal(env.document.querySelector(".share-recipient-chip"), null);
    assert.equal(invites, 0);
  } finally {
    await env.clean();
  }
});

test("pasted recipients use sequential real invitations, retain failures and never duplicate a pending submission", async () => {
  const env = await routineDom();
  const sent: string[] = [];
  let settle!: (value: boolean) => void;
  try {
    await env.render(
      createElement(ShareEmailCombobox, {
        disabled: false,
        busy: false,
        onInvite: (email) => {
          sent.push(email);
          return new Promise((resolve) => {
            settle = resolve;
          });
        },
      }),
    );
    const input = env.document.querySelector("input")!;
    await env.event(input, "paste", {
      clipboardData: {
        getData: () => "one@example.test; two@example.test, one@example.test",
      },
    });
    assert.equal(
      env.document.querySelectorAll(".share-recipient-chip").length,
      2,
    );
    const form = env.document.querySelector("form")!;
    await env.event(form, "submit");
    await env.event(form, "submit");
    assert.deepEqual(sent, ["one@example.test"]);
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")!.disabled,
      true,
    );
    await act(async () => settle(true));
    assert.deepEqual(sent, ["one@example.test", "two@example.test"]);
    await act(async () => settle(false));
    assert.equal(
      env.document.querySelectorAll(".share-recipient-chip").length,
      1,
    );
    assert.equal(
      env.document.querySelector(".share-recipient-chip > span")?.textContent,
      "two@example.test",
    );
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")!.disabled,
      false,
    );
  } finally {
    await env.clean();
  }
});

test("a complete single pasted email commits its chip immediately without sending an invitation", async () => {
  const env = await routineDom();
  let sent = 0;
  try {
    await env.render(
      createElement(ShareEmailCombobox, {
        disabled: false,
        busy: false,
        onInvite: async () => {
          sent++;
          return true;
        },
      }),
    );
    await env.event(env.document.querySelector("input")!, "paste", {
      clipboardData: { getData: () => "ui-reference@example.invalid" },
    });
    assert.equal(
      env.document.querySelector(".share-recipient-chip > span")?.textContent,
      "ui-reference@example.invalid",
    );
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")?.value,
      "",
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
      false,
    );
    assert.equal(sent, 0);
  } finally {
    await env.clean();
  }
});

test("the actual popover keeps the full policy sentence and associates its existing access label without duplicate visible copy", async () => {
  const env = await routineDom();
  try {
    await env.render(
      createElement(ChatSharePopover, {
        ...popoverProps,
        status: {
          ...allowed,
          usagePolicyUrl: "https://share.example.test/policy",
        },
      }),
    );
    assert.equal(
      env.document.querySelector(".chat-share-note")?.textContent,
      "Don’t share personal information or third-party content without permission, and see our Usage Policy.",
    );
    assert.equal(
      env.document.querySelector(".chat-share-note a")?.getAttribute("href"),
      "https://share.example.test/policy",
    );
    const control = env.document.querySelector(".chat-share-access")!;
    const label = control
      .getAttribute("aria-labelledby")!
      .split(" ")
      .map((id) => env.document.getElementById(id)?.textContent)
      .join(" ");
    assert.equal(label, "Who has access Only people invited");
    assert.equal(env.document.querySelectorAll(".chat-share-label").length, 1);
    assert.equal(
      env.document.activeElement,
      env.document.querySelector('[role="dialog"]'),
    );
  } finally {
    await env.clean();
  }
});

test("the real Dialog, hook and offline sharing domain create an invited share only on Invite and copy its actual service URL", async () => {
  const bridge = createFixtureDesktop(
    { states: true },
    new URLSearchParams("sharing=on&mail=off"),
  );
  const snapshot = await bridge.snapshot();
  const target = snapshot.conversations.find(
    (conversation) => conversation.mode === "chat" && !conversation.incognito,
  )!;
  assert.ok(target);
  const status = await bridge.sharingStatus();
  assert.ok(status);
  const copies: string[] = [];
  bridge.copyText = async (value) => {
    copies.push(value);
  };
  const env = await routineDom(bridge);
  try {
    await env.render(
      createElement(ConversationShareDialog, {
        conversation: target,
        status,
        onClose: noop,
      }),
    );
    for (let i = 0; i < 4; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    assert.ok(env.document.querySelector('[role="combobox"]'));
    await env.event(env.document.querySelector("input")!, "paste", {
      clipboardData: { getData: () => "offline-reference@example.invalid" },
    });
    assert.equal(
      await bridge.conversationShare(target.id),
      null,
      "committing a chip does not publish a snapshot",
    );
    await env.event(env.document.querySelector("form")!, "submit");
    const actual = await bridge.conversationShare(target.id);
    assert.equal(actual?.access, "invited");
    assert.deepEqual(actual?.invites, ["offline-reference@example.invalid"]);
    await env.click(".chat-share-copy");
    assert.deepEqual(copies, [actual?.inviteUrl ?? actual?.url]);
  } finally {
    await env.clean();
  }
});

test("the real Dialog can invite its committed batch during a known snapshot refresh without stale reads clearing its draft or new invites", async () => {
  const bridge = createFixtureDesktop(
    { states: true },
    new URLSearchParams("sharing=on&mail=off"),
  );
  const target = (await bridge.snapshot()).conversations.find(
    (conversation) => conversation.mode === "chat" && !conversation.incognito,
  )!;
  const status = await bridge.sharingStatus();
  assert.ok(status);
  let pauseReads = false;
  const reads: {
    value: HostedShare | null;
    resolve(value: HostedShare | null): void;
  }[] = [];
  const readShare = bridge.conversationShare;
  bridge.conversationShare = async (id) => {
    const value = await readShare(id);
    return pauseReads
      ? new Promise((resolve) => reads.push({ value, resolve }))
      : value;
  };
  const sent: string[] = [];
  const invite = bridge.inviteToShare;
  bridge.inviteToShare = async (id, email) => {
    sent.push(email);
    return invite(id, email);
  };
  const env = await routineDom(bridge);
  try {
    await env.render(
      createElement(ConversationShareDialog, {
        conversation: target,
        status,
        onClose: noop,
      }),
    );
    const input = env.document.querySelector<HTMLInputElement>("input")!;
    assert.ok(input);
    await env.event(input, "paste", {
      clipboardData: { getData: () => "one@example.test two@example.test" },
    });
    await env.change("input", "draft@example.test");
    pauseReads = true;
    await act(async () => {
      await bridge.shareConversation(target.id, "invited");
    });
    assert.equal(
      reads.length,
      1,
      "the actual sharing event starts a background read",
    );
    assert.equal(env.document.querySelector("input"), input);
    assert.equal(input.disabled, false);
    assert.equal(input.value, "draft@example.test");
    assert.equal(
      env.document.querySelectorAll(".share-recipient-chip").length,
      2,
    );
    await env.event(env.document.querySelector("form")!, "submit");
    assert.deepEqual(sent, ["one@example.test", "two@example.test"]);
    assert.equal(input.value, "draft@example.test");
    assert.equal(env.document.querySelector(".share-recipient-chip"), null);
    assert.equal(env.document.querySelectorAll(".chat-share-person").length, 3);
    assert.equal(
      env.document.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
      true,
    );
    await act(async () => {
      for (const read of reads) read.resolve(read.value);
    });
    assert.equal(input.value, "draft@example.test");
    assert.equal(env.document.querySelectorAll(".chat-share-person").length, 3);
    assert.deepEqual((await readShare(target.id))?.invites, sent);
  } finally {
    await env.clean();
  }
});

test("loading is unknown rather than private, read failure offers its real retry, and blocked existing access remains copyable", async () => {
  const env = await routineDom();
  let retried = 0,
    copied = 0;
  try {
    await env.render(
      createElement(ChatSharePopover, {
        ...popoverProps,
        state: { ...state, share: undefined, checking: true },
      }),
    );
    // The loading placeholder is a skeleton group named "Loading" (its
    // name is the accessible label, not visible text).
    const loading = env.document.querySelector('[role="status"]');
    assert.ok(
      (loading?.getAttribute("aria-label") ?? loading?.textContent)?.includes(
        "Loading",
      ),
    );
    assert.equal(env.document.querySelector('[role="combobox"]'), null);
    assert.equal(env.document.querySelector(".chat-share-copy"), null);
    await env.render(
      createElement(ChatSharePopover, {
        ...popoverProps,
        state: {
          ...state,
          share: undefined,
          checkFailed: true,
          error: "Read failed",
        },
        onRetry: () => retried++,
      }),
    );
    assert.equal(
      env.document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      env.document.querySelector('[role="alert"]')?.textContent,
      "Read failed",
    );
    await env.click(".chat-share-retry");
    assert.equal(retried, 1);
    await env.render(
      createElement(ChatSharePopover, {
        ...popoverProps,
        status: blocked,
        state: { ...state, share },
        onCopy: () => copied++,
      }),
    );
    assert.equal(
      env.document.querySelector<HTMLInputElement>('[role="combobox"]')
        ?.disabled,
      true,
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".chat-share-copy")
        ?.disabled,
      false,
    );
    await env.click(".chat-share-copy");
    assert.equal(copied, 1);
    await env.click(".chat-share-access");
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".chat-share-select")
        ?.disabled,
      true,
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".chat-share-copy")
        ?.disabled,
      true,
    );
  } finally {
    await env.clean();
  }
});

test("the real readiness hook permits a persisted streaming prompt, gates hydration/policy and rejects old reads/callbacks", async () => {
  const requests: {
    method: string;
    id?: string;
    resolve(value: unknown): void;
  }[] = [];
  const env = await routineDom({
    sharingStatus: () =>
      new Promise((resolve) => requests.push({ method: "status", resolve })),
    conversationShare: (id) =>
      new Promise((resolve) => requests.push({ method: "share", id, resolve })),
  });
  let current!: ReturnType<typeof useConversationSharingStatus>;
  function Hook({ id = "A", slim = false }: { id?: string; slim?: boolean }) {
    current = useConversationSharingStatus(conversation(id, slim));
    return createElement("span");
  }
  try {
    await env.render(createElement(Hook, {}));
    assert.equal(current.ready, false);
    assert.equal(current.disabledReason, "Available once loading finishes");
    await act(async () => requests[0].resolve(allowed));
    assert.equal(
      current.ready,
      true,
      "snapshot loading belongs to the dialog, not a trigger lock",
    );
    await act(async () => requests[1].resolve(null));
    assert.equal(
      current.ready,
      true,
      "an inProgress turn is not a global sharing lock",
    );
    const old = current;
    await env.render(createElement(Hook, { slim: true }));
    assert.equal(current.ready, false);
    await env.render(createElement(Hook, { slim: false }));
    assert.equal(current.ready, true);
    await env.render(createElement(Hook, { id: "B" }));
    assert.equal(current.share, undefined);
    assert.equal(old.canOpen(), false);
    await act(async () => requests[2].resolve(blocked));
    await act(async () => requests[3].resolve(share));
    assert.equal(current.ready, false);
    assert.equal(
      current.disabledReason,
      "Sharing is disabled by your organization.",
    );
  } finally {
    await env.clean();
  }
});

test("known capabilities remain ready during an ordinary background refresh, while a service change and actual null remain unavailable", async () => {
  const requests: {
    resolve(value: SharingStatus | null): void;
    reject(error: Error): void;
  }[] = [];
  let emit!: (event: AppEvent) => void;
  const env = await routineDom({
    sharingStatus: () =>
      new Promise((resolve, reject) => requests.push({ resolve, reject })),
    conversationShare: async () => null,
    onEvent: (listener) => {
      emit = listener;
      return noop;
    },
  });
  let current!: ReturnType<typeof useConversationSharingStatus>;
  function Hook() {
    current = useConversationSharingStatus(conversation());
    return createElement("span");
  }
  try {
    await env.render(createElement(Hook));
    assert.equal(current.pending, true);
    assert.equal(current.ready, false);
    await act(async () => requests[0].resolve(allowed));
    assert.equal(current.ready, true);
    await act(async () =>
      emit({ type: "sharing", kind: "conversation", sourceKey: "chat" }),
    );
    assert.equal(current.pending, false);
    assert.equal(current.ready, true);
    await act(async () =>
      requests[1].reject(new Error("Temporary refresh failure")),
    );
    assert.equal(current.failed, true);
    assert.equal(
      current.ready,
      true,
      "a failed refresh does not discard known capability data",
    );
    await act(async () => emit({ type: "service-changed" }));
    assert.equal(current.pending, true);
    assert.equal(current.ready, false);
    await act(async () => requests[2].resolve(null));
    assert.equal(current.pending, false);
    assert.equal(current.status, null);
    assert.equal(
      current.ready,
      false,
      "an explicitly unavailable service is never made shareable",
    );
  } finally {
    await env.clean();
  }
});
