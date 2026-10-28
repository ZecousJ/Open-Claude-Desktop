import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, createRef } from "react";
import { parseHTML } from "linkedom";
import type { Project } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ProjectPicker } from "../../src/composer/ProjectPicker";
import { CoworkOptions } from "../../src/composer/CoworkOptions";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { MicrophoneMenu } from "../../src/composer/MicrophoneMenu";
import {
  defaultProjectId,
  setDefaultProjectId,
} from "../../src/composer/project-picker-preferences";
import { draftProjectId } from "../../src/app/default-draft-project";

const alpha: Project = {
  id: "alpha",
  name: "Alpha",
  instructions: "",
  description: "",
  createdAt: 1,
};

async function environment(
  run: (env: {
    window: ReturnType<typeof parseHTML>["window"];
    document: Document;
    render(element: ReturnType<typeof createElement> | null): Promise<void>;
    key(
      target: HTMLElement,
      key: string,
      extra?: Record<string, unknown>,
    ): Promise<Event>;
  }) => Promise<void>,
) {
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
    right: 172,
    top: 500,
    bottom: 524,
    width: 72,
    height: 24,
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
    Event: window.Event,
    navigator: { userAgent: "node-test", language: "en-US" },
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    matchMedia: () => ({ matches: false }),
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await run({
      window,
      document,
      render: async (element) => {
        await act(async () => {
          root.render(element);
        });
      },
      key: async (target, key, extra = {}) => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { key, ...extra });
        await act(() => target.dispatchEvent(event));
        return event;
      },
    });
  } finally {
    await act(() => root.unmount());
    if (focus)
      Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    if (bounds)
      Object.defineProperty(
        window.HTMLElement.prototype,
        "getBoundingClientRect",
        bounds,
      );
    else
      Reflect.deleteProperty(
        window.HTMLElement.prototype,
        "getBoundingClientRect",
      );
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const app = {
  accountId: "cross-review-picker",
  snapshot: { conversations: [], settings: { recentWorkingDirs: [] } },
} as unknown as AppController;
const picker = () =>
  createElement(
    AppContext.Provider,
    { value: app },
    createElement(ProjectPicker, {
      projects: [alpha],
      platform: "darwin",
      collapsed: false,
      onProject() {},
      onCreateProject() {},
    }),
  );

test("cross review: IME Escape cancels composition without dismissing the project picker", async () => {
  await environment(async ({ document, render, key }) => {
    await render(picker());
    const trigger = document.querySelector<HTMLButtonElement>(
      ".cowork-options > button",
    )!;
    await act(() => trigger.click());
    const input = document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    const composingEscape = await key(input, "Escape", {
      isComposing: true,
      keyCode: 229,
    });
    assert.ok(
      document.querySelector(".project-picker"),
      "composition Escape must leave the picker open",
    );
    assert.equal(
      composingEscape.defaultPrevented,
      false,
      "IME must retain its native cancel behavior",
    );
    await key(input, "Escape");
    assert.equal(document.querySelector(".project-picker"), null);
    assert.equal(document.activeElement, trigger);
  });
});

test("cross review: keyboard can enter an already pointer-opened project sort menu", async () => {
  await environment(async ({ document, render, key }) => {
    await render(picker());
    await act(() =>
      document
        .querySelector<HTMLButtonElement>(".cowork-options > button")!
        .click(),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      ".project-picker-filter-trigger",
    )!;
    trigger.focus();
    await act(() => trigger.click());
    assert.ok(document.querySelector('.project-picker-filter[role="menu"]'));
    assert.equal(document.activeElement, trigger);
    await key(trigger, "ArrowDown");
    assert.equal(
      document.activeElement?.getAttribute("role"),
      "menuitemradio",
      "ArrowDown must focus an actual sort option even when the menu is already open",
    );
    assert.equal(document.activeElement?.getAttribute("aria-checked"), "true");
  });
});

test("cross review: typed project creation through CoworkOptions opens the form callback", async () => {
  await environment(async ({ window, document, render, key }) => {
    const forms: (string | undefined)[] = [];
    let direct = 0,
      selected = 0;
    await render(
      createElement(
        HostContext.Provider,
        { value: webHost },
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(CoworkOptions, {
            variant: "chat",
            platform: "darwin",
            projects: [alpha],
            setCwd() {},
            onProject() {
              selected++;
            },
            onCreateProject() {
              direct++;
            },
            onNewProject(name) {
              forms.push(name);
            },
            async pickFolder() {},
          }),
        ),
      ),
    );
    await act(() =>
      document
        .querySelector<HTMLButtonElement>(".cowork-options > button")!
        .click(),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "  Brand new  ");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await key(input, "Enter", { isComposing: true, keyCode: 229 });
    assert.deepEqual(forms, []);
    await key(input, "Enter");
    assert.deepEqual(forms, ["Brand new"]);
    assert.equal(direct, 0);
    assert.equal(selected, 0);
  });
});

test("cross review: the portaled project sort menu keeps inside presses and dismisses outside presses", async () => {
  await environment(async ({ window, document, render, key }) => {
    await render(picker());
    const trigger = document.querySelector<HTMLButtonElement>(
      ".cowork-options > button",
    )!;
    await act(() => trigger.click());
    const filter = document.querySelector<HTMLButtonElement>(
      ".project-picker-filter-trigger",
    )!;
    filter.focus();
    await act(() => filter.click());
    const option = document.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"]',
    )!;
    await act(() =>
      option.dispatchEvent(new window.Event("pointerdown", { bubbles: true })),
    );
    assert.ok(
      document.querySelector(".project-picker-filter"),
      "a press inside the portaled filter must not dismiss its picker",
    );
    await key(option, "Escape");
    assert.equal(document.querySelector(".project-picker-filter"), null);
    assert.ok(
      document.querySelector(".project-picker"),
      "the first Escape closes only the nested filter",
    );
    assert.equal(
      document.activeElement,
      document.querySelector('input[role="combobox"]'),
    );
    await act(() =>
      document
        .querySelector("#anchor")!
        .dispatchEvent(new window.Event("pointerdown", { bubbles: true })),
    );
    assert.equal(document.querySelector(".project-picker"), null);
    assert.equal(document.activeElement, trigger);
  });
});

test("cross review: remembered projects are isolated and invalid defaults never enter new drafts", async () => {
  await environment(async () => {
    setDefaultProjectId("cross-review-account-a", "alpha");
    setDefaultProjectId("cross-review-account-b", "beta");
    assert.equal(defaultProjectId("cross-review-account-a"), "alpha");
    assert.equal(defaultProjectId("cross-review-account-b"), "beta");
    for (const projects of [[], [{ ...alpha, archivedAt: 5 }]])
      assert.equal(
        draftProjectId({
          mode: "chat",
          incognito: false,
          defaultId: defaultProjectId("cross-review-account-a"),
          projects,
        }),
        undefined,
      );
    assert.equal(
      draftProjectId({
        mode: "chat",
        incognito: false,
        defaultId: defaultProjectId("cross-review-account-b"),
        projects: [alpha],
      }),
      undefined,
    );
    assert.equal(
      draftProjectId({
        mode: "chat",
        incognito: true,
        defaultId: "alpha",
        projects: [alpha],
      }),
      undefined,
    );
  });
});

test("cross review: closing the idle microphone menu invalidates late device enumeration", async () => {
  await environment(async ({ document, render }) => {
    let resolve!: (value: unknown[]) => void;
    let requestedAudio = 0,
      closed = 0;
    Object.assign(navigator, {
      mediaDevices: {
        enumerateDevices: () =>
          new Promise((next) => {
            resolve = next;
          }),
        getUserMedia: () => {
          requestedAudio++;
          throw Error("must not request audio");
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const anchor = createRef<HTMLElement>();
    anchor.current = document.querySelector("#anchor")!;
    await render(
      createElement(MicrophoneMenu, {
        variant: "idle",
        anchor,
        onClose() {
          closed++;
        },
      }),
    );
    assert.ok(document.querySelector(".microphone-menu"));
    await render(null);
    await act(async () =>
      resolve([{ kind: "audioinput", deviceId: "late", label: "Late device" }]),
    );
    assert.equal(document.querySelector(".microphone-menu"), null);
    assert.equal(requestedAudio, 0);
    assert.equal(closed, 0);
  });
});
