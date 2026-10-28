import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { JSDOM } from "jsdom";
import { NotificationsSection } from "../../src/settings/tabs/General";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { desktopHost } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import {
  CodeEmailDispatcher,
  codeMailer,
} from "../../electron/account/code-email";
import { registerCodeEmailHandlers } from "../../electron/ipc/code-email";
import type { Conversation, Turn } from "../../shared/types";
import type { CodeEmailEvent } from "../../shared/code-email-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mounted(
  bridge: object,
  run: (
    document: Document,
    window: Window,
    render: (element: ReactElement) => Promise<void>,
  ) => Promise<void>,
) {
  const dom = new JSDOM("<html><body><main></main></body></html>", {
    url: "https://app.test",
  });
  const window = dom.window;
  window.desktop = {
    routineCapabilities: async () => ({ email: false }),
    ...bridge,
  } as never;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
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
      value,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.querySelector("main")!);
  try {
    await run(window.document, window as unknown as Window, async (element) => {
      await act(async () => root.render(element));
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const cloudHost = {
  ...desktopHost,
  capabilities: { ...desktopHost.capabilities, cloudCode: true },
};
const emailLabel = "Emails from Claudex Code cloud sessions";
function panel(
  save: (patch: unknown) => unknown = () => {},
  cloud = true,
  owner?: AppController,
) {
  const element = createElement(
    HostContext.Provider,
    { value: cloud ? cloudHost : desktopHost },
    createElement(NotificationsSection, {
      settings: { ...defaultSettings, notifyCodeEmail: false },
      save: save as never,
    }),
  );
  return owner
    ? createElement(AppContext.Provider, { value: owner }, element)
    : element;
}
const emailToggle = (document: Document) =>
  document.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${emailLabel}"]`,
  );

test("cloud email renders real loading, retry and availability; local and older hosts omit it", async () => {
  const status = deferred<{ available: boolean }>();
  let calls = 0;
  await mounted(
    {
      codeEmailStatus: () => {
        calls++;
        return calls === 1
          ? status.promise
          : Promise.resolve({ available: true });
      },
    },
    async (document, window, render) => {
      await render(panel());
      assert.ok(document.querySelector('[role="status"]'));
      assert.equal(emailToggle(document), null);
      await act(async () => status.reject(new Error("offline")));
      assert.match(document.body.textContent!, /Couldn’t load email/);
      await act(async () =>
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === "Retry")!
          .click(),
      );
      assert.ok(emailToggle(document));
      await render(panel(undefined, false));
      assert.equal(emailToggle(document), null);
      delete (window.desktop as any).codeEmailStatus;
      await render(panel());
      assert.equal(emailToggle(document), null);
    },
  );
});

test("cloud email rechecks eligibility, stays pending, saves independent preference and reports failed saves", async () => {
  const status = deferred<{ available: boolean }>();
  const pending = deferred<boolean>();
  const patches: unknown[] = [];
  let calls = 0;
  const { currentToasts } = await import("../../src/ui/toast-store");
  await mounted(
    {
      codeEmailStatus: () =>
        ++calls === 1 ? Promise.resolve({ available: true }) : status.promise,
    },
    async (document, _window, render) => {
      await render(
        panel((patch) => {
          patches.push(patch);
          return pending.promise;
        }),
      );
      await act(async () => emailToggle(document)!.click());
      assert.equal(emailToggle(document)!.disabled, true);
      assert.deepEqual(patches, []);
      await act(async () => status.resolve({ available: true }));
      assert.deepEqual(patches, [{ notifyCodeEmail: true }]);
      assert.equal(emailToggle(document)!.disabled, true);
      await act(async () => pending.reject(new Error("write failed")));
      assert.equal(emailToggle(document)!.disabled, false);
      assert.equal(
        emailToggle(document)!.getAttribute("aria-checked"),
        "false",
      );
      assert.ok(
        currentToasts().some(
          (toast) => toast.message === "Couldn’t save your change. Try again.",
        ),
      );
    },
  );
});

test("cloud email capability loss prevents a save and removes the ineligible row", async () => {
  let calls = 0;
  let writes = 0;
  await mounted(
    { codeEmailStatus: async () => ({ available: ++calls === 1 }) },
    async (document, _window, render) => {
      await render(
        panel(() => {
          writes++;
        }),
      );
      await act(async () => emailToggle(document)!.click());
      assert.equal(writes, 0);
      assert.equal(emailToggle(document), null);
    },
  );
});

test("cloud email status and authorization cannot cross account or bridge owners", async () => {
  const first = deferred<{ available: boolean }>();
  const second = deferred<{ available: boolean }>();
  let calls = 0;
  let writes = 0;
  const owner = { accountId: "old", controllerScope: {} } as AppController;
  await mounted(
    { codeEmailStatus: () => (++calls === 1 ? first.promise : second.promise) },
    async (document, window, render) => {
      await render(
        panel(
          () => {
            writes++;
          },
          true,
          owner,
        ),
      );
      owner.accountId = "new";
      await act(async () => first.resolve({ available: true }));
      assert.equal(emailToggle(document), null);
      await render(
        panel(
          () => {
            writes++;
          },
          true,
          owner,
        ),
      );
      await act(async () => second.resolve({ available: true }));
      assert.ok(emailToggle(document));
      const permission = deferred<{ available: boolean }>();
      window.desktop.codeEmailStatus = () => permission.promise;
      await act(async () => emailToggle(document)!.click());
      window.desktop = { ...window.desktop };
      await act(async () => permission.resolve({ available: true }));
      assert.equal(writes, 0);
      await render(createElement("div"));
    },
  );
});

const conversation = (id = "code") =>
  ({
    id,
    mode: "code",
    title: "Owned code",
    turns: [],
  }) as unknown as Conversation;
const turn = (status: Turn["status"], id = "turn1") => ({ id, status }) as Turn;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Code email dispatcher handles real event transitions and independent completion/action preferences", async () => {
  const code = conversation();
  const sent: CodeEmailEvent[] = [];
  let enabled = true;
  const dispatcher = new CodeEmailDispatcher({
    enabled: () => enabled,
    conversation: () => code,
    persist: async () => {},
    send: async (event) => {
      sent.push(event);
      return true;
    },
    failed(error) {
      throw error;
    },
  });
  const changed = () =>
    dispatcher.observe({ type: "conversation", conversation: code });
  code.turns = [turn("completed")];
  changed(); // Loading history must never mail old completions.
  code.turns = [turn("inProgress")];
  changed();
  code.turns = [turn("completed")];
  changed();
  changed();
  const approval = {
    id: 1,
    conversationId: code.id,
    method: "item/commandExecution/requestApproval",
    params: {},
  };
  dispatcher.observe({ type: "approval", approval });
  dispatcher.observe({ type: "approval", approval, reAlert: true });
  await flush();
  assert.deepEqual(
    sent.map((event) => event.outcome),
    ["completed", "needs_attention"],
  );
  enabled = false;
  code.turns = [turn("inProgress", "turn2")];
  changed();
  code.turns = [turn("failed", "turn2")];
  changed();
  await flush();
  assert.equal(sent.length, 2);
  enabled = true;
  let approvalId = 10;
  for (const extra of [
    { incognito: true },
    { archived: true },
    { linkedToComputer: true },
    { chatDeviceBinding: {} },
    { environment: { kind: "ssh", hostId: "h" } },
  ]) {
    Object.assign(code, extra);
    dispatcher.observe({
      type: "approval",
      approval: { ...approval, id: approvalId++ },
    });
    for (const key of Object.keys(extra)) delete (code as any)[key];
  }
  await flush();
  assert.equal(sent.length, 2);
  dispatcher.stop();
});

test("Code email cancels resolved approvals, disabled preferences and retired contexts while persistence is pending", async () => {
  for (const cancel of [
    "resolved",
    "disabled",
    "closed",
    "archived",
  ] as const) {
    const code = conversation();
    const persisted = deferred<void>();
    let enabled = true;
    let count = 0;
    const dispatcher = new CodeEmailDispatcher({
      enabled: () => enabled,
      conversation: () => code,
      persist: () => persisted.promise,
      send: async () => {
        count++;
        return true;
      },
      failed(error) {
        throw error;
      },
    });
    dispatcher.observe({
      type: "approval",
      approval: {
        id: 1,
        conversationId: code.id,
        method: "item/commandExecution/requestApproval",
        params: {},
      },
    });
    if (cancel === "resolved")
      dispatcher.observe({ type: "approval-resolved", id: 1 });
    if (cancel === "disabled") enabled = false;
    if (cancel === "closed") dispatcher.stop();
    if (cancel === "archived") code.archived = true;
    persisted.resolve();
    await flush();
    assert.equal(count, 0, cancel);
    dispatcher.stop();
  }
});

test("Code mail client authenticates to its own service and IPC honestly omits desktop support", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const mail = codeMailer(
    () => ({
      baseUrl: () => "https://service.test",
      authorized: (call) => call("account-token"),
    }),
    async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          code: 0,
          data: init?.method === "POST" ? { sent: true } : { available: true },
        }),
        { status: 200 },
      );
    },
  );
  assert.deepEqual(await mail.status(), { available: true });
  assert.equal(
    await mail.send({
      conversationId: "owned",
      eventId: "turn:1",
      outcome: "completed",
    }),
    true,
  );
  assert.equal(
    requests[0].url,
    "https://service.test/api/v1/claudex/code/email",
  );
  assert.equal(
    new Headers(requests[1].init?.headers).get("authorization"),
    "Bearer account-token",
  );
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
    conversationId: "owned",
    eventId: "turn:1",
    outcome: "completed",
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCodeEmailHandlers((name, handler) => handlers.set(name, handler), {});
  assert.deepEqual(await handlers.get("codeEmailStatus")!(), {
    available: false,
  });
  assert.deepEqual(await codeMailer(() => undefined).status(), {
    available: false,
  });
});
