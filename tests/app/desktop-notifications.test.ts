/**
 * Notifications, attention and keep-awake (electron/attention-rules.ts,
 * electron/desktop-integration.ts), after the original's notification service.
 * Electron is replaced by a fake module that records the banners.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import type {
  Approval,
  Conversation,
  Schedule,
  Turn,
} from "../../shared/types";

class FakeNotification {
  static all: FakeNotification[] = [];
  static isSupported = () => true;
  listeners = new Map<string, (...args: any[]) => void>();
  closed = false;
  shownCount = 0;
  constructor(public options: Record<string, any>) {
    FakeNotification.all.push(this);
  }
  on(event: string, fn: (...args: any[]) => void) {
    this.listeners.set(event, fn);
  }
  show() {
    this.shownCount++;
  }
  close() {
    this.closed = true;
    this.listeners.get("close")?.();
  }
}
const dock = {
  bounces: [] as string[],
  cancelled: [] as number[],
  badges: [] as string[],
};
(globalThis as any).__fakeNotifyElectron = {
  app: {
    on: () => {},
    off: () => {},
    name: "Claudex",
    dock: {
      bounce: (kind: string) => {
        dock.bounces.push(kind);
        return dock.bounces.length;
      },
      cancelBounce: (id: number) => void dock.cancelled.push(id),
      setBadge: (label: string) => void dock.badges.push(label),
      setMenu: () => {},
    },
  },
  globalShortcut: { register: () => true, unregister: () => {} },
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Notification: FakeNotification,
  powerMonitor: {
    on: () => {},
    off: () => {},
    isOnBatteryPower: () => false,
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active",
  },
  powerSaveBlocker: { start: () => 1, stop: () => {} },
  Tray: class {},
};
const names = Object.keys((globalThis as any).__fakeNotifyElectron);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "const e = globalThis.__fakeNotifyElectron;" +
              names
                .map((name) => `export const ${name} = e.${name};`)
                .join("") +
              "export default e;",
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});

const {
  approvalNotice,
  CodeWorkTracker,
  keepAwakeGraceMs,
  keepAwakeMaxMs,
  keepAwakeStallMs,
  scheduleNotices,
  TurnWatcher,
} = await import("../../electron/engine/attention-rules");
const { DesktopIntegration } =
  await import("../../electron/app/desktop-integration");
const { defaultSettings } = await import("../../electron/store/store");
const { sameMenuState, initialMenuState } =
  await import("../../shared/menu-state");

const turn = (status: Turn["status"], extra: Partial<Turn> = {}): Turn => ({
  id: `t-${status}`,
  prompt: "go",
  attachments: [],
  items: [],
  status,
  createdAt: 1,
  ...extra,
});
const conversation = (
  mode: Conversation["mode"],
  status: Turn["status"],
  extra: Partial<Conversation> = {},
): Conversation =>
  ({
    id: `c-${mode}`,
    title: "",
    mode,
    turns: [turn(status)],
    ...extra,
  }) as Conversation;
const approval = (method: string, params: any, id = 7): Approval => ({
  id,
  conversationId: "c-code",
  method,
  params,
});

test("a finished turn is a quiet banner titled with the session, or its product", () => {
  const watcher = new TurnWatcher();
  watcher.observe(conversation("code", "inProgress"));
  const done = watcher.observe(conversation("code", "completed"));
  assert.deepEqual(done, {
    title: "Claudex Code",
    body: "Claudex finished a task",
    conversationId: "c-code",
    tag: "idle-c-code",
    silent: true,
  });
  watcher.observe(conversation("cowork", "inProgress", { title: "Plan" }));
  const failed = watcher.observe(
    conversation("cowork", "failed", { title: "Plan" }),
  );
  assert.equal(failed?.title, "Plan");
  // An error waits for the person, with sound.
  assert.equal(failed?.body, "Claudex is waiting for your input");
  assert.equal(failed?.silent, false);
});

test("a scheduled run's turn has no finished banner of its own", () => {
  const watcher = new TurnWatcher();
  watcher.observe(conversation("code", "inProgress"));
  assert.equal(
    watcher.observe(conversation("code", "completed"), { scheduledRun: true }),
    undefined,
  );
});

test("a Code permission names the repository, the session and what it would do", () => {
  const c = conversation("code", "inProgress", {
    title: "Fix the tests",
    cwd: "/Users/me/work/claudex",
  });
  const notice = approvalNotice(
    approval("item/commandExecution/requestApproval", { command: "npm test" }),
    c,
    { repoName: () => "claudex-repo" },
  );
  assert.equal(notice.kind, "permission");
  assert.equal(notice.title, "claudex-repo");
  assert.equal(notice.subtitle, "Fix the tests");
  assert.equal(notice.body, "Allow Claudex to run npm test?");
  assert.equal(notice.tag, "permission-7");
  assert.deepEqual(notice.allowOnce, {
    approvalId: 7,
    response: { decision: "accept" },
  });
  // No repository: the folder's name; no folder: the product.
  assert.equal(
    approvalNotice(approval("item/commandExecution/requestApproval", {}), c)
      .title,
    "claudex",
  );
  assert.equal(
    approvalNotice(
      approval("item/commandExecution/requestApproval", {}),
      conversation("code", "inProgress"),
    ).title,
    "Claudex Code",
  );
});

test("a Code session's connector tool approval says what the card says", () => {
  const c = conversation("code", "inProgress", { title: "Triage" });
  const tool = (extra: Record<string, unknown>) =>
    approval("mcpServer/elicitation/request", {
      serverName: "linear",
      message: 'Allow the linear MCP server to run tool "create_issue"?',
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", ...extra },
    });
  assert.equal(
    approvalNotice(tool({}), c).body,
    "Claudex wants to use create_issue from linear",
  );
  assert.equal(
    approvalNotice(
      tool({ tool_title: "Create issue", connector_name: "Linear" }),
      c,
    ).body,
    "Claudex wants to use Create issue from Linear",
  );
});

test("Cowork, Chat and questions say it the original's way", () => {
  const cowork = approvalNotice(
    approval("item/permissions/requestApproval", {
      permissions: { network: { enabled: true } },
    }),
    conversation("cowork", "inProgress", { title: "" }),
  );
  assert.equal(cowork.title, "Cowork");
  assert.equal(cowork.body, "Allow Claudex to access the network?");
  assert.equal(cowork.subtitle, undefined);
  const chat = approvalNotice(
    approval("mcpServer/elicitation/request", { message: "Claude wants X" }),
    conversation("chat", "inProgress"),
  );
  assert.deepEqual(
    [chat.kind, chat.title, chat.body, chat.allowOnce],
    [
      "chat",
      "Claudex needs your approval",
      "A tool is waiting for your approval",
      undefined,
    ],
  );
  const question = approvalNotice(
    approval("item/tool/requestUserInput", {
      questions: [{ id: "a", header: "Pick", question: "Which branch?" }],
    }),
    conversation("code", "inProgress", { title: "Deploy" }),
  );
  assert.deepEqual(
    [question.kind, question.title, question.body, question.tag],
    ["question", "Deploy", "Which branch?", "ask-question-7"],
  );
  assert.equal(
    approvalNotice(
      approval("item/tool/requestUserInput", {}),
      conversation("cowork", "inProgress"),
    ).body,
    "Claudex is asking you a question",
  );
});

test("scheduled runs: completed or failed, with the task's name", () => {
  const task = {
    id: "s1",
    name: "Morning digest",
    conversationId: "c-run",
    lastRunStatus: "running",
  } as Schedule;
  const [done] = scheduleNotices(
    [task],
    [{ ...task, lastRunStatus: "completed" }],
  );
  assert.deepEqual(done, {
    title: "Scheduled task completed",
    body: "Morning digest",
    conversationId: "c-run",
    tag: "scheduled-c-run",
  });
  const [failed] = scheduleNotices(
    [task],
    [{ ...task, lastRunStatus: "failed", lastError: "boom" }],
  );
  assert.equal(failed.title, "Scheduled task failed");
  assert.equal(failed.body, "Morning digest");
});

test("Code work keeps the computer awake with a grace, a stall limit and a day's limit", () => {
  const tracker = new CodeWorkTracker();
  const running = conversation("code", "inProgress");
  tracker.observe(running, 0);
  assert.equal(tracker.holding(1000), true);
  // Ends: held for the grace, then let go.
  tracker.observe(conversation("code", "completed"), 10_000);
  assert.equal(tracker.holding(10_000 + keepAwakeGraceMs - 1), true);
  assert.equal(tracker.nextChange(10_000), keepAwakeGraceMs);
  assert.equal(tracker.holding(10_000 + keepAwakeGraceMs), false);
  // No progress for an hour: no longer counted, until it moves again.
  tracker.observe(running, 100_000);
  assert.equal(tracker.holding(100_000 + keepAwakeStallMs), false);
  tracker.observe(running, 100_000 + keepAwakeStallMs + 5);
  assert.equal(tracker.holding(100_000 + keepAwakeStallMs + 10), true);
  // Never longer than a day, however much it moves.
  tracker.observe(running, 100_000 + keepAwakeMaxMs);
  assert.equal(tracker.holding(100_000 + keepAwakeMaxMs + 1), false);
  // Chat never counts.
  const chat = new CodeWorkTracker();
  chat.observe(conversation("chat", "inProgress"), 0);
  assert.equal(chat.holding(1), false);
});

test("idle banners suppress live workflows and non-noteworthy CI completions", () => {
  for (const reason of ["self_resume_workflow", "ci_not_noteworthy"] as const) {
    const { integration, code, suppressed } = setup({
      window: false,
      viewing: [],
    });
    integration.observeConversation(code);
    code.turns = [
      turn(
        "completed",
        reason === "self_resume_workflow"
          ? {
              items: [
                {
                  id: "workflow",
                  type: "collabAgentToolCall",
                  tool: "workflow",
                  status: "inProgress",
                },
              ],
            }
          : {
              notificationTrigger: "ci-monitor",
              postTurnSummary: { is_noteworthy: false },
            },
      ),
    ];
    integration.observeConversation(code);
    assert.ok(suppressed.includes(reason));
    assert.equal(FakeNotification.all.length, 0);
    integration.stop();
  }
});

test("the open conversation is not part of the menu", () => {
  assert.ok(
    sameMenuState(initialMenuState, { ...initialMenuState, viewing: ["a"] }),
  );
});

function setup(
  focused: { window: boolean; viewing: string[] },
  overrides: Record<string, unknown> = {},
) {
  FakeNotification.all = [];
  dock.bounces = [];
  dock.cancelled = [];
  dock.badges = [];
  const settings = {
    ...structuredClone(defaultSettings),
    notifyCode: true,
    notifyResponses: true,
    notifySchedules: true,
    drawAttention: true,
    ...overrides,
  } as any;
  const code = conversation("code", "inProgress", {
    title: "Fix",
    cwd: "/tmp/app",
  });
  const answered: unknown[][] = [];
  const conversations = [code];
  const opened: (string | undefined)[] = [];
  const commands: string[] = [];
  const suppressed: string[] = [];
  const integration = new DesktopIntegration({
    suppressed: (reason) => {
      suppressed.push(reason);
    },
    window: () =>
      ({
        isDestroyed: () => false,
        isFocused: () => focused.window,
        flashFrame: () => {},
      }) as any,
    settings: () => settings,
    conversations: () => conversations,
    command: (command) => commands.push(command),
    trayIcon: "/nonexistent.png",
    respond: (id, result) => void answered.push([id, result]),
    repoName: () => undefined,
  });
  integration.connectWindows({
    focusConversation: () => false,
    showMain: (id) => (opened.push(id), true),
    viewing: (id) => focused.viewing.includes(id),
  });
  integration.start();
  return {
    integration,
    answered,
    opened,
    code,
    commands,
    suppressed,
    conversations,
  };
}

test("Cowork permissions wait 300ms and recheck resolution, viewing and deletion", async () => {
  const focus = { window: false, viewing: [] as string[] };
  const { integration, code, suppressed } = setup(focus);
  code.mode = "cowork";
  const request = approval("item/commandExecution/requestApproval", {
    command: "ls",
  });
  integration.observeApproval(request);
  assert.equal(FakeNotification.all.length, 0);
  integration.observeApprovalResolved(request.id);
  await new Promise((resolve) => setTimeout(resolve, 330));
  assert.equal(FakeNotification.all.length, 0);
  assert.ok(suppressed.includes("resolved_during_prep"));
  integration.observeApproval({ ...request, id: 8 });
  focus.window = true;
  focus.viewing = [code.id];
  await new Promise((resolve) => setTimeout(resolve, 330));
  assert.equal(FakeNotification.all.length, 0);
  assert.ok(suppressed.includes("viewing_session"));
  focus.viewing = [];
  focus.window = false;
  integration.observeApproval({ ...request, id: 9 });
  code.archived = true;
  await new Promise((resolve) => setTimeout(resolve, 330));
  assert.ok(suppressed.includes("session_gone"));
  assert.equal(FakeNotification.all.length, 0);
  integration.stop();
});

test("Code remains immediate; only explicit re-alert replaces a duplicate permission banner", () => {
  const { integration } = setup({ window: false, viewing: [] });
  const request = approval("item/commandExecution/requestApproval", {
    command: "ls",
  });
  integration.observeApproval(request);
  integration.observeApproval(request);
  assert.equal(FakeNotification.all.length, 1);
  integration.observeApproval(request, { reAlert: true });
  assert.equal(FakeNotification.all.length, 2);
  assert.equal(FakeNotification.all[0].closed, true);
  integration.observeApprovalResolved(request.id);
  assert.equal(FakeNotification.all[1].closed, true);
  integration.stop();
});

test("presence fans out six events and clears the lock latch after input", async () => {
  const { EventEmitter } = await import("node:events");
  const { SystemPresence } = await import("../../electron/app/system-presence");
  const monitor = Object.assign(new EventEmitter(), {
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active" as const,
  });
  const application = new EventEmitter();
  let now = 1000;
  const presence = new SystemPresence(
    monitor as any,
    application as any,
    () => now,
  );
  const events: string[] = [];
  const unsubscribe = presence.subscribe((event) => {
    events.push(event);
  });
  monitor.emit("lock-screen");
  assert.equal(presence.isLocked(), true);
  now += 2001;
  assert.equal(presence.isLocked(), false);
  for (const name of [
    "suspend",
    "resume",
    "unlock-screen",
    "user-did-become-active",
  ])
    monitor.emit(name);
  application.emit("browser-window-focus");
  assert.deepEqual(events, [
    "lock",
    "suspend",
    "resume",
    "unlock",
    "session",
    "focus",
  ]);
  unsubscribe();
  assert.equal(monitor.listenerCount("lock-screen"), 0);
  assert.equal(application.listenerCount("browser-window-focus"), 0);
});

test("a permission banner shows unless its session is on screen, and goes when answered", async () => {
  const focus = { window: true, viewing: ["c-other"] };
  const { integration, answered, opened } = setup(focus);
  const request = approval("item/commandExecution/requestApproval", {
    command: "ls",
  });
  // In front, but showing another session: the banner still shows.
  integration.observeApproval(request);
  assert.equal(FakeNotification.all.length, 1);
  const [banner] = FakeNotification.all;
  assert.equal(banner.options.title, "app");
  assert.equal(banner.options.subtitle, "Fix");
  assert.deepEqual(banner.options.actions, [
    { type: "button", text: "Allow once" },
  ]);
  // Allow once answers as the card would.
  banner.listeners.get("action")?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(answered, [[7, { decision: "accept" }]]);
  banner.listeners.get("click")?.();
  assert.deepEqual(opened, ["c-code"]);
  integration.observeApprovalResolved(7);
  assert.equal(banner.closed, true);
  // Looking at the session: no banner, no bounce.
  focus.viewing = ["c-code"];
  integration.observeApproval({ ...request, id: 8 });
  assert.equal(FakeNotification.all.length, 1);
});

test("renderer notifications dispatch both actions once with their tag, token and elapsed time", () => {
  const { integration, opened } = setup({ window: false, viewing: [] });
  integration.supportsNotificationActions = () => true;
  const events: unknown[] = [];
  const input = {
    title: "Project",
    body: "Request",
    tag: "project-input",
    token: "request_1",
    conversationId: "c-code",
    actions: [
      { id: "approve", title: "Allow" },
      { id: "reject", title: "Deny" },
    ],
  };
  for (const [index, id] of ["approve", "reject"].entries()) {
    integration.showNotification(input, (event) => events.push(event));
    const banner = FakeNotification.all.at(-1)!;
    assert.deepEqual(banner.options.actions, [
      { type: "button", text: "Allow" },
      { type: "button", text: "Deny" },
    ]);
    banner.listeners.get("action")?.({}, index);
    banner.listeners.get("action")?.({}, index);
    banner.listeners.get("click")?.();
    assert.equal(banner.closed, true);
    const event = events.at(-1) as any;
    assert.equal(event.type, "notification-action");
    assert.equal(event.tag, input.tag);
    assert.equal(event.token, input.token);
    assert.equal(event.actionId, id);
    assert.ok(event.sinceShownMs >= 0);
  }
  assert.equal(events.length, 2);
  assert.deepEqual(opened, []);
});

test("replaced, closed and signed-out renderer banners cannot act on another request", () => {
  const { integration, opened } = setup({ window: false, viewing: [] });
  integration.supportsNotificationActions = () => true;
  const events: unknown[] = [];
  const input = {
    title: "Project",
    body: "Request",
    tag: "project-input",
    token: "request_1",
    actions: [{ id: "approve", title: "Allow" }],
  };
  integration.showNotification(input, (event) => events.push(event));
  const old = FakeNotification.all.at(-1)!;
  integration.showNotification({ ...input, token: "request_2" }, (event) =>
    events.push(event),
  );
  assert.equal(old.closed, true);
  old.listeners.get("action")?.({}, 0);
  old.listeners.get("click")?.();
  const current = FakeNotification.all.at(-1)!;
  current.listeners.get("action")?.({}, 5);
  assert.equal(events.length, 0);
  current.close();
  current.listeners.get("action")?.({}, 0);
  current.listeners.get("click")?.();
  integration.showNotification(
    { title: "Claudex", body: "Complete" },
    () => {},
  );
  const anonymous = FakeNotification.all.at(-1)!;
  integration.reset();
  assert.equal(anonymous.closed, true);
  anonymous.listeners.get("click")?.();
  assert.deepEqual(events, []);
  assert.deepEqual(opened, []);
});

test("without native actions a renderer banner still opens its conversation", () => {
  const { integration, opened } = setup({ window: false, viewing: [] });
  integration.supportsNotificationActions = () => false;
  integration.showNotification(
    {
      title: "Project",
      body: "Request",
      tag: "input",
      token: "one",
      conversationId: "c-code",
      actions: [{ id: "approve", title: "Allow" }],
    },
    () => assert.fail("unsupported action"),
  );
  const banner = FakeNotification.all.at(-1)!;
  assert.deepEqual(banner.options.actions, []);
  banner.listeners.get("action")?.({}, 0);
  banner.listeners.get("click")?.();
  banner.listeners.get("click")?.();
  assert.deepEqual(opened, ["c-code"]);
  integration.reset();
});

test("project prompts contribute to the permission badge and clear on reset", () => {
  const { integration } = setup(
    { window: false, viewing: [] },
    {
      notificationLevels: { permission: "badge" },
    },
  );
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
  }) as unknown as WebContents;
  integration.setProjectPromptsWaiting(sender, 3);
  if (process.platform === "darwin") assert.equal(dock.badges.at(-1), "3");
  integration.reset();
  if (process.platform === "darwin") assert.equal(dock.badges.at(-1), "");
});

test("the Dock bounces until nothing waits", () => {
  const focus = { window: false, viewing: [] };
  const { integration } = setup(focus);
  integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 1),
  );
  assert.deepEqual(
    dock.bounces,
    process.platform === "darwin" ? ["critical"] : [],
  );
  integration.observeApprovalResolved(1);
  if (process.platform === "darwin") assert.deepEqual(dock.cancelled, [1]);
});

test("a finished turn's banner goes when its session is opened", () => {
  const focus = { window: false, viewing: [] as string[] };
  const { integration } = setup(focus);
  integration.observeConversation(conversation("code", "inProgress"));
  integration.observeConversation(conversation("code", "completed"));
  const [banner] = FakeNotification.all;
  assert.equal(banner.options.silent, true);
  focus.window = true;
  focus.viewing = ["c-code"];
  integration.observeViewing();
  assert.equal(banner.closed, true);
});

test("a scheduled run's request is the task's", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const focus = { window: false, viewing: [] as string[] };
  const { integration } = setup(focus);
  integration.observeSchedules([
    {
      id: "s",
      name: "Nightly",
      conversationId: "c-code",
      lastRunStatus: "running",
    } as Schedule,
  ]);
  integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 3),
  );
  t.mock.timers.tick(2_000);
  const [banner] = FakeNotification.all;
  assert.equal(banner.options.title, "Scheduled task needs your approval");
  assert.equal(banner.options.body, "Nightly");
});

test("banner words and the Allow once button follow the app language", async () => {
  const { integration } = setup(
    { window: false, viewing: [] },
    { locale: "zh-CN" },
  );
  // The language loads on first use; the next banner speaks it.
  integration.translate();
  await new Promise((resolve) => setTimeout(resolve, 50));
  integration.notify({
    title: "3 scheduled tasks need your attention",
    body: "",
  });
  integration.notify({
    title: "Claudex needs your approval",
    body: "A tool is waiting for your approval",
    allowOnce: { approvalId: 1, response: {} },
  });
  const [grouped, approval] = FakeNotification.all;
  assert.equal(grouped.options.title, "3 个定时任务需要你处理");
  assert.equal(approval.options.title, "Claudex 需要你的批准");
  assert.equal(approval.options.actions[0].text, "允许一次");
  integration.reset();
});

const levels = await import("../../shared/notification-levels");

test("three scheduled failures collapse after the hold and open Scheduled tasks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { integration, commands } = setup({ window: false, viewing: [] });
  const running = [1, 2, 3].map(
    (index) =>
      ({
        id: `task-${index}`,
        name: `Task ${index}`,
        conversationId: `run-${index}`,
        lastRunStatus: "running",
      }) as Schedule,
  );
  integration.observeSchedules(running);
  integration.observeSchedules(
    running.map((task) => ({ ...task, lastRunStatus: "failed" })),
  );
  assert.equal(FakeNotification.all.length, 0);
  t.mock.timers.tick(2_000);
  assert.equal(FakeNotification.all.length, 1);
  assert.equal(
    FakeNotification.all[0].options.title,
    "3 scheduled tasks need your attention",
  );
  assert.equal(FakeNotification.all[0].options.body, "");
  FakeNotification.all[0].listeners.get("click")?.();
  assert.deepEqual(commands, ["scheduled-tasks"]);
  integration.reset();
});

test("resolved scheduled approvals and reset do not deliver held notices", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { integration } = setup({ window: false, viewing: [] });
  integration.observeSchedules([
    {
      id: "task",
      name: "Task",
      conversationId: "c-code",
      lastRunStatus: "running",
    } as Schedule,
  ]);
  integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 3),
  );
  integration.observeApprovalResolved(3);
  t.mock.timers.tick(2_000);
  assert.equal(FakeNotification.all.length, 0);
  integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 4),
  );
  integration.reset();
  t.mock.timers.tick(2_000);
  assert.equal(FakeNotification.all.length, 0);
});

test("by default every local kind is a banner without a Dock badge", () => {
  const focus = { window: false, viewing: [] as string[] };
  const { integration, conversations } = setup(focus, {
    notifyCode: undefined,
    notifyResponses: undefined,
    drawAttention: false,
  });
  integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 1),
  );
  assert.equal(FakeNotification.all.length, 1);
  assert.deepEqual(dock.badges, []);
  // A Cowork task's end is a banner too; a Chat reply's waits for Response
  // completions, off by default.
  conversations.push(
    conversation("cowork", "inProgress"),
    conversation("chat", "inProgress"),
  );
  integration.observeConversation(conversation("cowork", "inProgress"));
  integration.observeConversation(conversation("cowork", "completed"));
  assert.equal(FakeNotification.all.length, 2);
  integration.observeConversation(conversation("chat", "inProgress"));
  integration.observeConversation(conversation("chat", "completed"));
  assert.equal(FakeNotification.all.length, 2);
});

test("a chosen level counts in the badge; Badge only shows no banner", () => {
  const focus = { window: false, viewing: [] as string[] };
  const { integration } = setup(focus, {
    notificationLevels: { permission: "badge" },
  });
  integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 1),
  );
  assert.equal(FakeNotification.all.length, 0);
  if (process.platform === "darwin") {
    assert.deepEqual(dock.badges, ["1"]);
    integration.observeApprovalResolved(1);
    assert.deepEqual(dock.badges, ["1", ""]);
  }
});

test("Off keeps a kind quiet, and the sound None silences banners", () => {
  const focus = { window: false, viewing: [] as string[] };
  const off = setup(focus, { notificationLevels: { idle: "off" } });
  off.integration.observeConversation(conversation("code", "inProgress"));
  off.integration.observeConversation(conversation("code", "failed"));
  assert.equal(FakeNotification.all.length, 0);
  const quiet = setup(focus, { notificationSound: "none" });
  quiet.integration.observeApproval(
    approval("item/commandExecution/requestApproval", {}, 2),
  );
  assert.equal(FakeNotification.all[0].options.silent, true);
});

test("the old switches carry over until a level is chosen", () => {
  const before = { notifyCode: false, notifyResponses: false };
  assert.deepEqual(levels.notificationLevels(before), {
    permission: "off",
    question: "off",
    idle: "off",
  });
  assert.equal(levels.levelRowsShown(before), true);
  assert.equal(levels.attentionIdle(before), true);
  // Never turned off: banners, and the rows stay hidden as in the original.
  assert.deepEqual(levels.notificationLevels({}), {});
  assert.equal(levels.levelRowsShown({}), false);
  assert.deepEqual(levels.levelEffect({}, "permission"), {
    banner: true,
    badge: false,
  });
  // Choosing a level stores the carried-over ones with it.
  const patch = levels.levelPatch(before, "question", "banner");
  assert.deepEqual(patch.notificationLevels, {
    permission: "off",
    question: "banner",
    idle: "off",
  });
  // Once stored, the old switches no longer count.
  assert.deepEqual(
    levels.levelEffect(
      { ...before, notificationLevels: { idle: "banner" } },
      "permission",
    ),
    { banner: true, badge: false },
  );
  assert.deepEqual(levels.freezeLevels({ notifyCode: false }), {
    notificationLevels: { permission: "off", question: "off" },
  });
  assert.equal(levels.levelRowsShown({ notificationSound: "none" }), true);
});
