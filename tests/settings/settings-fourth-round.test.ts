import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { parseHTML } from "linkedom";
import { defaultSettings } from "../../electron/store/store";
import { PrivacyTab } from "../../src/settings/tabs/Privacy";
import { VoiceSection } from "../../src/settings/tabs/General";
import { privacyExplanations } from "../../src/settings/PrivacyExplanations";
import { speechPreferences } from "../../src/voice/speech";

const source = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

async function mount(
  element: ReactNode,
  setup: (
    window: ReturnType<typeof parseHTML>["window"],
  ) => Record<string, unknown> | undefined,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  document.documentElement.dataset.motion = "reduced";
  const globals = {
    window,
    document,
    Event: window.Event,
    Node: window.Node,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ...setup(window),
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
  const root = createRoot(document.querySelector("main")!);
  await act(async () => root.render(element));
  return {
    window,
    document,
    async close() {
      await act(() => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("actual Privacy keeps independent, initially collapsed explanations usable after an optional service-status failure", async () => {
  const failures: unknown[] = [];
  let saves = 0;
  const mounted = await mount(
    createElement(PrivacyTab, {
      settings: defaultSettings,
      save() {
        saves++;
      },
      goTo() {},
      onError(error: unknown) {
        failures.push(error);
      },
    } as never),
    (window) => {
      window.desktop = {
        reportingStatus: async () => {
          throw new Error("Reporting is offline");
        },
        sharingStatus: async () => null,
        signUpProfile: async () => null,
        onEvent: () => () => {},
      } as never;
      return {};
    },
  );
  const { document } = mounted;
  try {
    assert.equal(failures.length, 1);
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".privacy-explanation > button",
      ),
    );
    assert.equal(buttons.length, 2);
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      privacyExplanations.map(({ title }) => title),
    );
    assert.ok(
      buttons.every(
        (button) =>
          button.getAttribute("aria-expanded") === "false" &&
          !button.disabled &&
          button.querySelector('svg[width="16"][height="16"]'),
      ),
    );
    assert.equal(
      document.querySelectorAll(".privacy-explanation-body").length,
      0,
    );
    await act(async () => buttons[0].click());
    const firstId = buttons[0].getAttribute("aria-controls")!;
    assert.equal(buttons[0].getAttribute("aria-expanded"), "true");
    assert.equal(
      document.getElementById(firstId)?.querySelectorAll("li").length,
      3,
    );
    assert.equal(buttons[1].getAttribute("aria-expanded"), "false");
    await act(async () => buttons[1].click());
    const secondId = buttons[1].getAttribute("aria-controls")!;
    assert.notEqual(firstId, secondId);
    assert.equal(
      document.getElementById(secondId)?.querySelectorAll("li").length,
      4,
    );
    assert.match(
      document.getElementById(firstId)!.textContent!,
      /Cloud chats, projects and files/,
    );
    assert.match(
      document.getElementById(secondId)!.textContent!,
      /only when your service allows it and you choose/,
    );
    assert.doesNotMatch(
      document.querySelector(".privacy-explanations")!.textContent!,
      /Anthropic|sell your data|deletes your data promptly/,
    );
    await act(async () => buttons[0].click());
    assert.equal(document.getElementById(firstId), null);
    assert.ok(document.getElementById(secondId));
    assert.equal(
      saves,
      0,
      "reading disclosures never changes account preferences",
    );
    assert.match(
      document.querySelector(".settings-section-note")!.textContent!,
      /Cloud sessions and synced data/,
    );
    const css = source("src/settings/privacy-explanations.css");
    assert.match(css, /min-height: 44px/);
    assert.match(css, /border-radius: 8px/);
    assert.match(css, /color: var\(--settings-muted\)/);
  } finally {
    await mounted.close();
  }
});

test("actual Voice menus preserve browser voices and store language, voice and rate without claiming Buttery", async () => {
  const storage = new Map<string, string>([
    ["claudex.speech.language", "en-US"],
  ]);
  const voices = [
    { name: "English system voice", lang: "en-US", default: true },
    { name: "日本語の音声", lang: "ja-JP" },
  ];
  const mounted = await mount(createElement(VoiceSection), (window) => {
    window.speechSynthesis = {
      getVoices: () => voices,
      cancel() {},
    } as never;
    return {
      speechSynthesis: window.speechSynthesis,
      SpeechSynthesisUtterance: class {},
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    };
  });
  const { document } = mounted;
  const open = async (label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    await act(async () => trigger.click());
    return trigger;
  };
  const choose = async (label: string) => {
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((entry) => entry.textContent === label);
    assert.ok(option, label);
    await act(async () => option.click());
  };
  try {
    assert.ok(
      document
        .querySelector("main")!
        .firstElementChild?.matches("section.settings-section"),
      "Voice remains a direct section sibling so shared section gaps apply",
    );
    assert.deepEqual(
      Array.from(document.querySelectorAll(".settings-row"), (row) =>
        row.getAttribute("data-setting"),
      ),
      ["Language", "Style", "Speed"],
    );
    assert.match(
      document.querySelector(".settings-section-note")!.textContent!,
      /browser or operating system/,
    );
    assert.doesNotMatch(document.body.textContent!, /Buttery|Anthropic/);
    await open("Style");
    assert.ok(
      Array.from(document.querySelectorAll('[role="option"]')).some(
        (entry) => entry.textContent === "English system voice",
      ),
    );
    assert.ok(
      !Array.from(document.querySelectorAll('[role="option"]')).some(
        (entry) => entry.textContent === "日本語の音声",
      ),
    );
    await choose("English system voice");
    assert.equal(speechPreferences().voice, "English system voice");
    assert.equal(storage.get("claudex.speech.voice"), "English system voice");
    await open("Language");
    await choose("日本語");
    assert.equal(speechPreferences().language, "ja-JP");
    const style = await open("Style");
    assert.match(style.textContent!, /Browser default/);
    assert.ok(
      !Array.from(document.querySelectorAll('[role="option"]')).some(
        (entry) => entry.textContent === "English system voice",
      ),
    );
    await choose("日本語の音声");
    assert.equal(speechPreferences().voice, "日本語の音声");
    await open("Speed");
    await choose("Fast");
    assert.equal(speechPreferences().rate, 1.2);
    assert.equal(document.querySelector('[role="listbox"]'), null);
    const css = source("src/settings/voice-preferences.css");
    assert.doesNotMatch(css, /(?:min-)?width: 80px/);
    assert.match(css, /max-width: 192px/);
    assert.match(css, /text-overflow: ellipsis/);
  } finally {
    await mounted.close();
  }
});

// Shared field/popup paints are covered by mounted controls in
// settings-b28-tokens.test.ts and the official/local browser comparisons.
