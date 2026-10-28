import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { webHost, desktopHost } from "../../shared/host";
import type { Routine, RoutineCapabilities } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import { defaultSettings } from "../../electron/store/store";
import { HostContext } from "../../src/host/HostContext";
import { RoutineCard } from "../../src/collections/routines/RoutineCard";
import { ScheduledTaskDialog } from "../../src/collections/routines/ScheduledTaskDialog";
import {
  RoutineSettings,
  validRoutineCapabilities,
} from "../../src/collections/routines/RoutineSettings";
import {
  RoutineHistory,
  openRoutineRun,
} from "../../src/collections/routines/RoutineHistory";
import {
  newDraft,
  type RoutineDraft,
} from "../../src/collections/routines/routine-draft";
import {
  acknowledgeRoutineRun,
  activateRoutineReadAccount,
} from "../../src/collections/routines/routine-read-receipts";
import { currentToasts, dismissAllToasts } from "../../src/ui/toast-store";

const now = Date.now();
const routine: Routine = {
  id: "synthetic-round3",
  name: "Synthetic task",
  prompt: "Synthetic instruction.",
  mode: "cowork",
  providerId: "p",
  model: "Opus",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:59" },
  nextRunAt: now + 86_400_000,
  createdAt: now,
  updatedAt: now,
  executionLocation: "remote",
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
const draft: RoutineDraft = {
  ...newDraft(now, undefined, "cowork"),
  id: routine.id,
  name: routine.name,
  prompt: routine.prompt,
  permission: "auto",
  executionLocation: "remote",
};
const capabilities: RoutineCapabilities = {
  remote: false,
  email: false,
  slack: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const web = (child: ReturnType<typeof createElement>) =>
  createElement(HostContext.Provider, { value: webHost }, child);

async function dom(bridge: Partial<Window["desktop"]> = {}) {
  const releaseAccount = activateRoutineReadAccount("synthetic-round3-account");
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  document.documentElement.dataset.motion = "reduced";
  (document as unknown as { oninput: null }).oninput = null;
  window.desktop = {
    routineCapabilities: async () => capabilities,
    routineRuns: async () => [],
    onEvent: () => () => {},
    ...bridge,
  } as never;
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
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
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const prototype = window.HTMLInputElement.prototype;
  const inputType = Object.getOwnPropertyDescriptor(prototype, "type");
  Object.defineProperty(prototype, "type", {
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
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const render = async (child: ReturnType<typeof createElement>) =>
    act(async () => {
      root.render(child);
    });
  const event = async (
    target: Element | Document,
    type: string,
    extra: Record<string, unknown> = {},
  ) => {
    const next = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(next, extra);
    await act(async () => {
      target.dispatchEvent(next);
    });
    return next;
  };
  const change = async (selector: string, value: string) => {
    const input = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(selector)!;
    const proto =
      input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const click = async (selector: string) =>
    event(document.querySelector(selector)!, "click", { button: 0 });
  const clean = async () => {
    await act(async () => {
      root.unmount();
      releaseAccount();
      dismissAllToasts();
    });
    if (inputType) Object.defineProperty(prototype, "type", inputType);
    else Reflect.deleteProperty(prototype, "type");
    if (focus)
      Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { window, document, render, event, change, click, clean };
}

test("saved web task cards use real detail links and a distinct More action while native cards retain their own layout", () => {
  const props = {
    routine,
    off: false,
    starting: false,
    menuOpen: false,
    onEdit() {},
    onMenu() {},
  };
  const { document } = parseHTML(
    renderToStaticMarkup(web(createElement(RoutineCard, props))),
  );
  assert.equal(
    document.querySelector("[data-primary]")?.getAttribute("href"),
    `/scheduled-task/${routine.id}`,
  );
  assert.equal(
    document.querySelector("[data-primary]")?.textContent,
    routine.name,
  );
  assert.equal(
    document.querySelector(".routine-card-description[data-no-translate]")
      ?.textContent,
    routine.prompt,
  );
  assert.match(
    document.querySelector(".routine-card-footer")!.textContent!,
    /Active·Daily at 9:59 AM/,
  );
  assert.ok(document.querySelector(".routine-card-active-dot"));
  assert.equal(
    document.querySelector(".routine-more")?.getAttribute("aria-label"),
    `More options for ${routine.name}`,
  );
  assert.equal(
    document
      .querySelector(".routine-more [data-icon]")
      ?.getAttribute("data-icon"),
    "DotsVertical",
  );
  assert.equal(document.querySelector(".routine-card button"), null);
  assert.equal(document.querySelector(".routine-tile"), null);
  const native = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: desktopHost },
      createElement(RoutineCard, props),
    ),
  );
  assert.match(native, /<button[^]*?data-primary/);
  assert.match(native, /routine-tile/);
  assert.match(native, /More options for Synthetic task/);
});

test("web task links retain modifier navigation and independent menu actions for manual, once, remote and security tasks", async () => {
  const page = await dom();
  let opens = 0,
    menus = 0;
  try {
    for (const patch of [
      {},
      { repeat: { kind: "manual" as const } },
      { repeat: { kind: "once" as const, at: now + 86_400_000 } },
      { securityReview: true },
      { executionLocation: "remote" as const },
    ]) {
      await page.render(
        web(
          createElement(RoutineCard, {
            routine: { ...routine, ...patch },
            off: false,
            starting: false,
            menuOpen: false,
            onEdit() {
              opens++;
            },
            onMenu() {
              menus++;
            },
          }),
        ),
      );
      const link = page.document.querySelector("[data-primary]")!;
      for (const extra of [
        { ctrlKey: true },
        { metaKey: true },
        { button: 1 },
      ]) {
        const before = opens;
        assert.equal(
          (await page.event(link, "click", { button: 0, ...extra }))
            .defaultPrevented,
          false,
        );
        assert.equal(opens, before);
      }
      assert.equal(
        (await page.event(link, "click", { button: 0 })).defaultPrevented,
        true,
      );
      const before = opens;
      await page.click(".routine-more");
      assert.equal(opens, before);
    }
    assert.equal(opens, 5);
    assert.equal(menus, 5);
  } finally {
    await page.clean();
  }
});

test("scheduled editor asks before dirty Close, Cancel, Escape and backdrop, and keeps values after declining discard", async () => {
  for (const close of ["header", "cancel", "escape", "backdrop"]) {
    const page = await dom();
    let value = { ...draft },
      closes = 0;
    const render = () =>
      page.render(
        createElement(ScheduledTaskDialog, {
          draft: value,
          settings,
          onChange(next) {
            value = next;
            void render();
          },
          onCancel() {
            closes++;
          },
          onSave: async () => {},
        }),
      );
    try {
      await render();
      await page.change('[aria-label="Name"]', "Changed task");
      if (close === "header")
        await page.click(
          '.scheduled-task-dialog > header [aria-label="Close"]',
        );
      else if (close === "cancel") await page.click(".task-cancel");
      else if (close === "escape")
        await page.event(page.document, "keydown", { key: "Escape" });
      else
        await page.event(page.document.querySelector(".overlay")!, "mousedown");
      assert.equal(closes, 0, close);
      assert.ok(
        page.document.querySelector(
          '[role="alertdialog"][aria-label="Discard unsaved changes?"]',
        ),
        close,
      );
      await page.click('[role="alertdialog"] .secondary');
      assert.equal(page.document.querySelector('[role="alertdialog"]'), null);
      assert.equal(
        page.document.querySelector<HTMLInputElement>('[aria-label="Name"]')!
          .value,
        "Changed task",
      );
      await page.click(".task-cancel");
      await page.click('[role="alertdialog"] .primary');
      assert.equal(closes, 1);
    } finally {
      await page.clean();
    }
  }
});

test("scheduled editor closes pristine drafts, locks every dismissal while saving, and retains a rejected save for retry", async () => {
  const page = await dom();
  const save = deferred<void>();
  let value = { ...draft },
    closes = 0,
    saves = 0;
  const render = () =>
    page.render(
      createElement(ScheduledTaskDialog, {
        draft: value,
        settings,
        onChange(next) {
          value = next;
          void render();
        },
        onCancel() {
          closes++;
        },
        onSave() {
          saves++;
          return save.promise;
        },
      }),
    );
  try {
    await render();
    await page.click(".task-cancel");
    assert.equal(closes, 1);
    await page.change('[aria-label="Name"]', "Saved name");
    await page.event(page.document.querySelector("form")!, "submit");
    assert.equal(saves, 1);
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-cancel")!.disabled,
      true,
    );
    for (const selector of [
      '[aria-label="Name"]',
      '[aria-label="Instructions"]',
    ])
      assert.equal(
        page.document.querySelector<HTMLInputElement>(selector)!.disabled,
        true,
        selector,
      );
    assert.equal(
      page.document
        .querySelector("fieldset.task-form-body")!
        .hasAttribute("disabled"),
      true,
    );
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-model")!.disabled,
      true,
    );
    await page.click('.scheduled-task-dialog > header [aria-label="Close"]');
    await page.event(page.document, "keydown", { key: "Escape" });
    await page.event(page.document.querySelector(".overlay")!, "mousedown");
    await page.click(".task-cancel");
    await page.event(page.document.querySelector("form")!, "submit");
    assert.equal(closes, 1);
    assert.equal(saves, 1);
    assert.equal(page.document.querySelector('[role="alertdialog"]'), null);
    await act(async () => save.reject(new Error("Synthetic save rejected")));
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Synthetic save rejected/,
    );
    assert.equal(
      page.document.querySelector<HTMLInputElement>('[aria-label="Name"]')!
        .value,
      "Saved name",
    );
    assert.equal(
      page.document.querySelector<HTMLButtonElement>(".task-save")!.disabled,
      false,
    );
    assert.equal(
      page.document.querySelector<HTMLInputElement>('[aria-label="Name"]')!
        .disabled,
      false,
    );
    await page.change('[aria-label="Name"]', "Retried name");
    assert.equal(value.name, "Retried name");
  } finally {
    await page.clean();
  }
});

test("task capability failures are explicit, retryable and distinct from real unsupported values", async () => {
  const answers = [
    Promise.reject(new Error("Synthetic capabilities failure")),
    Promise.resolve({ remote: false, email: true, slack: true }),
    Promise.reject(new Error("Other location failed")),
    Promise.reject(new Error("Retry failed")),
    Promise.resolve(capabilities),
  ];
  // Avoid scheduling the rejection before the component attaches its handler.
  answers.forEach((answer) => {
    void answer.catch(() => {});
  });
  let calls = 0;
  const page = await dom({ routineCapabilities: () => answers[calls++] });
  const value = {
    ...draft,
    notifyOnCompletion: { push: true, email: true, slack: true },
  };
  try {
    await page.render(
      createElement(RoutineSettings, { draft: value, onChange() {} }),
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Synthetic capabilities failure/,
    );
    await page.click('[role="alert"] button');
    await page.click(".routine-advanced-trigger");
    assert.equal(page.document.querySelector('[role="alert"]'), null);
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
    // Switch location and back: a retry preserves only the correct location's cache.
    await page.render(
      createElement(RoutineSettings, {
        draft: { ...value, executionLocation: "local" },
        onChange() {},
      }),
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Other location failed/,
    );
    assert.doesNotMatch(
      page.document.querySelector(".routine-notification-channels")!
        .textContent!,
      /Email|Slack/,
    );
    await page.render(
      createElement(RoutineSettings, { draft: value, onChange() {} }),
    );
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Retry failed/,
    );
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
    await page.click('[role="alert"] button');
    assert.equal(page.document.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(
      page.document.querySelector(".routine-notification-channels")!
        .textContent!,
      /Email|Slack/,
    );
    assert.equal(calls, 5);
  } finally {
    await page.clean();
  }
});

test("late capability results cannot overwrite another location or update an unmounted editor", async () => {
  const old = deferred<RoutineCapabilities>();
  const page = await dom({
    routineCapabilities: (location) =>
      location === "remote" ? old.promise : Promise.resolve(capabilities),
  });
  try {
    await page.render(
      createElement(RoutineSettings, {
        draft: {
          ...draft,
          notifyOnCompletion: { push: true, email: true, slack: true },
        },
        onChange() {},
      }),
    );
    await page.render(
      createElement(RoutineSettings, {
        draft: {
          ...draft,
          executionLocation: "local",
          notifyOnCompletion: { push: true, email: true, slack: true },
        },
        onChange() {},
      }),
    );
    await act(async () =>
      old.resolve({ remote: true, email: true, slack: true }),
    );
    await page.click(".routine-advanced-trigger");
    assert.doesNotMatch(
      page.document.querySelector(".routine-notification-channels")!
        .textContent!,
      /Email|Slack/,
    );
  } finally {
    await page.clean();
  }
  for (const value of [
    null,
    undefined,
    {},
    { remote: true, email: "yes", slack: false },
  ])
    assert.equal(validRoutineCapabilities(value), false);
  assert.equal(validRoutineCapabilities(capabilities), true);
});

test("an unmounted capability panel ignores the late response before reading its fields", async () => {
  const answer = deferred<RoutineCapabilities>();
  const page = await dom({ routineCapabilities: () => answer.promise });
  await page.render(createElement(RoutineSettings, { draft, onChange() {} }));
  await page.clean();
  let reads = 0;
  await act(async () =>
    answer.resolve({
      get remote() {
        reads++;
        return true;
      },
      get email() {
        reads++;
        return true;
      },
      get slack() {
        reads++;
        return true;
      },
    }),
  );
  assert.equal(reads, 0);
});

test("run receipt requests are shared and a persistent Retry remains usable after navigation without reopening a chat", async () => {
  const page = await dom();
  const receipt = deferred<void>();
  let calls = 0,
    opens = 0,
    reads = 0,
    failures = 0;
  const run: RoutineRun = {
    id: "receipt-run",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "synthetic-chat",
  };
  let fail = true;
  const acknowledge = () => {
    calls++;
    return calls === 1
      ? receipt.promise
      : fail
        ? Promise.reject(new Error("Still offline"))
        : Promise.resolve();
  };
  try {
    const first = openRoutineRun(
      routine.id,
      run,
      () => opens++,
      acknowledge,
      () => reads++,
      () => failures++,
    );
    const second = openRoutineRun(
      routine.id,
      run,
      () => opens++,
      acknowledge,
      () => reads++,
      () => failures++,
    );
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(calls, 1);
    assert.equal(opens, 2);
    await act(async () => {
      receipt.reject(new Error("Synthetic offline"));
      await Promise.all([first, second]);
    });
    assert.equal(failures, 2);
    assert.equal(reads, 0);
    const retry = currentToasts().find(
      (toast) => !toast.closing && toast.message.includes("mark this run"),
    )!;
    assert.equal(retry.action?.label, "Retry");
    fail = false;
    await act(async () => {
      retry.action!.onSelect();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(calls, 2);
    assert.equal(opens, 2);
    assert.equal(
      currentToasts().some(
        (toast) => !toast.closing && toast.message.includes("mark this run"),
      ),
      false,
    );
    await openRoutineRun(
      routine.id,
      { ...run, status: "running" },
      () => opens++,
      acknowledge,
      () => {},
      () => {},
    );
    assert.equal(
      calls,
      2,
      "an unfinished run cannot be marked as a read completion",
    );
  } finally {
    await page.clean();
  }
});

test("history read state is optimistic, reconciles with real load events and rolls back failed receipts until retry succeeds", async () => {
  const receipt = deferred<void>();
  let nextRead = 0,
    events: ((event: { type: "schedules" }) => void)[] = [];
  const run: RoutineRun = {
    id: "optimistic-run",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "synthetic-chat",
  };
  const page = await dom({
    routineRuns: async () => [
      { ...run, ...(nextRead ? { readAt: nextRead } : {}) },
    ],
    markRoutineRunRead: () => receipt.promise,
    onEvent(listener) {
      events.push(listener as never);
      return () => {
        events = events.filter((value) => value !== listener);
      };
    },
  });
  try {
    await page.render(
      web(createElement(RoutineHistory, { routine, onOpenConversation() {} })),
    );
    assert.ok(page.document.querySelector(".routine-run-unread"));
    await page.click(".routine-history-row");
    assert.equal(page.document.querySelector(".routine-run-unread"), null);
    await act(async () => {
      events.forEach((listener) => listener({ type: "schedules" }));
    });
    assert.equal(
      page.document.querySelector(".routine-run-unread"),
      null,
      "a pending receipt keeps its optimistic read during a list refresh",
    );
    await act(async () =>
      receipt.reject(new Error("Synthetic receipt rejected")),
    );
    assert.ok(page.document.querySelector(".routine-run-unread"));
    assert.match(
      page.document.querySelector('[role="alert"]')!.textContent!,
      /Synthetic receipt rejected/,
    );
    nextRead = now + 1;
    await act(async () => {
      await acknowledgeRoutineRun(routine.id, run.id, async () => {});
    });
    assert.equal(page.document.querySelector(".routine-run-unread"), null);
    assert.equal(page.document.querySelector('[role="alert"]'), null);
  } finally {
    await page.clean();
  }
});

test("a late failed receipt cannot undo a real read or replace newer history data", async () => {
  const receipt = deferred<void>();
  const older = deferred<RoutineRun[]>(),
    newer = deferred<RoutineRun[]>();
  let load = 0,
    notify: (() => void) | undefined;
  const run: RoutineRun = {
    id: "monotonic-read",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "synthetic-chat",
  };
  const page = await dom({
    routineRuns: async () =>
      ++load === 1 ? [run] : load === 2 ? older.promise : newer.promise,
    markRoutineRunRead: () => receipt.promise,
    onEvent(listener) {
      notify = () => listener({ type: "schedules", schedules: [] });
      return () => {
        notify = undefined;
      };
    },
  });
  try {
    await page.render(
      web(createElement(RoutineHistory, { routine, onOpenConversation() {} })),
    );
    await page.click(".routine-history-row");
    await act(async () => {
      notify!();
      await Promise.resolve();
      notify!();
    });
    await act(async () =>
      newer.resolve([
        { ...run, readAt: now + 1 },
        {
          ...run,
          id: "newer-second-run",
          conversationId: "newer-chat",
          readAt: now + 1,
        },
      ]),
    );
    await act(async () => older.resolve([run]));
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      2,
    );
    await act(async () => receipt.reject(new Error("Late receipt failed")));
    assert.equal(
      page.document.querySelectorAll(".routine-history-row").length,
      2,
    );
    assert.equal(
      page.document.querySelector(".routine-run-unread"),
      null,
      "server-confirmed reads survive a failed redundant receipt",
    );
  } finally {
    await page.clean();
  }
});

test("receipt recovery after leaving the history panel retries only the write and leaves the next page alone", async () => {
  const receipt = deferred<void>();
  let calls = 0,
    opens = 0;
  const run: RoutineRun = {
    id: "receipt-after-unmount",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "synthetic-chat",
  };
  const page = await dom({
    routineRuns: async () => [run],
    markRoutineRunRead: () => {
      calls++;
      return calls === 1 ? receipt.promise : Promise.resolve();
    },
  });
  try {
    await page.render(
      web(
        createElement(RoutineHistory, {
          routine,
          onOpenConversation() {
            opens++;
          },
        }),
      ),
    );
    await page.click(".routine-history-row");
    await page.render(
      createElement("p", { "data-next-page": true }, "Another collection"),
    );
    await act(async () =>
      receipt.reject(new Error("Late disconnected receipt")),
    );
    assert.equal(
      page.document.querySelector("[data-next-page]")?.textContent,
      "Another collection",
    );
    const notice = currentToasts().find(
      (toast) => !toast.closing && toast.message.includes("mark this run"),
    )!;
    await act(async () => {
      notice.action!.onSelect();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(calls, 2);
    assert.equal(opens, 1);
    assert.equal(
      page.document.querySelector("[data-next-page]")?.textContent,
      "Another collection",
    );
    assert.equal(page.document.querySelector(".routine-history"), null);
  } finally {
    await page.clean();
  }
});
