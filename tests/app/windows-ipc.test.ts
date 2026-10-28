/**
 * The windows IPC domain (R2-B): input checks, and calls a separate window
 * makes about itself doing nothing from the main window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { AppEvent, Attachment, Conversation } from "../../shared/types";
import type { AppContext, AppServices } from "../../electron/app/app-context";
import { ChatWindows } from "../../electron/app/chat-windows";
import { registerWindowsHandlers } from "../../electron/ipc/windows";
import { windowsMethods } from "../../shared/windows-api";
import { initialMenuState } from "../../shared/menu-state";
import { menuState, resetMenuState } from "../../electron/app/menu-state";

class FakeWindow extends EventEmitter {
  destroyed = false;
  pinned = false;
  focused = 0;
  webContents = {};
  constructor(public options: Record<string, any> = {}) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isFullScreen() {
    return false;
  }
  restore() {}
  show() {}
  focus() {
    this.focused++;
  }
  getBounds() {
    return { x: 0, y: 0, width: 900, height: 700 };
  }
  getNormalBounds() {
    return this.getBounds();
  }
  getContentSize() {
    return [900, 700];
  }
  setAlwaysOnTop(on: boolean) {
    this.pinned = on;
  }
  isAlwaysOnTop() {
    return this.pinned;
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
  destroy() {
    this.close();
  }
}

function conversation(id: string, extra: Partial<Conversation> = {}) {
  return {
    id,
    title: id,
    mode: "chat",
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    ...extra,
  } as Conversation;
}

function setup() {
  const main = new FakeWindow();
  const created: FakeWindow[] = [];
  const sent: AppEvent[] = [];
  let caller: FakeWindow | undefined = main;
  const attachment: Attachment = {
    id: "a-1",
    name: "notes.txt",
    path: "/tmp/notes.txt",
  } as Attachment;
  const services: AppServices = {};
  const deactivating: (() => void)[] = [];
  const ctx = {
    appWindows: {
      main: () => main as unknown as BrowserWindow,
      send: (_win: unknown, event: AppEvent) => sent.push(event),
    },
    activeAccount: { id: "acct" },
    store: {
      conversations: [
        conversation("c-1"),
        conversation("c-2"),
        conversation("c-secret", { incognito: true }),
      ],
      settings: { theme: "dark" },
    },
    selectedAttachments: new Map([[attachment.id, attachment]]),
    services,
    callerWindow: () => caller as unknown as BrowserWindow,
    push: () => {},
    onAccountDeactivating: (cb: () => void) => {
      deactivating.push(cb);
      return () => {};
    },
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerWindowsHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx,
    () =>
      new ChatWindows({
        createWindow: (options) => {
          const win = new FakeWindow(options as Record<string, any>);
          created.push(win);
          return win as unknown as BrowserWindow;
        },
        windows: {
          main: () => main as unknown as BrowserWindow,
          focused: () => undefined,
          register: () => {},
          load: async () => {},
          send: (_win, event) => sent.push(event),
          webPreferences: () => ({}),
        },
        push: () => {},
        workAreas: () => [{ x: 0, y: 0, width: 1512, height: 945 }],
        statePath: () => undefined,
        platform: "win32",
        dark: () => true,
        conversation: (id) =>
          (ctx.store.conversations as Conversation[]).find((c) => c.id === id),
        sweepMs: 60_000,
      }),
  );
  const call = (name: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(name)!(...args));
  return {
    handlers,
    call,
    main,
    created,
    sent,
    services,
    deactivate: async () => {
      for (const cb of deactivating) await cb();
    },
    setCaller: (win: FakeWindow | undefined) => {
      caller = win;
    },
  };
}

test("registers exactly the bridge's windows calls", () => {
  const t = setup();
  assert.deepEqual([...t.handlers.keys()].sort(), [...windowsMethods].sort());
});

test("only the main renderer may consume or report a restorable layout", async () => {
  const fixture = setup();
  await fixture.call("openConversationWindow", "c-1");
  fixture.setCaller(fixture.created[0]);
  assert.equal(await fixture.call("takeRestorableLayout"), null);
  assert.equal(await fixture.call("takeRestorablePopouts"), null);
  await fixture.call("reportOpenLayout", { invalid: true });
  fixture.setCaller(fixture.main);
  await assert.rejects(fixture.call("reportOpenLayout", { invalid: true }));
  await fixture.deactivate();
});

test("only the main window tells the application menu what to show", async () => {
  const t = setup();
  resetMenuState();
  await t.call("openConversationWindow", "c-1");
  const report = { ...initialMenuState, mode: "code" as const };
  // A separate window's report is ignored.
  t.setCaller(t.created[0]);
  await t.call("reportMenuState", report);
  assert.equal(menuState().mode, "chat");
  t.setCaller(t.main);
  await t.call("reportMenuState", report);
  assert.equal(menuState().mode, "code");
  await assert.rejects(t.call("reportMenuState", { mode: "code" }));
  resetMenuState();
});

test("opening checks the conversation, the draft and its attachments", async () => {
  const t = setup();
  await assert.rejects(
    t.call("openConversationWindow", "c-9"),
    /isn't available/,
  );
  await assert.rejects(
    t.call("openConversationWindow", "c-secret"),
    /isn't available/,
  );
  await assert.rejects(t.call("openConversationWindow", "../c-1"));
  await assert.rejects(t.call("openConversationWindow", "x".repeat(129)));
  await assert.rejects(
    t.call("openConversationWindow", "c-1", {
      text: "x".repeat(200001),
      attachmentIds: [],
    }),
  );
  await assert.rejects(
    t.call("openConversationWindow", "c-1", {
      text: "hi",
      attachmentIds: ["a-unknown"],
    }),
    /no longer available/,
  );
  await assert.rejects(
    t.call("openConversationWindow", "c-1", {
      text: "hi",
      attachmentIds: Array(13).fill("a-1"),
    }),
  );
  assert.equal(t.created.length, 0);

  await t.call("openConversationWindow", "c-1", {
    text: "draft",
    attachmentIds: ["a-1"],
    model: "gpt-5",
    extra: "dropped",
  });
  assert.equal(t.created.length, 1);
  assert.equal(t.created[0].options.titleBarStyle, "hidden");
  assert.deepEqual(await t.call("conversationWindows"), ["c-1"]);

  // Only the new window reads the draft, with its attachment resolved.
  assert.equal(await t.call("takeWindowHandoff"), null);
  t.setCaller(t.created[0]);
  const handoff = await t.call("takeWindowHandoff");
  assert.equal(handoff.text, "draft");
  assert.equal(handoff.model, "gpt-5");
  assert.equal(handoff.extra, undefined);
  assert.deepEqual(
    handoff.attachments.map((a: Attachment) => a.id),
    ["a-1"],
  );
  assert.equal(await t.call("takeWindowHandoff"), null);
});

test("window-only calls do nothing from the main window", async () => {
  const t = setup();
  await t.call("openConversationWindow", "c-1");
  assert.equal(await t.call("setWindowPinned", true), false);
  assert.equal(t.created[0].pinned, false);
  await t.call("reportWindowVisibility", true);
  await t.call("forwardToMainWindow", "settings");
  assert.deepEqual(t.sent, []);
  await assert.rejects(t.call("returnToMainWindow"), /isn't a separate/);
  assert.equal(t.created[0].destroyed, false);
  t.setCaller(undefined);
  assert.equal(await t.call("takeWindowHandoff"), null);
});

test("a separate window pins itself, forwards commands and returns", async () => {
  const t = setup();
  await t.call("openConversationWindow", "c-1");
  await t.call("openConversationWindow", "c-2");
  const [one, two] = t.created;
  t.setCaller(one);
  assert.equal(await t.call("setWindowPinned", true), true);
  assert.equal(await t.call("getWindowPinned"), true);
  assert.equal(one.pinned, true);
  assert.equal(two.pinned, false);
  await assert.rejects(t.call("setWindowPinned", "yes"));

  await t.call("forwardToMainWindow", "new-chat");
  assert.deepEqual(t.sent.at(-1), { type: "command", command: "new-chat" });
  await assert.rejects(t.call("forwardToMainWindow", "open-conversation"));
  await assert.rejects(t.call("forwardToMainWindow", "quit"));
  await assert.rejects(
    t.call("forwardToMainWindow", { openConversation: "c-secret" }),
    /isn't available/,
  );
  // A conversation with its own window is focused there.
  const before = t.sent.length;
  await t.call("forwardToMainWindow", { openConversation: "c-2" });
  assert.equal(two.focused, 1);
  assert.equal(t.sent.length, before);
  // Any other goes to the main window.
  two.close();
  await t.call("forwardToMainWindow", { openConversation: "c-2" });
  assert.deepEqual(t.sent.at(-1), {
    type: "command",
    command: "open-conversation",
    conversationId: "c-2",
  });

  await t.call("returnToMainWindow", { text: "kept", attachmentIds: [] });
  assert.equal(one.destroyed, true);
  assert.deepEqual(t.sent.at(-1), {
    type: "command",
    command: "open-conversation",
    conversationId: "c-1",
  });
  t.setCaller(t.main);
  assert.equal((await t.call("takeWindowHandoff")).text, "kept");
  assert.deepEqual(await t.call("conversationWindows"), []);
});

test("other packages reach the windows through ctx.services.chatWindows", async () => {
  const t = setup();
  const slot = t.services.chatWindows!;
  assert.deepEqual(slot.conversationIds(), []);
  assert.equal(slot.focusConversation("c-1"), false);
  await slot.openConversation("c-1");
  assert.deepEqual(slot.conversationIds(), ["c-1"]);
  assert.equal(slot.focusConversation("c-1"), true);
});

test("signing out drops a draft the main window has not taken", async () => {
  const t = setup();
  await t.call("openConversationWindow", "c-1");
  t.setCaller(t.created[0]);
  await t.call("returnToMainWindow", {
    text: "private draft",
    attachmentIds: ["a-1"],
  });
  await t.deactivate();
  t.setCaller(t.main);
  assert.equal(await t.call("takeWindowHandoff"), null);
});
