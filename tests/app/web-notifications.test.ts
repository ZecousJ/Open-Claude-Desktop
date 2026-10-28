/**
 * Response completions on the web (src/web-notifications.ts): the browser's
 * permission and notifications, after the reference design. The browser is
 * faked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";

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
