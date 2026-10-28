import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { defaultSettings } from "../../electron/store/store";
import type { AccountProfile } from "../../shared/settings-api";
import type { DeviceInfo } from "../../shared/remote-devices";
import type { DesktopAPI, AppEvent, Settings } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { AccountTab } from "../../src/settings/tabs/Account";
import type { TabProps } from "../../src/settings/context";
import { currentToasts } from "../../src/ui/toast-store";
import { routineDom } from "../support/routine-dom";

const profile: AccountProfile = {
  kind: "remote",
  fullName: "Reference Person",
  email: "reference@example.test",
  canDelete: true,
};
const computer: DeviceInfo = {
  id: "real-computer",
  name: "Reference computer",
  platform: "darwin",
  version: "1",
  connectedAt: "2026-10-19T00:00:00Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function controller(accountId = "account-a") {
  const app = { accountId, controllerScope: {} } as AppController;
  app.currentController = { current: app };
  return app;
}
async function environment(api: Partial<DesktopAPI> = {}) {
  const callbacks = new Set<(event: AppEvent) => void>();
  const env = await routineDom(
    {
      accountProfile: async () => profile,
      listCoworkDevices: async () => [],
      activeSessions: async () => null,
      setFullName: async (fullName) => ({ ...profile, fullName }),
      saveOnboarding: async () => ({ pending: false, answers: {} }),
      onEvent: (callback) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
      ...api,
    },
    { jsdom: true },
  );
  const saved = new Map(
    [
      "innerWidth",
      "innerHeight",
      "addEventListener",
      "removeEventListener",
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const globals = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const errors: unknown[] = [],
    patches: Partial<Settings>[] = [];
  const render = (app = controller(), patch: Partial<TabProps> = {}) =>
    env.render(
      h(
        AppContext.Provider,
        { value: app },
        h(
          "div",
          { className: "settings-dialog" },
          h(AccountTab, {
            settings: {
              ...defaultSettings,
              name: "Local display",
              instructions: "Be brief.",
            },
            save: async (value) => {
              patches.push(value);
              return true;
            },
            platform: "darwin",
            engine: { state: "ready" } as TabProps["engine"],
            onError: (error) => errors.push(error),
            goTo() {},
            ...patch,
          }),
        ),
      ),
    );
  const input = (name: string) =>
    env.document.querySelector<HTMLInputElement>(
      `input[aria-label="${name}"]`,
    )!;
  const edit = async (name: string, value: string) => {
    await act(async () => input(name).focus());
    await env.change(`input[aria-label="${name}"]`, value);
    await act(async () => input(name).blur());
  };
  return {
    ...env,
    errors,
    patches,
    subscriptions: () => callbacks.size,
    render,
    input,
    edit,
    async emit(event: AppEvent) {
      await act(async () => {
        for (const callback of callbacks) callback(event);
      });
    },
    styles() {
      for (const path of [
        "styles/00-foundation.css",
        "settings/settings.css",
        "settings/tabs/account-parity.css",
        "settings/tabs/account-devices.css",
      ]) {
        const style = env.document.createElement("style");
        style.textContent = readFileSync(
          new URL(`../../src/${path}`, import.meta.url),
          "utf8",
        );
        env.document.head.append(style);
      }
    },
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("Account reuses the captured profile labels and actual local inventory without inventing trust or organization", async () => {
  const env = await environment({ listCoworkDevices: async () => [computer] });
  try {
    await env.render();
    assert.deepEqual(
      [
        ...env.document.querySelectorAll(".settings-account > section > h3"),
      ].map((node) => node.textContent),
      ["Profile", "Account", "Local devices", "Active sessions"],
    );
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Profile photo"][aria-haspopup="menu"]',
      ),
    );
    assert.equal(env.input("Full name").value, profile.fullName);
    assert.equal(env.input("Display name").value, "Local display");
    assert.ok(
      env.document.querySelector(
        'textarea[aria-label="Instructions for Claudex"]',
      ),
    );
    const table = env.document.querySelector(
      'table[aria-label="Local devices"]',
    )!;
    assert.deepEqual(
      [...table.querySelectorAll("th")].map((node) => node.textContent),
      ["Name", "OS", "Added", "Last seen", ""],
    );
    assert.equal(
      table.querySelector("tbody tr")?.textContent,
      "Reference computermacOS——",
    );
    const actions = table.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Reference computer"]',
    )!;
    assert.ok(actions);
    env.styles();
    assert.equal(env.window.getComputedStyle(actions).width, "32px");
    assert.equal(env.window.getComputedStyle(actions).height, "32px");
    await env.event(actions, "click");
    const details = [...env.document.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(
      details.map((item) => item.textContent?.trim()),
      ["Device details"],
    );
    await env.event(details[0], "click");
    assert.match(
      env.document.querySelector(".account-device-details")?.textContent ?? "",
      /Reference computer · macOS · 1/,
    );
    for (const label of [
      "Require trusted devices",
      "Trusted devices",
      "Organization ID",
    ])
      assert.equal(
        [...env.document.querySelectorAll("[data-setting]")].some(
          (node) => node.getAttribute("data-setting") === label,
        ),
        false,
      );
  } finally {
    await env.clean();
  }
});

test("a failed profile request keeps local fields editable and Retry displays only validated service data", async () => {
  const request = deferred<AccountProfile>();
  let reads = 0;
  const env = await environment({
    accountProfile: () =>
      ++reads === 1 ? request.promise : Promise.resolve(profile),
  });
  try {
    await env.render();
    assert.ok(env.document.querySelector('[aria-label="Loading profile"]'));
    assert.equal(env.input("Full name"), null);
    await env.edit("Display name", "Changed locally");
    assert.deepEqual(env.patches, [{ name: "Changed locally" }]);
    await act(async () => request.reject(new Error("Profile offline")));
    assert.ok(
      env.document.querySelector('[data-setting="Full name"] [role="alert"]'),
    );
    assert.equal(
      env.document.querySelector('[data-setting="Delete your account"]'),
      null,
    );
    await env.click('[data-setting="Full name"] button');
    assert.equal(env.input("Full name").value, profile.fullName);
    assert.equal(env.errors.length, 1);
  } finally {
    await env.clean();
  }
});

test("an old display-name save cannot announce Saved after the account changes", async () => {
  const pending = deferred<boolean>();
  const app = controller();
  const env = await environment();
  try {
    await env.render(app, { save: () => pending.promise });
    await env.edit("Display name", "Old account name");
    const before = currentToasts().map((toast) => [toast.id, toast.count]);
    app.currentController!.current = controller("account-b");
    await act(async () => pending.resolve(true));
    assert.deepEqual(
      currentToasts().map((toast) => [toast.id, toast.count]),
      before,
    );
  } finally {
    await env.clean();
  }
});

test("work-category selection never sends its deferred onboarding courtesy to a replacement bridge", async () => {
  const calls: unknown[] = [];
  const app = controller();
  const env = await environment({
    saveOnboarding: async (value) => {
      calls.push(value);
      return { pending: false, answers: {} };
    },
  });
  try {
    await env.render(app);
    await env.click('button[aria-label="What best describes your work?"]');
    const option = env.document.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => {
      option.click();
      env.window.desktop = {
        ...env.window.desktop,
        saveOnboarding: async (value) => {
          calls.push(value);
          return { pending: false, answers: {} };
        },
      };
    });
    assert.equal(
      env.patches.length,
      1,
      "the original local selection is saved immediately",
    );
    assert.deepEqual(
      calls,
      [],
      "the retired courtesy cannot mutate either account's onboarding",
    );
  } finally {
    await env.clean();
  }
});

test("device change events reload the real inventory and superseded replies cannot replace its current rows", async () => {
  const requests: ReturnType<typeof deferred<DeviceInfo[]>>[] = [];
  let reads = 0;
  const env = await environment({
    listCoworkDevices: () => {
      if (++reads === 1) return Promise.resolve([computer]);
      const request = deferred<DeviceInfo[]>();
      requests.push(request);
      return request.promise;
    },
  });
  try {
    await env.render();
    await env.emit({ type: "devices-changed" });
    await env.emit({ type: "devices-changed" });
    assert.equal(
      env.document
        .querySelector(".account-local-devices tbody")
        ?.getAttribute("aria-busy"),
      "true",
    );
    await act(async () =>
      requests[0].resolve([{ ...computer, name: "Superseded computer" }]),
    );
    assert.equal(
      env.document
        .querySelector(".account-local-devices")
        ?.textContent?.includes("Superseded computer"),
      false,
    );
    await act(async () =>
      requests[1].resolve([{ ...computer, name: "Current computer" }]),
    );
    assert.equal(
      env.document.querySelector(".account-local-devices tbody tr")
        ?.textContent,
      "Current computermacOS——",
    );
  } finally {
    await env.clean();
  }
});

test("an old device event listener cannot reload the replacement account's service", async () => {
  let reads = 0;
  const app = controller();
  const env = await environment({
    listCoworkDevices: async () => {
      reads++;
      return [computer];
    },
  });
  try {
    await env.render(app);
    app.currentController!.current = controller("account-b");
    await env.emit({ type: "devices-changed" });
    assert.equal(reads, 1);
    await env.render(app.currentController!.current!);
    assert.equal(reads, 2);
  } finally {
    await env.clean();
  }
});

test("a failed profile image falls back to initials and a new image source can load", async () => {
  const env = await environment();
  const app = controller();
  try {
    await env.render(app, {
      settings: {
        ...defaultSettings,
        avatarPhoto: "data:image/png;base64,broken",
      },
    });
    const image = env.document.querySelector(".settings-avatar img")!;
    await env.event(image, "error");
    assert.equal(env.document.querySelector(".settings-avatar img"), null);
    assert.equal(
      env.document.querySelector(".settings-avatar")?.textContent,
      "RP",
    );
    await env.render(app, {
      settings: {
        ...defaultSettings,
        avatarPhoto: "data:image/png;base64,replacement",
      },
    });
    assert.equal(
      env.document.querySelector(".settings-avatar img")?.getAttribute("src"),
      "data:image/png;base64,replacement",
    );
  } finally {
    await env.clean();
  }
});

test("Account instructions keep the source autosize limits and inactive warning outside the flex flow", async () => {
  const env = await environment();
  try {
    env.styles();
    await env.render();
    const textarea = env.document.querySelector(
      ".settings-instructions textarea",
    )!;
    const status = env.document.querySelector<HTMLElement>(
      ".settings-instructions > [role=status]",
    )!;
    const style = env.window.getComputedStyle(textarea);
    assert.equal(style.minHeight, "88px");
    assert.equal(style.maxHeight, "160px");
    assert.equal(style.getPropertyValue("field-sizing"), "content");
    assert.equal(status.childElementCount, 0);
    assert.equal(env.window.getComputedStyle(status).position, "absolute");
    await env.change(".settings-instructions textarea", "x".repeat(32769));
    assert.ok(status.querySelector(".settings-instructions-warning"));
    assert.notEqual(
      env.window.getComputedStyle(status).position,
      "absolute",
      "a visible warning participates in the layout",
    );
    assert.ok(env.document.querySelector(".settings-instructions-actions"));
  } finally {
    await env.clean();
  }
});

test("changing account discards an unsaved instruction draft before it can be committed to the new profile", async () => {
  const env = await environment();
  const app = controller();
  try {
    await env.render(app);
    await env.change(
      ".settings-instructions textarea",
      "Private account A draft",
    );
    const next = controller("account-b");
    app.currentController!.current = next;
    await env.render(next, {
      settings: { ...defaultSettings, instructions: "Account B instructions" },
    });
    assert.equal(
      env.document.querySelector<HTMLTextAreaElement>(
        ".settings-instructions textarea",
      )?.value,
      "Account B instructions",
    );
    assert.equal(
      env.document.querySelector(".settings-instructions-actions"),
      null,
    );
    assert.deepEqual(env.patches, []);
  } finally {
    await env.clean();
  }
});

test("Account trust requires the complete authority and disables retained retries when its bridge or account changes", async () => {
  const { deviceTrustBridgeMethods } =
    await import("../../shared/remote-devices");
  const state = { requireTrustedDevices: true, trusted: [], pending: [] };
  let reads = 0,
    saves = 0;
  const complete = {
    deviceTrustState: async () => {
      reads++;
      throw new Error("authority read failed");
    },
    setRequireTrustedDevices: async (required: boolean) => {
      saves++;
      return { ...state, requireTrustedDevices: required };
    },
    approveDeviceTrust: async () => state,
    rejectDeviceTrust: async () => state,
    revokeDeviceTrust: async () => state,
  };
  const env = await environment(complete);
  try {
    const first = controller("first");
    await env.render(first);
    assert.equal(reads, 1);
    assert.equal(env.errors.length, 1);
    const retry = [...env.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    assert.ok(retry);
    const reactProps = Object.keys(retry).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const oldRetry = (retry as unknown as Record<string, { onClick(): void }>)[
      reactProps
    ].onClick;
    const oldBridge = env.window.desktop;
    const completeSubscriptions = env.subscriptions();
    const originalRevoke = oldBridge.revokeDeviceTrust;
    oldBridge.revokeDeviceTrust = undefined as never;
    await env.render(first);
    await act(async () => oldRetry());
    assert.equal(
      reads,
      1,
      "disabling authority on the same bridge invalidates retained Retry",
    );
    assert.equal(
      env.subscriptions(),
      completeSubscriptions - 1,
      "disabled authority unsubscribes its device watcher",
    );
    oldBridge.revokeDeviceTrust = originalRevoke;
    const second = controller("second");
    assert.ok(first.currentController);
    first.currentController.current = second;
    for (const missing of deviceTrustBridgeMethods) {
      env.window.desktop = { ...oldBridge, [missing]: undefined };
      await env.render(second);
      await env.emit({ type: "devices-changed" });
      await act(async () => oldRetry());
      assert.equal(
        reads,
        1,
        `${missing}: unsupported authority never reads or retries`,
      );
      assert.equal(
        env.errors.length,
        1,
        `${missing}: no false verification error`,
      );
      assert.ok(
        env.document.querySelector('table[aria-label="Local devices"]'),
      );
      assert.equal(
        env.document.querySelector('table[aria-label="Trusted devices"]'),
        null,
      );
      assert.equal(
        env.document.querySelector('[aria-label="Require trusted devices"]'),
        null,
      );
      assert.doesNotMatch(
        env.document.body.textContent ?? "",
        /Couldn’t load device verification|Loading device verification/,
      );
      assert.equal(
        [...env.document.querySelectorAll("button")].some(
          (button) => button.textContent === "Retry",
        ),
        false,
      );
    }
    env.window.desktop = {
      ...oldBridge,
      deviceTrustState: async () => {
        reads++;
        return state;
      },
    };
    await env.render(second);
    assert.equal(reads, 2);
    const toggle = env.document.querySelector(
      '[role="switch"][aria-label="Require trusted devices"]',
    )!;
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    // No trusted device yet: the section's heading and note alone.
    assert.equal(
      env.document.querySelector('table[aria-label="Trusted devices"]'),
      null,
    );
    await env.event(toggle, "click");
    assert.equal(saves, 1);
    assert.equal(toggle.getAttribute("aria-checked"), "false");
  } finally {
    await env.clean();
  }
});
