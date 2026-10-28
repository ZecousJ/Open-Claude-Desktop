import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { defaultSettings } from "../../electron/store/store";
import { CapabilitiesTab } from "../../src/settings/tabs/Capabilities";
import { atomicChatDom } from "../support/atomic-chat-dom";
import type { Settings } from "../../shared/types";
import type { TabProps } from "../../src/settings/context";

const props = {
  platform: "darwin",
  engine: { state: "ready" },
  onError() {},
  goTo() {},
} as Omit<TabProps, "settings" | "save">;

test("rendered execution toggle unlocks Artifacts, saves both values and restores the interlock", async () => {
  const dom = await atomicChatDom();
  const patches: Partial<Settings>[] = [];
  function Page() {
    const [settings, setSettings] = useState(defaultSettings);
    return createElement(CapabilitiesTab, {
      ...props,
      settings,
      save: async (patch) => {
        patches.push(patch);
        setSettings((value) => ({ ...value, ...patch }));
        return true;
      },
    });
  }
  const toggle = (name: string) =>
    dom.document.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="${name}"]`,
    )!;
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  try {
    await dom.render(createElement(Page));
    assert.equal(toggle("Artifacts").disabled, true);
    assert.equal(
      toggle("Code execution and file creation").getAttribute("aria-checked"),
      "true",
    );
    await click(toggle("Code execution and file creation"));
    assert.deepEqual(patches.at(-1), { chatExecution: false });
    assert.equal(toggle("Artifacts").disabled, false);
    await click(toggle("Artifacts"));
    assert.deepEqual(patches.at(-1), { artifacts: false });
    assert.equal(toggle("Artifacts").getAttribute("aria-checked"), "false");
    await click(toggle("Code execution and file creation"));
    assert.equal(toggle("Artifacts").disabled, true);
    assert.equal(toggle("Artifacts").getAttribute("aria-checked"), "true");
    assert.doesNotMatch(
      dom.document.body.textContent ?? "",
      /Not configurable/,
    );
  } finally {
    await dom.clean();
  }
});

test("refused save keeps the actual switch and Artifacts lock, with inline retry feedback", async () => {
  const dom = await atomicChatDom();
  try {
    await dom.render(
      createElement(CapabilitiesTab, {
        ...props,
        settings: defaultSettings,
        save: async () => false,
      }),
    );
    const execution = dom.document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Code execution and file creation"]',
    )!;
    await act(async () => execution.click());
    assert.equal(execution.getAttribute("aria-checked"), "true");
    assert.match(
      dom.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Couldn’t save/,
    );
    assert.equal(execution.disabled, false);
  } finally {
    await dom.clean();
  }
});
