import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dictationLabel,
  dictationErrorMs,
  dictationFailureCopy,
  microphoneBlocked,
  microphoneGuidance,
} from "../../src/voice/microphone-guidance";
import {
  nextStep,
  stepShown,
  savedStep,
  saveStep,
} from "../../src/onboarding/onboarding-steps";
import { QuickAccessShortcut } from "../../src/settings/QuickAccessShortcut";
import QuickEntryOnboarding from "../../src/onboarding/QuickEntryOnboarding";
import { preferenceDefaults } from "../../shared/settings-extras";
import { desktopPreferenceFields } from "../../electron/store/settings-preferences";
import { webMethodKind } from "../../shared/web-bridge-methods";
import { registerHooks } from "node:module";
import { readSource } from "../support/read-source";
import { readFileSync } from "node:fs";
import { currentToasts, dismissAllToasts } from "../../src/ui/toast-store";
import {
  defaultDictationSeconds,
  dictationRecordingSeconds,
} from "../../shared/voice-api";
import { microphoneContextKey } from "../../src/voice/microphone-context";

test("dictation defaults to ten minutes and reserves fifteen seconds of a service session", () => {
  assert.equal(defaultDictationSeconds, 600);
  assert.equal(dictationRecordingSeconds(null), 600);
  assert.equal(dictationRecordingSeconds(0), 600);
  assert.equal(dictationRecordingSeconds(120), 105);
  assert.equal(dictationRecordingSeconds(90), 75);
  assert.equal(dictationRecordingSeconds(20), 15);
});

test("voice controls use the live app's labels and session guards", async () => {
  const { routineDom } = await import("../support/routine-dom");
  const { MicrophoneMenu } = await import("../../src/composer/MicrophoneMenu");
  const env = await routineDom({}, { jsdom: true });
  const globals = {
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  const oldGlobals = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    const anchor = createRef<HTMLButtonElement>();
    await env.render(
      createElement(MicrophoneMenu, { anchor, onClose() {}, variant: "idle" }),
    );
    assert.equal(
      env.document.querySelector('[role="menu"]')?.getAttribute("aria-label"),
      "Dictation settings",
    );
  } finally {
    await env.clean();
    for (const [key, value] of oldGlobals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
  const voice = readFileSync("src/composer/VoiceModeButton.tsx", "utf8");
  const composer = readSource("src/composer/Composer.tsx");
  assert.match(voice, /starting: "Connecting\.\.\."/);
  assert.match(voice, /\{t\(phaseText\[mode\.phase\]\)\}/);
  assert.match(composer, /End the voice session to continue/);
  assert.match(composer, /End the voice session first/);
  assert.match(
    composer,
    /File attachments were removed because the draft was reset after an unfinished voice conversation/,
  );
});

test("Quick Entry dismisses Escape on keyup like the desktop renderer", () => {
  const source = readFileSync("src/quick-window/QuickEntry.tsx", "utf8");
  assert.match(source, /onKeyUp=\{\(event\) => \{/);
  assert.match(
    source,
    /onKeyUp=\{[\s\S]*event\.key === "Escape"[\s\S]*bridge\.dismiss\(\)/,
  );
  const keydown = source.slice(
    source.indexOf("onKeyDown"),
    source.indexOf("onKeyUp"),
  );
  assert.doesNotMatch(keydown, /event\.key === "Escape"/);
});

test("microphone keyboard menus dispatch a centered, cancellable contextmenu", () => {
  const events: unknown[] = [];
  let prevented = 0;
  const button = {
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 32, height: 32 }),
    ownerDocument: {
      defaultView: {
        MouseEvent: class {
          constructor(type: string, options: object) {
            Object.assign(this, { type, ...options });
          }
        },
      },
    },
    dispatchEvent: (event: unknown) => {
      events.push(event);
      return false;
    },
  };
  const key = (extra = {}) => ({
    currentTarget: button,
    key: "F10",
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: () => prevented++,
    ...extra,
  });
  microphoneContextKey(key() as never);
  microphoneContextKey(key({ key: "ContextMenu", shiftKey: false }) as never);
  assert.equal(events.length, 2);
  assert.equal(prevented, 2);
  assert.deepEqual(
    { ...(events[0] as object) },
    {
      type: "contextmenu",
      bubbles: true,
      cancelable: true,
      button: -1,
      clientX: 36,
      clientY: 46,
    },
  );
  for (const extra of [
    { shiftKey: false },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { defaultPrevented: true },
  ])
    microphoneContextKey(key(extra) as never);
  assert.equal(events.length, 2);
});

test("dictation uses the same label for its tooltip and accessible name in every phase", () => {
  assert.equal(dictationLabel("idle", false, true), "Press and hold to record");
  assert.equal(dictationLabel("idle", false, true, true), "Dictate");
  assert.equal(dictationLabel("idle", false, false), "Dictate");
  assert.equal(dictationLabel("recording", false, true), "Stop dictation");
  assert.deepEqual(
    ["idle", "requesting", "recording", "finishing"].map((phase) =>
      dictationLabel(phase),
    ),
    [
      "Dictate",
      "Starting dictation…",
      "Stop dictation",
      "Finishing dictation…",
    ],
  );
  assert.deepEqual(
    ["idle", "requesting", "recording", "finishing"].map((phase) =>
      dictationLabel(phase, true),
    ),
    [
      "Dictate a comment",
      "Starting dictation…",
      "Finish dictating",
      "Finishing dictation…",
    ],
  );
});

test("dictation failures explain exactly which words remain in the message box", () => {
  assert.equal(dictationErrorMs, 1500);
  assert.deepEqual(dictationFailureCopy(null, false), {
    title: "Couldn’t start dictation.",
    description: undefined,
  });
  assert.deepEqual(dictationFailureCopy("mic_lost", true), {
    title: "Your microphone stopped working.",
    description:
      "Your words so far are in the message box. Check the connection and microphone access.",
  });
  assert.equal(
    dictationFailureCopy("mic_lost", false).description,
    "Check the connection and microphone access.",
  );
  assert.equal(
    dictationFailureCopy("connection_lost", true).description,
    "Your words are in the message box, but the last few may be missing.",
  );
  assert.equal(
    dictationFailureCopy("connection_lost", false).description,
    "Nothing was added to the message box.",
  );
  assert.equal(
    dictationFailureCopy("stt_stalled", true).description,
    "Only your earlier words are in the message box. Anything you said after the connection was lost is missing.",
  );
  assert.deepEqual(dictationFailureCopy("auto_silence", false), {
    title: "Dictation stopped because it heard no words for 1 minute.",
    description: "If you were speaking, check your microphone.",
  });
  assert.deepEqual(dictationFailureCopy("auto_max_duration", false), {
    title: "Dictation stopped at its time limit.",
    description: "Nothing was added to the message box.",
  });
  assert.equal(
    dictationFailureCopy("auto_max_duration", true).description,
    "Your words so far are in the message box.",
  );
});

test("only permission denials get microphone guidance, with host-specific instructions", () => {
  assert.ok(
    microphoneBlocked(new DOMException("Permission denied", "NotAllowedError")),
  );
  assert.ok(microphoneBlocked(Error("Microphone access was not granted.")));
  assert.ok(
    !microphoneBlocked(
      Error("Your administrator has turned off voice and dictation."),
    ),
  );
  assert.ok(!microphoneBlocked(Error("No microphone was found.")));
  assert.match(
    microphoneGuidance("darwin", true),
    /System Settings.*Privacy and Security.*Microphone.*Claudex/,
  );
  assert.match(
    microphoneGuidance("win32", true),
    /Settings.*Privacy and security.*allow Claudex/,
  );
  assert.match(microphoneGuidance("darwin", false), /browser’s address bar/);
  assert.equal(webMethodKind("openMicrophoneSettings"), "browser");
  assert.equal(webMethodKind("openQuickEntry"), "absent");
});

test("Quick access has a separate double-tap default and validates its custom shortcuts", () => {
  assert.equal(preferenceDefaults.quickEntryShortcut, "double-tap-option");
  // Alt+Space off macOS (desktop client 2.37337.1: ERe).
  assert.equal(preferenceDefaults.quickAccessShortcut, "Alt+Space");
  const schema = desktopPreferenceFields("darwin").quickEntryShortcut;
  for (const value of [
    "",
    "double-tap-option",
    "off",
    "Alt+Space",
    "Command+Shift+Space",
  ])
    assert.ok(schema.safeParse(value).success, value);
  for (const value of ["D", "anything"])
    assert.ok(!schema.safeParse(value).success, value);
  const render = (platform: string) =>
    renderToStaticMarkup(
      createElement(QuickAccessShortcut, {
        value: "double-tap-option",
        platform,
        onChange: async () => {},
      }),
    );
  assert.match(render("darwin"), /Tap Option twice/);
  assert.match(render("win32"), /Tap Alt twice/);
});

test("Quick Entry onboarding is desktop-only, with a resumable step and its shortcut drawn as keys", () => {
  assert.doesNotMatch(
    readFileSync(new URL("../../index.html", import.meta.url), "utf8"),
    /img-src[^;]*https:\/\/claude\.ai\/images\/desktop\//,
  );
  assert.equal(nextStep("hear", "Writer"), "first");
  assert.equal(nextStep("hear", "Writer", true), "quick-entry");
  assert.equal(nextStep("quick-entry", "Writer", true), "first");
  assert.equal(stepShown("quick-entry", "Writer"), false);
  const memory = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    },
  });
  try {
    saveStep("voice-shortcuts", "quick-entry");
    assert.equal(savedStep("voice-shortcuts", "Writer", true), "quick-entry");
    assert.equal(savedStep("voice-shortcuts", "Writer", false), "work");
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previous,
    });
  }
  for (const [platform, key] of [
    ["darwin", "Option"],
    ["win32", "Ctrl"],
    ["linux", "Ctrl"],
  ]) {
    const html = renderToStaticMarkup(
      createElement(QuickEntryOnboarding, {
        platform,
        onSettings() {},
        onContinue() {},
      }),
    );
    assert.match(html, /<em>Quick Entry<\/em>/);
    assert.match(html, /Quick entry settings/);
    assert.match(html, /Try Quick Entry/);
    assert.match(html, />Skip</);
    assert.match(html, new RegExp(`<kbd[^>]*>[^<]*${key}</kbd>`));
    assert.ok(!html.includes("claude.ai/images"));
  }
});

test("a denied microphone opens anchored guidance instead of reporting a toast", async () => {
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
  const { parseHTML } = await import("linkedom");
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.defineProperty(document, "oninput", {
    configurable: true,
    value: null,
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 320 },
    offsetHeight: { configurable: true, get: () => 160 },
  });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    innerWidth: 1000,
    innerHeight: 800,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
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
  let errors = 0;
  let opened = 0;
  Object.assign(window, {
    desktop: {
      requestMicrophone: async () => false,
      openMicrophoneSettings: async () => {
        opened++;
      },
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DictationButton } =
    await import("../../src/composer/voice/DictationButton");
  await import("../../src/voice/MicrophoneGuidance");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(DictationButton, {
          maxSeconds: null,
          contextKey: "permission",
          platform: "darwin",
          onLive() {},
          onTranscript() {},
          onCancel() {},
          onError() {
            errors++;
          },
        }),
      ),
    );
    const button =
      document.querySelector<HTMLButtonElement>(".dictation-button")!;
    assert.equal(button.getAttribute("aria-label"), "Press and hold to record");
    assert.equal(
      button.querySelector('[role="tooltip"]')?.textContent,
      "Press and hold to recordRight-click for microphone settings",
    );
    const dictation = (contextMenu: boolean) =>
      createElement(DictationButton, {
        maxSeconds: null,
        contextKey: "permission",
        platform: "darwin",
        contextMenu,
        onLive() {},
        onTranscript() {},
        onCancel() {},
        onError() {
          errors++;
        },
      });
    // With a ⌄ beside it (Chat), the microphone has no right-click menu or hint.
    await act(async () => root.render(dictation(false)));
    assert.equal(
      button.querySelector('[role="tooltip"]')?.textContent,
      "Press and hold to record",
    );
    assert.equal(button.getAttribute("aria-keyshortcuts"), null);
    assert.equal(button.getAttribute("aria-haspopup"), null);
    const plain = new window.Event("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(plain);
    assert.equal(plain.defaultPrevented, false);
    await act(async () => root.render(dictation(true)));
    await act(async () => button.click());
    const popup = document.querySelector('[role="dialog"]');
    assert.ok(popup);
    assert.match(popup.textContent!, /Microphone access is blocked/);
    assert.match(popup.textContent!, /Privacy and Security/);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(errors, 0);
    const settings = [
      ...popup.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Open System Settings")!;
    await act(async () => settings.click());
    assert.equal(opened, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await import("../../src/composer/MicrophoneMenu");
    await act(async () =>
      button.dispatchEvent(
        new window.Event("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    assert.ok(document.querySelector('[role="menu"]'));
    assert.equal(button.getAttribute("aria-keyshortcuts"), "Shift+F10");
    let refuse!: (error: Error) => void;
    window.desktop.requestMicrophone = () =>
      new Promise<boolean>((_, reject) => {
        refuse = reject;
      });
    const waiting = (contextKey: string) =>
      createElement(DictationButton, {
        maxSeconds: null,
        contextKey,
        onLive() {},
        onTranscript() {},
        onCancel() {},
        onError() {
          errors++;
        },
      });
    await act(async () => root.render(waiting("old-comment")));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".dictation-button")!.click(),
    );
    await act(async () => root.render(waiting("new-comment")));
    await act(async () => refuse(Error("Microphone access was not granted.")));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(errors, 0);
    let recognition: any;
    Object.assign(window, {
      SpeechRecognition: class {
        onend?: () => void;
        constructor() {
          recognition = this;
        }
        start() {}
        stop() {
          this.onend?.();
        }
        abort() {}
      },
    });
    const field = createRef<HTMLTextAreaElement>();
    const submitted: string[] = [];
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement("textarea", { ref: field }),
          createElement(DictationButton, {
            comment: true,
            engine: "browser",
            field,
            maxSeconds: null,
            contextKey: "pinned",
            onLive() {},
            onTranscript() {},
            onCancel() {},
            onError() {
              errors++;
            },
            onSubmit: (spoken) => submitted.push(spoken),
          }),
        ),
      ),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".comment-dictation")!.click(),
    );
    assert.equal(
      document.querySelector(".comment-dictation")?.getAttribute("aria-label"),
      "Finish dictating",
    );
    assert.equal(document.querySelector(".dictation-button.pill"), null);
    await act(async () =>
      recognition.onresult({
        resultIndex: 0,
        results: [{ 0: { transcript: "Move this chart" }, isFinal: true }],
      }),
    );
    const enter = (shiftKey: boolean) => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key: "Enter", shiftKey, isComposing: false });
      field.current!.dispatchEvent(event);
    };
    await act(async () => enter(true));
    assert.deepEqual(submitted, []);
    await act(async () => enter(false));
    assert.deepEqual(submitted, ["Move this chart"]);
    assert.equal(
      document.querySelector(".comment-dictation")?.getAttribute("aria-label"),
      "Dictate a comment",
    );
    const target = createRef<HTMLDivElement>();
    const events: string[] = [];
    await import("../../src/voice/DictationBar");
    const { Toaster } = await import("../../src/ui/Toaster");
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement("div", { ref: target, className: "recording-target" }),
          createElement(DictationButton, {
            recordingTarget: target,
            engine: "browser",
            maxSeconds: null,
            contextKey: "toolbar",
            onLive() {},
            onTranscript: (text: string) => events.push(text),
            onCancel: () => events.push("cancel"),
            onError: (error: unknown) => events.push((error as Error).message),
          }),
          createElement(Toaster),
        ),
      ),
    );
    const mic = document.querySelector<HTMLButtonElement>(".dictation-button")!;
    await act(async () => mic.click());
    assert.equal(mic.getAttribute("aria-label"), "Stop dictation");
    assert.ok(target.current?.querySelector(".dictation-waveform"));
    assert.ok(target.current?.querySelector('[aria-label="Cancel dictation"]'));
    assert.ok(target.current?.querySelector('[aria-label="Finish dictation"]'));
    assert.equal(document.querySelector(".dictation-button.pill"), null);
    await act(async () =>
      recognition.onresult({
        resultIndex: 0,
        results: [{ 0: { transcript: "Words to keep" }, isFinal: false }],
      }),
    );
    await act(async () => recognition.onerror({ error: "network" }));
    assert.deepEqual(events, ["Words to keep"]);
    const failure = currentToasts().find((toast) => !toast.closing)!;
    assert.equal(failure.message, "Dictation lost its connection.");
    assert.equal(
      failure.description,
      "Your words are in the message box, but the last few may be missing.",
    );
    assert.equal(failure.action?.label, "Dictate again");
    assert.ok(document.querySelector('.toast[data-variant="warning"]'));
    assert.equal(
      document.querySelector(".toast-description")?.textContent,
      failure.description,
    );
    assert.equal(target.current?.querySelector(".dictation-bar"), null);
    assert.ok(mic.classList.contains("dictation-error"));
    await act(
      async () =>
        new Promise((resolve) => setTimeout(resolve, dictationErrorMs + 20)),
    );
    assert.ok(!mic.classList.contains("dictation-error"));
    events.length = 0;
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".toast-action")!.click(),
    );
    assert.equal(mic.getAttribute("aria-label"), "Stop dictation");
    await act(async () => recognition.onerror({ error: "network" }));
    assert.deepEqual(events, ["cancel"]);
    assert.equal(
      currentToasts().find((toast) => !toast.closing)?.description,
      "Nothing was added to the message box.",
    );
    events.length = 0;
    await act(async () => mic.click());
    await act(async () =>
      recognition.onresult({
        resultIndex: 0,
        results: [
          { 0: { transcript: "Before the mic stopped" }, isFinal: false },
        ],
      }),
    );
    await act(async () => recognition.onerror({ error: "audio-capture" }));
    assert.deepEqual(events, ["Before the mic stopped"]);
    assert.equal(
      currentToasts().find((toast) => !toast.closing)?.message,
      "Your microphone stopped working.",
    );
    events.length = 0;
    await act(async () => mic.click());
    await act(async () =>
      recognition.onresult({
        resultIndex: 0,
        results: [{ 0: { transcript: "Before finishing" }, isFinal: false }],
      }),
    );
    recognition.stop = () => recognition.onerror({ error: "network" });
    await act(async () =>
      target
        .current!.querySelector<HTMLButtonElement>(
          '[aria-label="Finish dictation"]',
        )!
        .click(),
    );
    assert.deepEqual(events, ["Before finishing"]);
    await act(async () => mic.click());
    await act(async () =>
      target
        .current!.querySelector<HTMLButtonElement>(
          '[aria-label="Cancel dictation"]',
        )!
        .click(),
    );
    assert.equal(target.current?.querySelector(".dictation-bar"), null);
    await act(async () => mic.click());
    await act(async () =>
      target
        .current!.querySelector<HTMLButtonElement>(
          '[aria-label="Finish dictation"]',
        )!
        .click(),
    );
    assert.equal(target.current?.querySelector(".dictation-bar"), null);
    const { SelectionDictation } =
      await import("../../src/voice/SelectionDictation");
    const selectedNode = document.createElement("div");
    document.body.appendChild(selectedNode);
    const range = {
      startContainer: selectedNode,
      getClientRects: () => [{ left: 300, top: 300, bottom: 320, width: 100 }],
    } as unknown as Range;
    const replies: string[] = [];
    await act(async () =>
      root.render(
        createElement(SelectionDictation, {
          selection: { range, text: "Selected words" },
          engine: "browser",
          maxSeconds: null,
          platform: "darwin",
          shortcut: "CommandOrControl+D",
          boundary: createRef<HTMLElement>(),
          onError() {},
          onClose() {},
          onReply: (text) => replies.push(text),
        }),
      ),
    );
    assert.equal(
      document.querySelector(".selection-dictation-editor blockquote")
        ?.textContent,
      "Selected words",
    );
    assert.equal(
      document.querySelector(".comment-dictation")?.getAttribute("aria-label"),
      "Finish dictating",
    );
    await act(async () =>
      recognition.onresult({
        resultIndex: 0,
        results: [{ 0: { transcript: "A dictated reply" }, isFinal: true }],
      }),
    );
    assert.match(
      document.querySelector(".selection-dictation-editor textarea")!.outerHTML,
      /readonly/i,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".comment-dictation")!.click(),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(
        ".selection-dictation-editor textarea",
      )?.value,
      "A dictated reply",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!
        .click(),
    );
    assert.deepEqual(replies, ["A dictated reply"]);
  } finally {
    await act(async () => root.unmount());
    dismissAllToasts();
    hooks.deregister();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("microphone permission and System Settings are handled in the desktop main process", async () => {
  const opened: string[] = [];
  let allowed = true;
  const fake = {
    systemPreferences: {
      askForMediaAccess: async () => false,
      getMediaAccessStatus: () => "restricted",
    },
    shell: {
      openExternal: async (url: string) => {
        opened.push(url);
      },
    },
  };
  Object.assign(globalThis, { __voiceElectron: fake });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== "electron") return next(specifier, context);
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export const { systemPreferences, shell } = globalThis.__voiceElectron;",
          ),
      };
    },
  });
  try {
    const { registerTranscriptionHandlers } =
      await import("../../electron/ipc/transcription");
    const handlers = new Map<string, (...args: unknown[]) => any>();
    registerTranscriptionHandlers(
      (name, handler) => handlers.set(name, handler),
      { voiceAllowed: () => allowed } as never,
    );
    assert.equal(await handlers.get("requestMicrophone")!(), false);
    allowed = false;
    await assert.rejects(handlers.get("requestMicrophone")!(), /administrator/);
    await handlers.get("openMicrophoneSettings")!();
    assert.deepEqual(
      opened,
      process.platform === "darwin"
        ? [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
          ]
        : process.platform === "win32"
          ? ["ms-settings:privacy-microphone"]
          : [],
    );
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__voiceElectron");
  }
});

test("a failed start opens the microphone panel with the original's reason", async () => {
  const { microphoneReason, microphoneReasonCopy } =
    await import("../../src/voice/microphone-guidance");
  const named = (name: string) => Object.assign(Error("x"), { name });
  assert.equal(
    microphoneReason(named("NotAllowedError"), true),
    "permission_denied",
  );
  assert.equal(microphoneReason(named("NotFoundError"), true), "no_microphone");
  assert.equal(
    microphoneReason(named("NotReadableError"), false),
    "mic_unavailable",
  );
  assert.equal(microphoneReason(Error("socket"), true, 1), "connection_failed");
  assert.equal(microphoneReason(Error("socket"), true, 3), "start_failed");
  // A connection lost while recording is the toast's, not the panel's.
  assert.equal(microphoneReason(Error("socket"), false), null);
  assert.deepEqual(microphoneReasonCopy("no_microphone"), {
    title: "No microphone found",
    description: "Connect a microphone, then try again.",
  });
  assert.equal(
    microphoneReasonCopy("permission_denied").description,
    undefined,
  );
});
