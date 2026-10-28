import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { DispatchPage } from "../../src/dispatch/DispatchPage";
import { defaultSettings } from "../../electron/store/store";
import { currentToasts } from "../../src/ui/toast-store";

async function mounted(
  settings: Record<string, unknown>,
  desktop: Record<string, unknown>,
  run: (document: Document) => Promise<void>,
) {
  const dom = new JSDOM("<html><body><main></main></body></html>", {
    url: "https://app.test/",
  });
  const { window } = dom;
  const reported: unknown[] = [];
  const app = {
    snapshot: { settings: { ...defaultSettings, ...settings } },
    listed: [],
    report: (error: unknown) => reported.push(error),
    updatePreference: async () => {},
    openConversation() {},
  } as unknown as AppController;
  (window as unknown as { desktop: unknown }).desktop = {
    dispatchTasks: async () => [],
    listSchedules: async () => [],
    openExternal: async () => {},
    ...desktop,
  };
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
  try {
    await act(async () =>
      root.render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(DispatchPage),
        ),
      ),
    );
    await act(async () => {});
    await run(window.document);
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const status = (local: Record<string, unknown>) => ({
  appLink: "https://claudex.test/downloads",
  paired: false,
  local: { id: "this", online: false, ...local },
  devices: [],
  onlineDeviceIds: [],
  pending: [],
});

test("an expired sign-in says so instead of leaving the page silent", async () => {
  await mounted(
    { dispatchOnboarded: true },
    {
      dispatchStatus: async () => status({ cause: "sign_in" }),
      dispatchCall: async () => [],
    },
    async (document) => {
      assert.match(
        document.body.textContent ?? "",
        /Your sign-in session has expired, so Dispatch is disconnected on this device\. Sign in again to reconnect\./,
      );
    },
  );
});

test("the pairing step warns that the phone reaches this desktop, with a safety link", async () => {
  await mounted(
    { dispatchOnboarded: false },
    {
      dispatchStatus: async () => status({ online: true }),
      dispatchCall: async () => [],
    },
    async (document) => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent === "Pair your phone",
      )!;
      await act(async () => button.click());
      assert.match(
        document.body.textContent ?? "",
        /Only pair devices that you own and trust\./,
      );
      const link = [...document.querySelectorAll("a")].find(
        (item) => item.textContent === "Learn how to use this safely",
      )!;
      assert.match(link.getAttribute("href") ?? "", /\/help\/cowork-safety$/);
    },
  );
});

test("Mobile notifications go back off, with the original's message, when the desktop refuses", async () => {
  await mounted(
    { dispatchOnboarded: true },
    {
      dispatchStatus: async () => status({ online: true }),
      dispatchCall: async (_id: string, method: string, args: unknown[]) => {
        if (method === "dispatchPreferences") {
          if (args.length) throw new Error("refused");
          return false;
        }
        return [];
      },
    },
    async (document) => {
      const control = document.querySelector<HTMLButtonElement>(
        '[aria-label="Mobile notifications"]',
      )!;
      assert.equal(control.getAttribute("aria-checked"), "false");
      await act(async () => control.click());
      await act(async () => {});
      assert.equal(control.getAttribute("aria-checked"), "false");
      assert.ok(
        currentToasts().some(
          (toast) =>
            toast.message === "Failed to enable Dispatch notifications.",
        ),
      );
    },
  );
});
