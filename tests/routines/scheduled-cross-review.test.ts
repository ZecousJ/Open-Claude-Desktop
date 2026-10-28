import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { DesktopAPI } from "../../shared/types";
import type { Routine, RoutineCapabilities } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import type { RoutineDraft } from "../../src/collections/routines/routine-draft";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";

// Exercise the actual web notification permission branch in an isolated test worker.
const surfaceDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "__CLAUDEX_SURFACE__",
);
Object.defineProperty(globalThis, "__CLAUDEX_SURFACE__", {
  configurable: true,
  value: "web",
});
const [
  { RoutineSettings },
  { RoutineHistory },
  { RoutinesPage },
  { requestScheduleConfirmation },
  { newDraft },
  { defaultSettings },
  { HostContext },
  { webHost },
  { currentToasts, dismissAllToasts },
  { activateRoutineReadAccount },
] = await Promise.all([
  import("../../src/collections/routines/RoutineSettings"),
  import("../../src/collections/routines/RoutineHistory"),
  import("../../src/collections/routines/RoutinesPage"),
  import("../../src/collections/routines/schedule-request"),
  import("../../src/collections/routines/routine-draft"),
  import("../../electron/store/store"),
  import("../../src/host/HostContext"),
  import("../../shared/host"),
  import("../../src/ui/toast-store"),
  import("../../src/collections/routines/routine-read-receipts"),
]);
if (surfaceDescriptor)
  Object.defineProperty(globalThis, "__CLAUDEX_SURFACE__", surfaceDescriptor);
else Reflect.deleteProperty(globalThis, "__CLAUDEX_SURFACE__");

const now = Date.now();
const base: Routine = {
  id: "cross-review-task",
  name: "Review task",
  prompt: "Review the changes.",
  mode: "cowork",
  providerId: "p",
  model: "Opus",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: now + 86_400_000,
  createdAt: now,
  updatedAt: now,
  executionLocation: "remote",
};
const draft = {
  ...newDraft(now, undefined, "cowork"),
  name: base.name,
  prompt: base.prompt,
  executionLocation: "remote" as const,
};
const supported: RoutineCapabilities = {
  remote: true,
  email: true,
  slack: true,
};
const unsupported: RoutineCapabilities = {
  remote: false,
  email: false,
  slack: false,
};
const settings = {
  ...defaultSettings,
  activeProviderId: "p",
  providers: [
    {
      id: "p",
      name: "Synthetic",
      baseUrl: "",
      protocol: "responses" as const,
      model: "Opus",
      models: [],
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const wrap = (child: ReturnType<typeof createElement>) =>
  createElement(HostContext.Provider, { value: webHost }, child);
const routinePage = () =>
  createElement(
    HostContext.Provider,
    {
      value: {
        ...webHost,
        capabilities: { ...webHost.capabilities, scheduledTasks: true },
      },
    },
    createElement(RoutinesPage, {
      settings,
      onOpenConversation() {},
      onChooseFolder: async () => null,
      onConfirmDelete() {},
      onError(error) {
        throw error;
      },
    }),
  );

async function environment(bridge: Partial<DesktopAPI> = {}) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  document.documentElement.dataset.motion = "reduced";
  (document as unknown as { oninput: null }).oninput = null;
  window.desktop = {
    routineCapabilities: async () => supported,
    routineRuns: async () => [],
    listSchedules: async () => [],
    onEvent: () => () => {},
    ...bridge,
  } as unknown as DesktopAPI;
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "top", { configurable: true, value: window });
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    Notification: {
      permission: "granted",
      requestPermission: async () => "granted",
    },
  };
  const saved = new Map(
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
  const inputPrototype = window.HTMLInputElement.prototype;
  const inputType = Object.getOwnPropertyDescriptor(inputPrototype, "type");
  Object.defineProperty(inputPrototype, "type", {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.getAttribute("type") || "text";
    },
    set(this: HTMLInputElement, value: string) {
      this.setAttribute("type", value);
    },
  });
  const focus = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "focus",
  );
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let releaseAccount = activateRoutineReadAccount("cross-review-account-a");
  const switchAccount = (id: string) => {
    releaseAccount();
    releaseAccount = activateRoutineReadAccount(id);
  };
  const render = (child: ReturnType<typeof createElement> | null) =>
    act(async () => {
      root.render(child);
    });
  const event = async (target: Element | Document, type: string) => {
    const next = new window.Event(type, { bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(next);
    });
  };
  const click = (selector: string) =>
    event(document.querySelector(selector)!, "click");
  const change = async (selector: string, value: string) => {
    const input = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(selector)!;
    await act(async () => {
      const prototype =
        input.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : inputPrototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const clean = async () => {
    await act(async () => {
      releaseAccount();
      root.unmount();
      dismissAllToasts();
    });
    if (focus)
      Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    if (inputType) Object.defineProperty(inputPrototype, "type", inputType);
    else Reflect.deleteProperty(inputPrototype, "type");
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    window,
    document,
    render,
    event,
    click,
    change,
    switchAccount,
    clean,
  };
}

test("cross review: location capability races preserve only the matching last-known result and stored channels", async () => {
  const lateLocal = deferred<RoutineCapabilities>();
  let calls = 0;
  const page = await environment({
    routineCapabilities: async () => {
      calls++;
      if (calls === 1) return supported;
      if (calls === 2) return lateLocal.promise;
      throw new Error("Remote refresh unavailable");
    },
  });
  const value = {
    ...draft,
    notifyOnCompletion: { push: false, email: true, slack: true },
  };
  const patches: unknown[] = [];
  const show = (executionLocation: "local" | "remote") =>
    page.render(
      createElement(RoutineSettings, {
        draft: { ...value, executionLocation },
        onChange: (patch) => patches.push(patch),
      }),
    );
  try {
    await show("remote");
    await page.click(".routine-advanced-trigger");
    // The web's Advanced settings are tabs; the switch is under Notifications.
    await page.click('.routine-advanced-tabs [role="tab"]:last-child');
    await show("local");
    await show("remote");
    await act(async () => lateLocal.resolve(unsupported));
    assert.match(
      page.document.querySelector(".routine-notification-channels")!
        .textContent!,
      /Email/,
    );
    assert.match(
      page.document.querySelector(".routine-notification-channels")!
        .textContent!,
      /Slack/,
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Remote refresh unavailable/,
    );
    assert.deepEqual(
      patches,
      [],
      "a failed capability read must not rewrite saved notifications",
    );
    assert.deepEqual(value.notifyOnCompletion, {
      push: false,
      email: true,
      slack: true,
    });
  } finally {
    await page.clean();
  }
});

test("cross review: late history reads and receipt Retry leave the newly selected task alone and do not reopen chats", async () => {
  const receipt = deferred<void>(),
    oldLoad = deferred<RoutineRun[]>();
  const run: RoutineRun = {
    id: "cross-run-a",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "chat-a",
  };
  let calls = 0,
    reads = 0,
    opens = 0;
  const events = new Set<Parameters<DesktopAPI["onEvent"]>[0]>();
  const page = await environment({
    routineRuns: async (id) =>
      id === "task-a"
        ? ++reads === 1
          ? [run]
          : oldLoad.promise
        : [{ ...run, id: "run-b", conversationId: "chat-b", readAt: now }],
    markRoutineRunRead: () =>
      ++calls === 1 ? receipt.promise : Promise.resolve(),
    onEvent(listener) {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
  });
  const show = (id: string) =>
    page.render(
      wrap(
        createElement(RoutineHistory, {
          routine: { ...base, id },
          onOpenConversation() {
            opens++;
          },
        }),
      ),
    );
  try {
    await show("task-a");
    await page.click(".routine-history-row");
    await act(async () => {
      events.forEach((listener) =>
        listener({ type: "schedules", schedules: [] }),
      );
    });
    await show("task-b");
    await act(async () => oldLoad.resolve([run]));
    await act(async () => receipt.reject(new Error("Task A receipt failed")));
    const notice = currentToasts().find(
      (value) => !value.closing && value.message.includes("mark this run"),
    )!;
    assert.ok(notice);
    await act(async () => {
      notice.action!.onSelect();
      notice.action!.onSelect();
      await Promise.resolve();
    });
    assert.equal(calls, 2, "concurrent Retry actions share one write");
    assert.equal(opens, 1, "Retry never navigates again");
    assert.equal(
      page.document.querySelector(".routine-history-row")?.getAttribute("href"),
      "/chat/chat-b",
    );
    assert.equal(page.document.querySelector('[role="alert"]'), null);
  } finally {
    await page.clean();
  }
});

test("cross review: a read receipt from a previous account must not retry through the next account's bridge", async () => {
  const receipt = deferred<void>();
  const run: RoutineRun = {
    id: "old-account-run",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "old-account-chat",
  };
  const page = await environment({
    routineRuns: async () => [run],
    markRoutineRunRead: () => receipt.promise,
  });
  let nextAccountCalls = 0;
  try {
    await page.render(
      wrap(
        createElement(RoutineHistory, {
          routine: { ...base, id: "old-account-task" },
          onOpenConversation() {},
        }),
      ),
    );
    await page.click(".routine-history-row");
    await act(async () => page.switchAccount("cross-review-account-b"));
    await page.render(
      createElement("p", { "data-account": "B" }, "New account"),
    );
    // App/AuthGate remount the account tree; the bridge now uses B's credentials.
    page.window.desktop.markRoutineRunRead = async () => {
      nextAccountCalls++;
    };
    await act(async () =>
      receipt.reject(new Error("Old account disconnected")),
    );
    const notice = currentToasts().find(
      (value) => !value.closing && value.message.includes("mark this run"),
    );
    if (notice)
      await act(async () => {
        notice.action!.onSelect();
        await Promise.resolve();
      });
    assert.equal(
      nextAccountCalls,
      0,
      "account A's retained Retry must not submit A's identifiers as account B",
    );
    assert.equal(
      notice,
      undefined,
      "a late old-account failure must not create a new-account toast",
    );
  } finally {
    await page.clean();
  }
});

test("cross review: notification permission resolving after unmount cannot recreate or mutate the closed editor", async () => {
  const permission = deferred<NotificationPermission>();
  const page = await environment();
  let asked = 0;
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Notification",
  );
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: {
      permission: "default",
      requestPermission: () => {
        asked++;
        return permission.promise;
      },
    },
  });
  try {
    await page.render(routinePage());
    await act(async () =>
      requestScheduleConfirmation({ blank: true, description: "" }),
    );
    await page.click(".routine-advanced-trigger");
    // The web's Advanced settings are tabs; the switch is under Notifications.
    await page.click('.routine-advanced-tabs [role="tab"]:last-child');
    // A new task starts with notifications on: off, then on again asks.
    const notify =
      '[role="switch"][aria-label="Notify me when this task finishes"]';
    await page.click(notify);
    assert.equal(asked, 0);
    await page.click(notify);
    assert.equal(asked, 1);
    await page.click(".task-cancel");
    // The switch was turned off first, so closing asks to discard that change.
    await page.click(".modal.confirm .primary");
    assert.equal(page.document.querySelector(".scheduled-task-dialog"), null);
    await act(async () => permission.resolve("granted"));
    assert.equal(
      page.document.querySelector(".scheduled-task-dialog"),
      null,
      "the permission callback recreated the canceled real editor",
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "Notification", descriptor);
    else Reflect.deleteProperty(globalThis, "Notification");
    await page.clean();
  }
});

test("cross review: an already displayed previous-account Retry becomes inert when the owner changes", async () => {
  const run: RoutineRun = {
    id: "old-toast-run",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "old-toast-chat",
  };
  const page = await environment({
    routineRuns: async () => [run],
    markRoutineRunRead: async () => {
      throw new Error("Account A offline");
    },
  });
  let writesAsB = 0;
  try {
    await page.render(
      wrap(
        createElement(RoutineHistory, {
          routine: { ...base, id: "old-toast-task" },
          onOpenConversation() {},
        }),
      ),
    );
    await page.click(".routine-history-row");
    const notice = currentToasts().find(
      (value) => !value.closing && value.message.includes("mark this run"),
    )!;
    assert.ok(notice?.action);
    await act(async () => page.switchAccount("cross-review-account-b"));
    await page.render(null);
    page.window.desktop.markRoutineRunRead = async () => {
      writesAsB++;
    };
    await act(async () => {
      notice.action!.onSelect();
      await Promise.resolve();
    });
    assert.equal(
      writesAsB,
      0,
      "a retained old action must check its original owner before writing",
    );
    assert.equal(
      currentToasts().some(
        (value) => !value.closing && value.message.includes("mark this run"),
      ),
      false,
    );
  } finally {
    await page.clean();
  }
});

test("cross review: permission results must not overwrite newer notification values from another location", async () => {
  const permission = deferred<NotificationPermission>();
  const page = await environment();
  const patches: Partial<RoutineDraft>[] = [];
  let asked = 0;
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Notification",
  );
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: {
      permission: "default",
      requestPermission: () => {
        asked++;
        return permission.promise;
      },
    },
  });
  try {
    await page.render(
      createElement(RoutineSettings, {
        draft: {
          ...draft,
          notifyOnCompletion: { push: false, email: false, slack: false },
        },
        onChange: (patch) => patches.push(patch),
      }),
    );
    await page.click(".routine-advanced-trigger");
    // The web's Advanced settings are tabs; the switch is under Notifications.
    await page.click('.routine-advanced-tabs [role="tab"]:last-child');
    await page.click(
      '[role="switch"][aria-label="Notify me when this task finishes"]',
    );
    assert.equal(asked, 1);
    await page.render(
      createElement(RoutineSettings, {
        draft: {
          ...draft,
          executionLocation: "local",
          notifyOnCompletion: { push: false, email: false, slack: true },
        },
        onChange: (patch) => patches.push(patch),
      }),
    );
    await act(async () => permission.resolve("granted"));
    assert.deepEqual(
      patches,
      [],
      "a permission request issued for the old location must expire",
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "Notification", descriptor);
    else Reflect.deleteProperty(globalThis, "Notification");
    await page.clean();
  }
});

test("cross review: text typed while a save is pending must not be silently discarded on success", async () => {
  const save = deferred<Routine>();
  let persisted: Routine | undefined;
  const page = await environment({
    listSchedules: async () => (persisted ? [persisted] : []),
    saveSchedule: async (input) => {
      savedName = input.name;
      persisted = await save.promise;
      return persisted;
    },
  });
  let savedName = "";
  try {
    await page.render(routinePage());
    await act(async () =>
      requestScheduleConfirmation({ blank: true, description: "" }),
    );
    await page.change('[aria-label="Name"]', "Submitted name");
    await page.change('[aria-label="Instructions"]', "Review the changes.");
    await page.event(page.document.querySelector("form")!, "submit");
    const name = page.document.querySelector<HTMLInputElement>(
      '[aria-label="Name"]',
    )!;
    if (!name.disabled && !name.readOnly)
      await page.change('[aria-label="Name"]', "Typed during save");
    const visibleName = name.value;
    await act(async () => save.resolve({ ...base, name: savedName }));
    assert.equal(savedName, "Submitted name");
    assert.equal(
      visibleName,
      savedName,
      "the pending editor accepted text which its successful save never persisted",
    );
    assert.equal(page.document.querySelector(".scheduled-task-dialog"), null);
    assert.equal(
      page.document.querySelector(".routine-card-name")?.textContent,
      savedName,
    );
  } finally {
    await page.clean();
  }
});

test("cross review: a pre-reset cloud list must not repopulate the next account's last-known cache", async () => {
  const oldList = deferred<Routine[]>();
  let failNext = false;
  const accountA: CloudCalls = {
    call: async () => oldList.promise,
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const accountB: CloudCalls = {
    call: async () => {
      if (failNext) throw new Error("Account B temporarily offline");
      return [{ ...base, id: "account-b-task" }];
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  let current = accountA;
  const cloud = new CloudRoutines(() => current);
  const list = cloud.route("listSchedules", async () => [])!;
  const first = list();
  await Promise.resolve();
  current = accountB;
  cloud.reset();
  await list();
  oldList.resolve([{ ...base, id: "account-a-task" }]);
  await first;
  failNext = true;
  const afterFailure = (await list()) as Routine[];
  assert.deepEqual(
    afterFailure.map((value) => value.id),
    ["account-b-task"],
    "late account A response replaced B's fallback cache",
  );
});

test("cross review: cloud capability catch preserves local availability but propagates remote failure", async () => {
  const reason = new Error("Remote settings disconnected");
  const client: CloudCalls = {
    call: async () => {
      throw reason;
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const cloud = new CloudRoutines(() => client);
  const read = cloud.route("routineCapabilities", async () => supported)!;
  assert.deepEqual(await read("local"), supported);
  assert.deepEqual(await read(), supported);
  await assert.rejects(read("remote"), (error) => error === reason);
});

test("cross review: lazy cloud initialization may reset the router without invalidating its first real request", async () => {
  const client: CloudCalls = {
    call: async (name) => (name === "listSchedules" ? [base] : supported),
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const lazyCloud = () => {
    let cold = true;
    const cloud = new CloudRoutines(() => {
      // createCloudSync.active() -> stop() -> router.reset() is synchronous.
      if (cold) {
        cold = false;
        cloud.reset();
      }
      return client;
    });
    return cloud;
  };
  const cloud = lazyCloud();
  const list = cloud.route("listSchedules", async () => [])!;
  assert.deepEqual(
    ((await list()) as Routine[]).map((value) => value.id),
    [base.id],
  );
  const capabilities = lazyCloud().route(
    "routineCapabilities",
    async () => unsupported,
  )!;
  assert.deepEqual(await capabilities("remote"), {
    ...supported,
    computerName: undefined,
  });
});
