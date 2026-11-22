/**
 * Response completions on the web (src/web-notifications.ts): the browser's
 * permission and notifications, after the live claude.ai bundle
 * (2026-10-12). The browser is faked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, Schedule } from "../../shared/types";

class FakeNotification {
  static permission: string = "default";
  static asked = 0;
  static answer = "granted";
  static all: FakeNotification[] = [];
  static async requestPermission() {
    FakeNotification.asked++;
    return FakeNotification.answer;
  }
  onclick?: () => void;
  onclose?: () => void;
  closed = false;
  constructor(
    public title: string,
    public options: Record<string, unknown>,
  ) {
    FakeNotification.all.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}
const fakeWindow: any = { isSecureContext: true, focus: () => {} };
fakeWindow.top = fakeWindow;
Object.assign(globalThis, {
  Notification: FakeNotification,
  window: fakeWindow,
  document: { visibilityState: "visible" },
});

const {
  askNotificationPermission,
  notifyCodePermission,
  notifyFinished,
  notifyRoutineFinished,
  permissionRefusal,
} = await import("../../src/app/web-notifications");

test("web scheduled completions respect opt-out, visibility and browser permission", () => {
  FakeNotification.permission = "granted";
  FakeNotification.all = [];
  const previous: any[] = [{ id: "routine", lastRunStatus: "running" }];
  const next: any[] = [
    {
      id: "routine",
      name: "Briefing",
      conversationId: "run",
      lastRunStatus: "completed",
      lastRunSummary: "Three new messages.",
      notifyOnCompletion: { push: true, email: false, slack: false },
    },
  ];
  notifyRoutineFinished(
    previous,
    next,
    () => true,
    () => {},
  );
  assert.equal(FakeNotification.all.length, 0);
  let opened = "";
  notifyRoutineFinished(
    previous,
    next,
    () => false,
    (id) => {
      opened = id;
    },
  );
  assert.equal(FakeNotification.all.length, 1);
  assert.equal(FakeNotification.all[0].options.body, "Three new messages.");
  FakeNotification.all[0].onclick?.();
  assert.equal(opened, "run");
  assert.equal(FakeNotification.all[0].closed, true);
  next[0].notifyOnCompletion.push = false;
  notifyRoutineFinished(
    previous,
    next,
    () => false,
    () => {},
  );
  assert.equal(FakeNotification.all.length, 1);
  next[0].notifyOnCompletion.push = true;
  FakeNotification.permission = "denied";
  notifyRoutineFinished(
    previous,
    next,
    () => false,
    () => {},
  );
  assert.equal(FakeNotification.all.length, 1);
});

const finished = (status: "completed" | "failed" | "interrupted") =>
  ({
    id: "c1",
    title: "Trip plan",
    mode: "chat",
    turns: [{ id: "t", status, items: [], attachments: [], prompt: "" }],
  }) as unknown as Conversation;

test("turning the switch on asks the browser, and says why it stays off", async () => {
  FakeNotification.permission = "default";
  FakeNotification.answer = "denied";
  assert.equal(await askNotificationPermission(), "denied");
  assert.equal(FakeNotification.asked, 1);
  assert.equal(
    permissionRefusal("denied"),
    "Notifications are blocked. Allow them in your browser or system settings, then try again.",
  );
  assert.equal(
    permissionRefusal("default"),
    "To turn this on, try again and allow notifications when your browser asks.",
  );
  assert.match(permissionRefusal("unavailable") ?? "", /own browser tab/);
  assert.equal(permissionRefusal("granted"), undefined);
  // Inside another page there is nothing to ask.
  fakeWindow.top = {};
  assert.equal(await askNotificationPermission(), "unavailable");
  fakeWindow.top = fakeWindow;
});

test("a finished reply is announced unless its chat is on screen", () => {
  FakeNotification.permission = "granted";
  FakeNotification.all = [];
  const opened: string[] = [];
  notifyFinished(finished("completed"), true, (id) => opened.push(id));
  assert.equal(FakeNotification.all.length, 0);
  notifyFinished(finished("completed"), false, (id) => opened.push(id));
  const [shown] = FakeNotification.all;
  assert.equal(shown.title, "Trip plan");
  assert.equal(shown.options.body, "Claudex finished a task");
  shown.onclick?.();
  assert.deepEqual(opened, ["c1"]);
  // A tab in the background announces even the chat it shows.
  (globalThis as any).document.visibilityState = "hidden";
  notifyFinished(finished("failed"), true, () => {});
  assert.equal(
    FakeNotification.all.at(-1)?.options.body,
    "Claudex is waiting for your input",
  );
  // Stopped by the person: nothing to say.
  const before = FakeNotification.all.length;
  notifyFinished(finished("interrupted"), false, () => {});
  assert.equal(FakeNotification.all.length, before);
});

test("a scheduled run's request is told as the task's, under Scheduled tasks, in any mode", () => {
  FakeNotification.permission = "granted";
  FakeNotification.all = [];
  const chat = {
    id: "run",
    title: "Run",
    mode: "chat",
    turns: [],
  } as unknown as Conversation;
  const approval = {
    id: 7,
    conversationId: "run",
    method: "item/commandExecution/requestApproval",
    params: { command: "ls" },
  } as never;
  const task = { name: "Morning briefing" };
  const on = { notifySchedules: true, notifyCodePermissions: false } as never;
  notifyCodePermission(approval, chat, on, false, () => {});
  assert.equal(FakeNotification.all.length, 0, "a Chat request is not Code's");
  notifyCodePermission(
    approval,
    chat,
    { notifySchedules: false } as never,
    false,
    () => {},
    task,
  );
  assert.equal(FakeNotification.all.length, 0);
  notifyCodePermission(approval, chat, on, false, () => {}, task);
  assert.equal(FakeNotification.all.length, 1);
  assert.equal(
    FakeNotification.all[0].title,
    "Scheduled task needs your approval",
  );
  assert.equal(FakeNotification.all[0].options.body, "Morning briefing");
});

test("official Web events deliver Code and scheduled notices and clear them on account exit", async () => {
  const { defaultSettings } = await import("../../electron/store/store");
  const { subscribeOfficialNotifications } = await import("../../src-web/official/notifications");
  type Event = import("../../shared/types").AppEvent;
  FakeNotification.permission = "granted";
  FakeNotification.all = [];
  Object.assign(globalThis.document, { visibilityState: "visible" });
  const opened: string[] = [];
  Object.assign(globalThis, {
    location: { pathname: "/new", hash: "", assign: (url: string) => opened.push(url) },
  });
  const code = {
    ...finished("completed"),
    id: "code",
    title: "Code session",
    mode: "code",
  } satisfies Conversation;
  const notice = async (tag: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = FakeNotification.all.find(item => item.options.tag === tag);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error("Missing browser notification " + tag);
  };
  let receive = (_event: Event) => {};
  const close = subscribeOfficialNotifications({
    recentSnapshot: async () => ({
      settings: { ...defaultSettings, notifyCodeUpdates: true, notifyCodePermissions: true, notifySchedules: true },
      artifactLibrary: { version: 1, copies: [], pinned: [] },
      dismissedBackgroundTasks: [],
      artifactShares: [],
      approvals: [],
      projects: [],
      conversations: [code],
      replyFeedback: {},
      engine: { state: "ready" },
      platform: "linux",
    }),
    api: {
      listSchedules: async () => [],
    },
    officialUiEvents: listener => {
      receive = listener;
      return () => { receive = () => {}; };
    },
  }, () => "owner", () => true);
  await Promise.resolve();

  const approval = { id: "approval", conversationId: code.id, method: "item/commandExecution/requestApproval", params: { command: "ls" } };
  receive({ type: "approval", approval });
  const permission = await notice("code-permission-approval");
  receive({ type: "approval-resolved", id: approval.id });
  assert.equal(permission.closed, true);

  const turn = code.turns[0];
  receive({ type: "conversation-turn", conversationId: code.id, turn: {
    ...turn,
    items: [{
      id: "notice",
      type: "dynamicToolCall",
      tool: "PushNotification",
      status: "completed",
      success: true,
      arguments: { message: "Code task update" },
    }],
  } });
  const update = await notice("code-update-code");
  assert.equal(update.options.body, "Code task update");

  const schedule = {
    id: "routine", name: "Scheduled task", conversationId: code.id,
    prompt: "Run the fixture", enabled: true, createdAt: 0, updatedAt: 0,
    mode: "code", model: "fixture", providerId: "fixture", frequency: "daily",
    lastRunStatus: "running", nextRunAt: 0,
  } satisfies Schedule;
  receive({ type: "schedules", schedules: [schedule] });
  receive({ type: "schedules", schedules: [{ ...schedule, lastRunStatus: "completed" }] });
  const scheduled = await notice("scheduled-code");
  assert.equal(scheduled.options.body, "Scheduled task");

  close();
  assert.equal(update.closed, true);
  assert.equal(scheduled.closed, true);
  scheduled.onclick?.();
  assert.deepEqual(opened, []);
});
