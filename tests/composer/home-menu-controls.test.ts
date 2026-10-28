import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import {
  MicrophoneMenu,
  inputDevices,
} from "../../src/composer/MicrophoneMenu";
import { registerHooks } from "node:module";
import { ChatHome } from "../../src/home/ChatHome";
import { microphoneDeviceId } from "../../src/voice/preferences";
import { AppContext, type AppController } from "../../src/app/AppContext";

function environment() {
  const { window, document } = parseHTML(
    "<html><body><button id=anchor></button><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  let focused: HTMLElement | undefined;
  const focus = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "focus",
  );
  const bounds = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "getBoundingClientRect",
  );
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100,
    y: 500,
    left: 100,
    right: 120,
    top: 500,
    bottom: 532,
    width: 20,
    height: 32,
    toJSON() {},
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  const storage = new Map<string, string>();
  const globals = {
    window,
    document,
    navigator: { userAgent: "node-test", language: "en-US" },
    Event: window.Event,
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({ matches: true }),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
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
  return {
    window,
    document,
    get focused() {
      return focused;
    },
    restore() {
      if (focus)
        Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
      if (bounds)
        Object.defineProperty(
          window.HTMLElement.prototype,
          "getBoundingClientRect",
          bounds,
        );
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("microphone enumeration only returns actual input devices, including a real default", async () => {
  const env = environment();
  try {
    Object.assign(navigator, {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "speaker", label: "Speaker" },
          { kind: "audioinput", deviceId: "default", label: "" },
          { kind: "audioinput", deviceId: "usb", label: "USB mic" },
        ],
      },
    });
    assert.deepEqual(await inputDevices(), [
      { id: "default", label: "Default" },
      { id: "usb", label: "USB mic" },
    ]);
    Object.assign(navigator.mediaDevices, { enumerateDevices: async () => [] });
    assert.deepEqual(await inputDevices(), []);
    Object.assign(navigator.mediaDevices, {
      enumerateDevices: async () => {
        throw Error("enumeration failed");
      },
    });
    assert.deepEqual(await inputDevices(), []);
  } finally {
    env.restore();
  }
});

test("idle microphone menu distinguishes pending/empty, ignores stale enumeration and selects a real device", async () => {
  const env = environment();
  const pending: ((rows: unknown[]) => void)[] = [];
  let changed: (() => void) | undefined;
  let recordings = 0,
    closed = 0;
  Object.assign(navigator, {
    permissions: { query: async () => ({ state: "granted" }) },
    mediaDevices: {
      enumerateDevices: () => new Promise((resolve) => pending.push(resolve)),
      getUserMedia: () => {
        recordings++;
        throw Error("must not record for idle menu");
      },
      addEventListener: (_name: string, listener: () => void) => {
        changed = listener;
      },
      removeEventListener: () => {
        changed = undefined;
      },
    },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.document.querySelector("main")!);
  const anchor = createRef<HTMLElement>();
  anchor.current = env.document.querySelector("#anchor")!;
  try {
    await act(() =>
      root.render(
        createElement(MicrophoneMenu, {
          anchor,
          variant: "idle",
          onClose: () => closed++,
        }),
      ),
    );
    assert.match(env.document.body.textContent!, /Loading/);
    await act(async () => pending[0]([]));
    const empty = Array.from(
      env.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "No devices found")!;
    assert.ok(empty.disabled);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Default|Hold to record/,
    );
    assert.equal(env.document.querySelector(".microphone-menu header"), null);
    assert.ok(env.document.querySelector(".microphone-status"));
    assert.match(
      env.document.body.textContent!,
      /Dictation settings.*LanguageAuto/,
    );
    const language = env.document.querySelector<HTMLButtonElement>(
      ".microphone-language-status",
    )!;
    assert.equal(language.disabled, false);
    assert.equal(language.getAttribute("aria-haspopup"), "menu");
    await act(() => {
      changed!();
    });
    await act(() => {
      changed!();
    });
    await act(async () =>
      pending[2]([{ kind: "audioinput", deviceId: "new", label: "New mic" }]),
    );
    await act(async () =>
      pending[1]([{ kind: "audioinput", deviceId: "old", label: "Old mic" }]),
    );
    assert.match(env.document.body.textContent!, /New mic/);
    assert.doesNotMatch(env.document.body.textContent!, /Old mic/);
    await act(() =>
      Array.from(
        env.document.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      )
        .find((button) => button.textContent === "New mic")!
        .click(),
    );
    assert.equal(microphoneDeviceId(), "new");
    assert.equal(closed, 1);
    assert.equal(recordings, 0);
  } finally {
    await act(() => root.unmount());
    assert.equal(changed, undefined);
    env.restore();
  }
});

test("legacy microphone menu offers Language between the inputs and Hold to record", async () => {
  const env = environment();
  Object.assign(navigator, {
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "usb", label: "USB mic" },
      ],
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.document.querySelector("main")!);
  const anchor = createRef<HTMLElement>();
  anchor.current = env.document.querySelector("#anchor")!;
  try {
    await act(() =>
      root.render(createElement(MicrophoneMenu, { anchor, onClose() {} })),
    );
    await act(async () => {});
    const items = Array.from(
      env.document.querySelectorAll<HTMLElement>(
        ".microphone-menu [role^='menuitem']",
      ),
    ).map(
      (item) =>
        item.getAttribute("role") +
        ":" +
        item.textContent!.replace(/[\p{Cf}\p{Co}]/gu, ""),
    );
    assert.equal(
      items.join("|"),
      "menuitemradio:USB mic|menuitem:LanguageAuto|menuitemcheckbox:Hold to record",
    );
  } finally {
    await act(() => root.unmount());
    env.restore();
  }
});

test("microphone caret names the actual control and idle dimensions allow the functional language row", async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.includes("pcm-capture-worklet.js?"))
        return {
          shortCircuit: true,
          url: "data:text/javascript,export default 'worklet.js'",
        };
      return next(specifier, context);
    },
  });
  const { VoiceOptionsButton } =
    await import("../../src/composer/VoiceModeButton");
  hooks.deregister();
  const html = renderToStaticMarkup(createElement(VoiceOptionsButton, {}));
  assert.match(html, /aria-label="Microphone"/);
  const caret = (variant?: "idle" | "legacy") =>
    parseHTML(
      renderToStaticMarkup(
        createElement(VoiceOptionsButton, { menuVariant: variant }),
      ),
    ).document.querySelector<HTMLElement>('[data-icon="CaretDown"]')!;
  const assertIdleGlyph = (glyph: HTMLElement) => {
    assert.equal(glyph.getAttribute("width"), "12");
  };
  assertIdleGlyph(caret("idle"));
  const legacy = caret("legacy");
  assert.equal(legacy.getAttribute("width"), "13");
  assert.equal(caret().getAttribute("width"), "13");
  assert.throws(
    () => assertIdleGlyph(legacy),
    { code: "ERR_ASSERTION" },
    "the previous 13px output must fail the actual idle glyph check",
  );
  const css = readFileSync("src/composer/microphone-menu.css", "utf8");
  assert.match(css, /\.microphone-menu-idle\s*\{[^}]*width:\s*max-content/);
  assert.match(css, /\.microphone-menu-idle\s*\{[^}]*min-width:\s*165px/);
  assert.match(
    css,
    /\.microphone-menu\.microphone-menu-idle button\s*\{[^}]*height:\s*32px/,
  );
  assert.match(
    css,
    /\.microphone-settings-heading\s*\{[^}]*line-height:\s*17px/,
  );
  assert.equal(32 + 32 + 9 + 25 + 32 + 9, 139);
});

test("incognito Learn more opens a truthful provider explanation, closes with Escape and never sends messages", async () => {
  const env = environment();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.document.querySelector("main")!);
  const app = {
    accountId: "incognito-test",
    snapshot: { settings: { homeStarters: { chipsOverride: "hide" } } },
    latest: { current: undefined },
  } as unknown as AppController;
  const render = (incognito: boolean) =>
    root.render(
      createElement(
        AppContext.Provider,
        { value: app },
        createElement(ChatHome, {
          incognito,
          name: "Test",
          mode: "chat",
          model: "test",
          connectionDismissed: true,
          onServiceStatus() {},
          onDismiss() {},
          onSuggestion() {
            throw Error("must not send");
          },
          composer: null,
        }),
      ),
    );
  try {
    await act(() => render(true));
    const trigger = () =>
      env.document.querySelector<HTMLButtonElement>(".incognito-learn-more")!;
    trigger().focus();
    await act(() => trigger().click());
    const dialog = env.document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    assert.match(
      dialog.textContent!,
      /Your model service still receives your messages\. Its data policies apply\./,
    );
    assert.doesNotMatch(
      dialog.textContent!,
      /aren.t used to train|no.training|anthropic\.com/i,
    );
    const escape = new env.window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(escape, { key: "Escape" });
    await act(() => env.document.dispatchEvent(escape));
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.equal(env.focused, trigger());
    await act(() => trigger().click());
    await act(() => render(false));
    await act(() => render(true));
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(() => root.unmount());
    env.restore();
  }
});
