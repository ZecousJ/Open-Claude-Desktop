import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { Conversation, Settings } from "../../shared/types";
import { defaultSettings } from "../../electron/store/store";
import { recordSleep } from "../../src/code-sleep/sleep-band";

test("Keep computer awake writes only while-working and leaves the battery choice alone", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><main id="root"></main></body></html>',
  );
  window.desktop = {
    onEvent: () => () => {},
  } as unknown as Window["desktop"];
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { SleepBand } = await import("../../src/code-sleep/SleepBand");
  const root = createRoot(document.getElementById("root")!);
  recordSleep({ suspendedAt: 1_000, wakeAt: 10_000 });
  const conversation = {
    id: "slept",
    mode: "code",
    updatedAt: Date.now(),
    turns: [{ id: "t", createdAt: 500, status: "failed", items: [] }],
  } as unknown as Conversation;
  const patches: Partial<Settings>[] = [];
  const render = (settings: Settings) =>
    act(async () => {
      root.render(
        createElement(SleepBand, {
          conversation,
          variant: "code" as never,
          settings,
          updatePreference: async (patch: Partial<Settings>) => {
            patches.push(patch);
          },
          onError() {},
        }),
      );
    });
  const keepAwake = () =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Keep computer awake",
    );
  try {
    // Off while coding: the button is there and writes just that.
    await render({
      ...defaultSettings,
      keepAwakeWhileCoding: false,
      keepAwakeOnBattery: false,
    });
    const button = keepAwake();
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.deepEqual(patches, [{ keepAwakeWhileCoding: true }]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("a person who chose plugged-in only is not offered a button that would undo it", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><main id="root"></main></body></html>',
  );
  window.desktop = {
    onEvent: () => () => {},
  } as unknown as Window["desktop"];
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { SleepBand } = await import("../../src/code-sleep/SleepBand");
  const root = createRoot(document.getElementById("root")!);
  recordSleep({ suspendedAt: 1_000, wakeAt: 10_000 });
  const conversation = {
    id: "slept-2",
    mode: "code",
    updatedAt: Date.now(),
    turns: [{ id: "t", createdAt: 500, status: "failed", items: [] }],
  } as unknown as Conversation;
  try {
    await act(async () => {
      root.render(
        createElement(SleepBand, {
          conversation,
          variant: "code" as never,
          settings: {
            ...defaultSettings,
            keepAwakeWhileCoding: true,
            keepAwakeOnBattery: false,
          },
          updatePreference: async () => {},
          onError() {},
        }),
      );
    });
    assert.ok(
      ![...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Keep computer awake",
      ),
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
