import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { NotificationsSection } from "../../src/settings/tabs/General";
import {
  CapabilitiesTab,
  NetworkEgress,
} from "../../src/settings/tabs/Capabilities";
import { defaultSettings } from "../../electron/store/store";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { desktopHost, webHost } from "../../shared/host";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { codePermissionNotificationAllowed } from "../../shared/code-notifications";
import {
  userNetworkPolicy,
  compilePolicy,
  resolveAllowed,
} from "../../runner/src/net-policy-compile";
import type { Approval, Conversation } from "../../shared/types";

async function mounted(
  element: ReactElement,
  run: (
    document: Document,
    window: Window,
    render: (next: ReactElement) => Promise<void>,
  ) => Promise<void>,
) {
  const dom = new JSDOM("<html><body><main></main></body></html>", {
    url: "https://app.test",
  });
  const { window } = dom;
  window.desktop = {
    routineCapabilities: async () => ({ email: false }),
    getNotificationAuthorizationStatus: async () => "authorized",
    requestNotificationAuthorization: async () => "granted",
    openNotificationSettings: async () => {},
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
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.querySelector("main")!);
  const render = async (next: ReactElement) => {
    await act(async () => root.render(next));
  };
  try {
    await render(element);
    await run(window.document, window as unknown as Window, render);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const request: Approval = {
  id: 1,
  conversationId: "code",
  method: "item/commandExecution/requestApproval",
  params: { command: "ls" },
};
const code = {
  id: "code",
  title: "Actual task",
  mode: "code",
  turns: [],
} as unknown as Conversation;

function enter(input: HTMLInputElement, value: string, window: Window) {
  const setter = Object.getOwnPropertyDescriptor(
    (window as any).HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
}

test("Code permission preference is typed and independent of completion, question and Cowork channels", () => {
  assert.equal(
    preferenceFields.notifyCodePermissions.safeParse(false).success,
    true,
  );
  assert.equal(
    preferenceFields.notifyCodePermissions.safeParse("false").success,
    false,
  );
  const settings = {
    notifyCodePermissions: false,
    notifyResponses: true,
    notifyCode: true,
  };
  assert.equal(
    codePermissionNotificationAllowed(settings, code, request),
    false,
  );
  assert.equal(
    codePermissionNotificationAllowed(settings, { mode: "cowork" }, request),
    true,
  );
  assert.equal(
    codePermissionNotificationAllowed(settings, code, {
      ...request,
      method: "item/tool/requestUserInput",
    }),
    true,
  );
  assert.equal(
    codePermissionNotificationAllowed(
      { ...settings, notifyCodePermissions: true },
      code,
      request,
    ),
    true,
  );
});

test("General renders eligible Code approval control and omits unsupported email/update stubs", () => {
  const render = (host: typeof desktopHost) =>
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: host },
        createElement(NotificationsSection, {
          settings: defaultSettings,
          save() {},
        }),
      ),
    );
  const desktop = render(desktopHost);
  const dom = new JSDOM(desktop).window.document;
  assert.ok(
    dom.querySelector('[role="switch"][aria-label="Code permission requests"]'),
  );
  assert.equal(
    dom.querySelector('[aria-label="Emails from Claudex Code cloud sessions"]'),
    null,
  );
  assert.ok(
    dom.querySelector('[role="switch"][aria-label="Code notifications"]'),
  );
  assert.equal(
    new JSDOM(render(webHost)).window.document.querySelector(
      '[aria-label="Code permission requests"]',
    ),
    null,
  );
});

test("Code approval save remains pending and asks notification permission before enabling", async () => {
  let finish!: (result: boolean) => void;
  const changes: unknown[] = [];
  const save = (patch: unknown) => {
    changes.push(patch);
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  await mounted(
    createElement(NotificationsSection, {
      settings: { ...defaultSettings, notifyCodePermissions: false },
      save,
    }),
    async (document) => {
      const control = document.querySelector<HTMLButtonElement>(
        '[aria-label="Code permission requests"]',
      )!;
      await act(async () => control.click());
      assert.deepEqual(changes, [{ notifyCodePermissions: true }]);
      assert.equal(control.disabled, true);
      await act(async () => control.click());
      assert.equal(changes.length, 1);
      await act(async () => finish(false));
      assert.equal(control.disabled, false);
      assert.equal(control.getAttribute("aria-checked"), "false");
    },
  );
});

test("denied desktop notification permission keeps the distinct Code preference unsaved", async () => {
  const changes: unknown[] = [];
  await mounted(
    createElement(NotificationsSection, {
      settings: { ...defaultSettings, notifyCodePermissions: false },
      save: (patch) => {
        changes.push(patch);
      },
    }),
    async (document, window) => {
      let opened = 0;
      window.desktop.getNotificationAuthorizationStatus = async () => "denied";
      window.desktop.openNotificationSettings = async () => {
        opened++;
      };
      const control = document.querySelector<HTMLButtonElement>(
        '[aria-label="Code permission requests"]',
      )!;
      await act(async () => control.click());
      assert.equal(opened, 1);
      assert.deepEqual(changes, []);
      assert.equal(control.getAttribute("aria-checked"), "false");
      assert.equal(control.disabled, false);
    },
  );
});

test("Capabilities on a Mac offers Chat execution and the local domain controls", () => {
  const dom = new JSDOM(
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: desktopHost },
        createElement(CapabilitiesTab, {
          settings: defaultSettings,
          save() {},
          goTo() {},
          onError() {},
          platform: "darwin",
          engine: { state: "ready" },
        }),
      ),
    ),
  ).window.document;
  assert.equal(
    dom.querySelector('[role="switch"][aria-label="Run code in the cloud"]'),
    null,
  );
  // Chat's code reaches the network through the local sandbox's profile
  // (settings 25: shared/local-egress.ts).
  assert.ok(dom.querySelector('[aria-label="Domain allowlist"]'));
  assert.ok(dom.querySelector("#cap-domains"));
  const execution = dom.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Code execution and file creation"]',
  )!;
  assert.equal(execution.disabled, false);
  assert.equal(execution.getAttribute("aria-checked"), "true");
  assert.match(dom.body.textContent!, /Applies to Chat/);
  const artifacts = dom.querySelector<HTMLButtonElement>(
    '[aria-label="Artifacts"]',
  )!;
  assert.equal(artifacts.disabled, true);
  assert.equal(artifacts.getAttribute("aria-checked"), "true");
});

test("real sandbox domain changes retain rejected input, disable pending edits, then save normalized domains", async () => {
  let finish!: (result: boolean) => void;
  const changes: unknown[] = [];
  const save = (patch: unknown) => {
    changes.push(patch);
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  await mounted(
    createElement(NetworkEgress, {
      settings: defaultSettings,
      ceiling: "full",
      save,
    }),
    async (document, window) => {
      const input = document.querySelector<HTMLInputElement>("#cap-domains")!;
      const add = document.querySelector<HTMLButtonElement>(
        ".capabilities-allowlist-add button",
      )!;
      assert.equal(add.disabled, true);
      await act(async () => enter(input, "API.Example.com", window));
      assert.equal(add.disabled, false);
      await act(async () => add.click());
      assert.deepEqual(changes, [{ egressDomains: ["api.example.com"] }]);
      assert.equal(input.disabled, true);
      assert.equal(add.disabled, true);
      await act(async () => finish(false));
      assert.equal(input.value, "API.Example.com");
      assert.match(
        document.querySelector('[role="alert"]')!.textContent!,
        /Couldn’t save/,
      );
      await act(async () => add.click());
      await act(async () => finish(true));
      assert.equal(input.value, "");
      assert.equal(document.querySelector('[role="alert"]'), null);
    },
  );
});

test("server network-off policy hides editable domain controls even with an enabled preference", () => {
  const dom = new JSDOM(
    renderToStaticMarkup(
      createElement(NetworkEgress, {
        settings: {
          ...defaultSettings,
          networkEgress: true,
          egressAllowlist: "all",
        },
        ceiling: "none",
        save() {
          throw new Error("must not save");
        },
      }),
    ),
  ).window.document;
  const control = dom.querySelector<HTMLButtonElement>(
    '[aria-label="Allow network egress"]',
  )!;
  assert.equal(control.disabled, true);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(dom.querySelector("#cap-domains"), null);
});

test("saved network preferences narrow actual resolver permissions without opening server-denied targets", async () => {
  const policy = compilePolicy(
    userNetworkPolicy(
      { level: "full", deniedHosts: ["blocked.example.com"] },
      {
        enabled: true,
        allowlist: "none",
        domains: ["api.example.com", "blocked.example.com"],
      },
    ),
  );
  const resolver = async () => ["93.184.215.14"];
  assert.equal(
    (await resolveAllowed(policy, "api.example.com", resolver)).ok,
    true,
  );
  assert.equal(policy.checkHost("other.example.com", 443).ok, false);
  assert.equal(policy.checkHost("blocked.example.com", 443).ok, false);
  const off = compilePolicy(
    userNetworkPolicy(
      { level: "full" },
      { enabled: false, allowlist: "all", domains: ["api.example.com"] },
    ),
  );
  assert.equal(off.checkHost("api.example.com", 443).ok, false);
});

test("browser Code approval delivery respects the preference, OS permission, visibility, deduplication and resolution", async () => {
  const {
    notifyCodePermission,
    withdrawCodePermission,
    clearCodePermissionNotifications,
  } = await import("../../src/app/web-notifications");
  await mounted(createElement("div"), async (document, window) => {
    class Banner {
      static permission = "granted";
      static all: Banner[] = [];
      closed = false;
      onclick?: () => void;
      onclose?: () => void;
      constructor(
        public title: string,
        public options: unknown,
      ) {
        Banner.all.push(this);
      }
      close() {
        this.closed = true;
        this.onclose?.();
      }
    }
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "Notification",
    );
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: Banner,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    let opened = "";
    const open = (id: string) => {
      opened = id;
    };
    window.focus = () => {};
    try {
      notifyCodePermission(
        request,
        code,
        { notifyCodePermissions: false },
        false,
        open,
      );
      notifyCodePermission(
        request,
        code,
        { notifyCodePermissions: true },
        true,
        open,
      );
      Banner.permission = "denied";
      notifyCodePermission(
        request,
        code,
        { notifyCodePermissions: true },
        false,
        open,
      );
      assert.equal(Banner.all.length, 0);
      Banner.permission = "granted";
      notifyCodePermission(
        request,
        code,
        { notifyCodePermissions: true },
        false,
        open,
      );
      notifyCodePermission(
        request,
        code,
        { notifyCodePermissions: true },
        false,
        open,
      );
      assert.equal(Banner.all.length, 1);
      Banner.all[0].onclick?.();
      assert.equal(opened, code.id);
      assert.equal(Banner.all[0].closed, true);
      notifyCodePermission(
        { ...request, id: 2 },
        code,
        { notifyCodePermissions: true },
        false,
        open,
      );
      withdrawCodePermission(2);
      assert.equal(Banner.all[1].closed, true);
      notifyCodePermission(
        { ...request, id: 3, method: "item/tool/requestUserInput" },
        code,
        { notifyCodePermissions: true },
        false,
        open,
      );
      assert.equal(Banner.all.length, 2);
      notifyCodePermission(
        { ...request, id: 4 },
        code,
        { notifyCodePermissions: true },
        false,
        open,
      );
      clearCodePermissionNotifications();
      assert.equal(Banner.all[2].closed, true);
    } finally {
      if (previous) Object.defineProperty(globalThis, "Notification", previous);
      else Reflect.deleteProperty(globalThis, "Notification");
    }
  });
});

test("Electron delivery independently suppresses Code approval banners while keeping Cowork and questions working", async () => {
  const { registerHooks } = await import("node:module");
  const { EventEmitter } = await import("node:events");
  const notices: any[] = [];
  class Banner {
    static isSupported = () => true;
    callbacks = new Map<string, () => void>();
    constructor(public options: unknown) {}
    on(name: string, handler: () => void) {
      this.callbacks.set(name, handler);
    }
    show() {
      notices.push(this);
    }
    close() {
      this.callbacks.get("close")?.();
    }
  }
  const fake = {
    app: {
      on() {},
      off() {},
      name: "Claudex",
      dock: {
        setBadge() {},
        setMenu() {},
        bounce() {
          return 1;
        },
        cancelBounce() {},
      },
    },
    Menu: { buildFromTemplate: (items: unknown) => items },
    Notification: Banner,
    powerMonitor: Object.assign(new EventEmitter(), {
      getSystemIdleTime: () => 0,
      getSystemIdleState: () => "active",
      isOnBatteryPower: () => false,
    }),
    globalShortcut: { register: () => true, unregister() {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    powerSaveBlocker: { start: () => 1, stop() {} },
    Tray: class {},
  };
  (globalThis as any).__b25Electron = fake;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "electron")
        return {
          shortCircuit: true,
          url:
            "data:text/javascript," +
            encodeURIComponent(
              "const e=globalThis.__b25Electron;" +
                Object.keys(fake)
                  .map((name) => `export const ${name}=e.${name};`)
                  .join("") +
                "export default e;",
            ),
        };
      return next(specifier, context);
    },
  });
  try {
    const { DesktopIntegration } =
      await import("../../electron/app/desktop-integration");
    const conversation = {
      ...code,
      title: "Actual task",
      cwd: "/tmp/code",
      turns: [],
    };
    const settings = {
      ...defaultSettings,
      notifyCodePermissions: false,
      notificationLevels: { permission: "banner", question: "banner" },
      drawAttention: false,
    } as typeof defaultSettings;
    const integration = new DesktopIntegration({
      window: () =>
        ({ isDestroyed: () => false, isFocused: () => false }) as never,
      settings: () => settings,
      conversations: () => [conversation],
      command() {},
      trayIcon: "/missing",
    });
    (integration as any).ready = true;
    integration.observeApproval(request);
    assert.equal(notices.length, 0);
    settings.notifyCodePermissions = true;
    integration.observeApproval({ ...request, id: 2 });
    assert.equal(notices.length, 1);
    settings.notifyCodePermissions = false;
    integration.observeApproval({
      ...request,
      id: 3,
      method: "item/tool/requestUserInput",
      params: { questions: [{ question: "Which target?" }] },
    });
    assert.equal(notices.length, 2);
    conversation.mode = "cowork";
    integration.observeApproval({
      ...request,
      id: 4,
      method: "mcpServer/elicitation/request",
    });
    await new Promise((resolve) => setTimeout(resolve, 330));
    assert.equal(notices.length, 3);
    conversation.mode = "code";
    const turn = {
      id: "t",
      prompt: "go",
      items: [],
      attachments: [],
      createdAt: 1,
      status: "inProgress",
    };
    conversation.turns = [turn] as never;
    integration.observeConversation(conversation);
    turn.status = "completed";
    integration.observeConversation(conversation);
    assert.equal(
      notices.length,
      4,
      "Code completions remain independent of the approval preference",
    );
    integration.stop();
  } finally {
    hook.deregister();
    delete (globalThis as any).__b25Electron;
  }
});

// Deferred saves exercise the rendered controls. A controller ref or bridge
// can change before React publishes the next account's props.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const ownerChanges = [
  "account",
  "bridge",
  "controller",
  "controller-ref",
] as const;
type OwnerChange = (typeof ownerChanges)[number];
function ownerHarness() {
  const ref = { current: undefined as AppController | undefined };
  let app = {
    accountId: "account-0",
    controllerScope: {},
    currentController: ref,
  } as AppController;
  ref.current = app;
  let generation = 0;
  return {
    get app() {
      return app;
    },
    change(kind: OwnerChange, window: Window) {
      generation++;
      if (kind === "bridge") window.desktop = { ...window.desktop };
      else if (kind === "account") app.accountId = `account-${generation}`;
      else if (kind === "controller") {
        const old = app;
        app = { ...old, controllerScope: {} };
        old.currentController!.current = app;
      } else {
        const old = app;
        const next = { current: undefined as AppController | undefined };
        app = { ...old, currentController: next };
        next.current = app;
        // Retire the controller-ref itself without a React render.
        old.currentController = next;
      }
    },
  };
}
function saves() {
  let settled = 0;
  const requests: ReturnType<typeof deferred<boolean>>[] = [];
  return {
    requests,
    get settled() {
      return settled;
    },
    save: () => {
      const request = deferred<boolean>();
      requests.push(request);
      return request.promise.then(
        (value) => {
          settled++;
          return value;
        },
        (error) => {
          settled++;
          throw error;
        },
      );
    },
  };
}
const underOwner = (owner: AppController, element: ReactElement) =>
  createElement(AppContext.Provider, { value: owner }, element);

for (const kind of ownerChanges) {
  test(`network save owner ${kind}: stale success before render and stale failure after render leave the new draft and pending request intact`, async () => {
    const owner = ownerHarness();
    const queue = saves();
    const ui = () =>
      underOwner(
        owner.app,
        createElement(NetworkEgress, {
          settings: defaultSettings,
          ceiling: "full",
          save: queue.save,
        }),
      );
    await mounted(ui(), async (document, window, render) => {
      const input = () =>
        document.querySelector<HTMLInputElement>("#cap-domains")!;
      const add = () =>
        document.querySelector<HTMLButtonElement>(
          ".capabilities-allowlist-add button",
        )!;
      await act(async () => {
        enter(input(), "old.example.com", window);
      });
      await act(async () => add().click());
      assert.equal(queue.requests.length, 1);
      owner.change(kind, window);
      // No render: only the live bridge/account/controller guard can see this.
      await act(async () => queue.requests[0].resolve(true));
      assert.equal(input().value, "old.example.com");
      await render(ui());
      assert.equal(input().value, "");
      assert.equal(input().disabled, false);
      await act(async () => enter(input(), "middle.example.com", window));
      await act(async () => add().click());
      owner.change(kind, window);
      await render(ui());
      await act(async () => enter(input(), "new.example.com", window));
      await act(async () => add().click());
      assert.equal(queue.requests.length, 3);
      await act(async () =>
        queue.requests[1].reject(new Error("retired failure")),
      );
      assert.equal(input().value, "new.example.com");
      assert.equal(
        input().disabled,
        true,
        "old finally cannot release the new owner's pending state",
      );
      assert.equal(document.querySelector('[role="alert"]'), null);
      await act(async () => queue.requests[2].resolve(false));
      assert.equal(input().disabled, false);
      assert.equal(input().value, "new.example.com");
      assert.ok(document.querySelector('[role="alert"]'));
      await act(async () => add().click());
      await act(async () => queue.requests[3].resolve(true));
      assert.equal(input().value, "");
      assert.equal(input().disabled, false);
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.equal(
        queue.settled,
        4,
        "retired operations settle rather than parking indefinitely",
      );
    });
  });

  test(`notification save owner ${kind}: stale failure before render and stale finally cannot affect a new owner`, async () => {
    const owner = ownerHarness();
    const queue = saves();
    const ui = () =>
      underOwner(
        owner.app,
        createElement(NotificationsSection, {
          settings: { ...defaultSettings, notifyCodePermissions: true },
          save: queue.save,
        }),
      );
    const { currentToasts } = await import("../../src/ui/toast-store");
    const activeToasts = () =>
      currentToasts()
        .filter((toast) => !toast.closing)
        .map((toast) => [toast.id, toast.count, toast.message]);
    await mounted(ui(), async (document, window, render) => {
      const toggle = () =>
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Code permission requests"]',
        )!;
      await act(async () => toggle().click());
      const before = activeToasts();
      owner.change(kind, window);
      await act(async () =>
        queue.requests[0].reject(new Error("retired failure before render")),
      );
      assert.deepEqual(activeToasts(), before);
      await render(ui());
      assert.equal(toggle().disabled, false);
      await act(async () => toggle().click());
      owner.change(kind, window);
      await render(ui());
      await act(async () => toggle().click());
      assert.equal(queue.requests.length, 3);
      await act(async () => queue.requests[1].resolve(true));
      assert.equal(toggle().disabled, true);
      assert.equal(toggle().getAttribute("aria-checked"), "true");
      assert.deepEqual(activeToasts(), before);
      await act(async () =>
        queue.requests[2].reject(new Error("current failure")),
      );
      assert.equal(toggle().disabled, false);
      assert.ok(
        activeToasts().some(
          (toast) => toast[2] === "Couldn’t save your change. Try again.",
        ),
      );
      assert.equal(queue.settled, 3);
    });
  });

  test(`notification permission owner ${kind}: retirement before authorization settles prevents permission follow-ups and save`, async () => {
    const owner = ownerHarness();
    const status = deferred<"notDetermined">();
    let asks = 0;
    let writes = 0;
    const ui = () =>
      underOwner(
        owner.app,
        createElement(NotificationsSection, {
          settings: { ...defaultSettings, notifyCodePermissions: false },
          save: () => {
            writes++;
          },
        }),
      );
    await mounted(ui(), async (document, window, render) => {
      window.desktop.getNotificationAuthorizationStatus = () => status.promise;
      window.desktop.requestNotificationAuthorization = async () => {
        asks++;
        return "granted";
      };
      const oldBridge = window.desktop;
      const toggle = () =>
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Code permission requests"]',
        )!;
      await act(async () => toggle().click());
      assert.equal(toggle().disabled, true);
      owner.change(kind, window);
      await act(async () => status.resolve("notDetermined"));
      assert.equal(asks, 0);
      assert.equal(writes, 0);
      oldBridge.getNotificationAuthorizationStatus = async () => "authorized";
      window.desktop.getNotificationAuthorizationStatus = async () =>
        "authorized";
      await render(ui());
      assert.equal(toggle().disabled, false);
      await act(async () => toggle().click());
      assert.equal(writes, 1);
      assert.equal(toggle().disabled, false);
    });
  });
}

test("unmounted network and notification saves settle without altering remounted draft, pending state or toasts", async () => {
  const owner = ownerHarness();
  const network = saves();
  const notification = saves();
  const ui = () =>
    underOwner(
      owner.app,
      createElement(
        "div",
        null,
        createElement(NetworkEgress, {
          settings: defaultSettings,
          ceiling: "full",
          save: network.save,
        }),
        createElement(NotificationsSection, {
          settings: { ...defaultSettings, notifyCodePermissions: true },
          save: notification.save,
        }),
      ),
    );
  const { currentToasts } = await import("../../src/ui/toast-store");
  await mounted(ui(), async (document, window, render) => {
    const input = () =>
      document.querySelector<HTMLInputElement>("#cap-domains")!;
    const add = () =>
      document.querySelector<HTMLButtonElement>(
        ".capabilities-allowlist-add button",
      )!;
    const toggle = () =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Code permission requests"]',
      )!;
    await act(async () => enter(input(), "departed.example.com", window));
    await act(async () => {
      add().click();
      toggle().click();
    });
    await render(createElement("div"));
    await render(ui());
    await act(async () => enter(input(), "remounted.example.com", window));
    const before = currentToasts().map((toast) => [toast.id, toast.count]);
    await act(async () => {
      network.requests[0].resolve(true);
      notification.requests[0].reject(new Error("departed failure"));
    });
    assert.equal(input().value, "remounted.example.com");
    assert.equal(input().disabled, false);
    assert.equal(toggle().disabled, false);
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.deepEqual(
      currentToasts().map((toast) => [toast.id, toast.count]),
      before,
    );
    assert.equal(network.settled, 1);
    assert.equal(notification.settled, 1);
  });
});
