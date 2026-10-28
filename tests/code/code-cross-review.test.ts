import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  act,
  createElement,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { parseHTML } from "linkedom";
import type { CodeEffort, Settings } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { CodeModelMenu } from "../../src/composer/model/CodeModelMenu";
import { CodeModelTrigger } from "../../src/composer/CodeModelTrigger";
import { fastModeState } from "../../src/composer/code/code-fast-mode";
import { WebCodeEnvironmentMenu } from "../../src/composer/WebCodeEnvironmentMenu";
import { Menu } from "../../src/ui/Menu";
import { readSource } from "../support/read-source";
import { codeLiveLayout } from "../../src/composer/code-live-layout";

const noop = () => {};
const composerSource = readSource("src/composer/Composer.tsx");
// Run the production keyboard functions with real components. The full
// Composer also owns browser editor/service hooks outside this menu test.
const shortcutSection = composerSource.slice(
  composerSource.indexOf("// ⇧⌘I opens Code's model menu"),
);
const shortcutBody = shortcutSection.slice(
  shortcutSection.indexOf("const listener = (event: KeyboardEvent) => {") +
    "const listener = (event: KeyboardEvent) => {".length,
  shortcutSection.indexOf("\n    };"),
);
assert.ok(shortcutBody.includes("toggleFastKey.current()"));
const fastBody = composerSource.match(
  /toggleFastKey\.current = \(\) => \{([\s\S]*?)\n  \};/,
)?.[1];
assert.ok(fastBody);

const provider: Settings["providers"][number] = {
  id: "actual",
  name: "Actual service",
  baseUrl: "https://example.invalid/v1",
  protocol: "responses",
  model: "claude-opus-5-5",
  models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
};
const catalog: ModelCatalog = {
  defaultModel: "claude-opus-5-5",
  items: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map(
    (id, index): ModelCatalog["items"][number] => ({
      id,
      displayName: id,
      description: `${id} actual description`,
      badges: [],
      sort: index,
      hidden: index === 2,
      isDefault: index === 0,
      usageHint: "",
      efforts: ["low", "medium", "high"],
    }),
  ),
};

async function environment() {
  const { window, document } = parseHTML(
    '<html><body><button id="outside">Outside</button><main></main></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
  let focused: HTMLElement | undefined;
  const oldFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const oldType = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "type",
  );
  Object.defineProperty(window.HTMLInputElement.prototype, "type", {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.getAttribute("type") || "text";
    },
    set(this: HTMLInputElement, value: string) {
      this.setAttribute("type", value);
    },
  });
  window.innerWidth = 1440;
  window.innerHeight = 900;
  Object.assign(window, {
    desktop: { modelCatalog: async () => catalog, onEvent: () => noop },
  });
  const frames: FrameRequestCallback[] = [];
  const globals = {
    window,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
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
  const root = createRoot(document.querySelector("main")!);
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const callback of frames.splice(0)) callback(0);
    });
  return {
    window,
    document,
    root,
    flush,
    async render(element: ReturnType<typeof createElement>) {
      await act(async () => root.render(element));
      await flush();
    },
    async click(target: Element) {
      await act(async () =>
        target.dispatchEvent(
          new window.Event("click", { bubbles: true, cancelable: true }),
        ),
      );
      await flush();
    },
    async key(target: Element, key: string, extra: object = {}) {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key, ...extra });
      await act(async () => target.dispatchEvent(event));
      await flush();
    },
    async input(input: HTMLInputElement, value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await flush();
    },
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.focus = oldFocus;
      if (oldType)
        Object.defineProperty(
          window.HTMLInputElement.prototype,
          "type",
          oldType,
        );
      else Reflect.deleteProperty(window.HTMLInputElement.prototype, "type");
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function ComposerMenuControls({
  native = false,
  opened = false,
}: {
  native?: boolean;
  opened?: boolean;
}) {
  const [modelMenu, setModelMenu] = useState(false);
  const [effortOpenRequest, setEffortOpenRequest] = useState(0);
  const [permissionOpenRequest, setPermissionOpenRequest] = useState(0);
  const [effort, setEffort] = useState<CodeEffort>("medium");
  const codeHomeDraft = !opened;
  const toggleFast = new Function(
    "fastModeState",
    "catalog",
    "model",
    "setModel",
    "setModelMenu",
    "codeHomeDraft",
    "setEffortOpenRequest",
    fastBody!,
  );
  const listener = new Function(
    "event",
    "platform",
    "surface",
    "codeHomeDraft",
    "setAddMenu",
    "setModelMenu",
    "setEffortOpenRequest",
    "setPermissionOpenRequest",
    "toggleFastKey",
    "document",
    shortcutBody,
  );
  return createElement(
    "div",
    {
      onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) =>
        listener(
          event,
          "darwin",
          native ? "desktop" : "web",
          codeHomeDraft,
          noop,
          setModelMenu,
          setEffortOpenRequest,
          setPermissionOpenRequest,
          {
            current: () =>
              toggleFast(
                fastModeState,
                catalog,
                provider.model,
                noop,
                setModelMenu,
                codeHomeDraft,
                setEffortOpenRequest,
              ),
          },
          document,
        ),
    },
    createElement(CodeModelTrigger, {
      model: provider.model,
      effort,
      "aria-expanded": modelMenu,
      onClick: () => {
        setEffortOpenRequest(0);
        setModelMenu(!modelMenu);
      },
    }),
    createElement("output", { "data-permission": true }, permissionOpenRequest),
    modelMenu &&
      createElement(CodeModelMenu, {
        providers: [provider],
        providerId: provider.id,
        model: provider.model,
        onSelect: noop,
        onManage: noop,
        onClose: () => {
          setModelMenu(false);
          if (codeHomeDraft) setEffortOpenRequest(0);
        },
        sessionEffort: codeHomeDraft
          ? {
              value: effort,
              openRequest: effortOpenRequest,
              onChange: setEffort,
            }
          : undefined,
      }),
  );
}

test("production Composer shortcuts switch an already-open Effort menu back to the model root", async () => {
  const env = await environment();
  try {
    await env.render(createElement(ComposerMenuControls));
    const trigger = env.document.querySelector<HTMLElement>(
      ".web-code-model-trigger",
    )!;
    trigger.focus();
    await env.key(trigger, "e", {
      code: "KeyE",
      metaKey: true,
      shiftKey: true,
    });
    assert.ok(env.document.querySelector(".code-session-effort"));
    await env.key(env.document.activeElement as HTMLElement, "i", {
      code: "KeyI",
      metaKey: true,
      shiftKey: true,
    });
    assert.ok(env.document.querySelector(".code-session-model-menu"));
    assert.equal(
      Boolean(env.document.querySelector(".code-session-effort")),
      false,
      "Effort submenu should be closed",
    );
  } finally {
    await env.restore();
  }
});

test("production Permissions then unavailable Fast fallback must not replay an old Effort request", async () => {
  const env = await environment();
  try {
    await env.render(createElement(ComposerMenuControls));
    const trigger = env.document.querySelector<HTMLElement>(
      ".web-code-model-trigger",
    )!;
    trigger.focus();
    await env.key(trigger, "e", {
      code: "KeyE",
      metaKey: true,
      shiftKey: true,
    });
    assert.ok(env.document.querySelector(".code-session-effort"));
    await env.key(env.document.activeElement as HTMLElement, "m", {
      code: "KeyM",
      metaKey: true,
      altKey: true,
    });
    assert.equal(
      Boolean(env.document.querySelector(".code-model-menu")),
      false,
      "Model menu should be closed",
    );
    assert.equal(
      env.document.querySelector("[data-permission]")?.textContent,
      "1",
    );
    await env.key(trigger, "f", { code: "KeyF", metaKey: true, altKey: true });
    assert.ok(env.document.querySelector(".code-session-model-menu"));
    assert.equal(
      Boolean(env.document.querySelector(".code-session-effort")),
      false,
      "Effort submenu should be closed",
    );
  } finally {
    await env.restore();
  }
});

test("real Code model Close clears requests before trigger reopen and opened sessions keep their original menu", async () => {
  const env = await environment();
  try {
    await env.render(createElement(ComposerMenuControls));
    const trigger = env.document.querySelector<HTMLElement>(
      ".web-code-model-trigger",
    )!;
    trigger.focus();
    await env.key(trigger, "e", {
      code: "KeyE",
      metaKey: true,
      shiftKey: true,
    });
    const rows = [
      ...env.document.querySelectorAll<HTMLElement>(
        '.code-session-effort [role="menuitemradio"]',
      ),
    ];
    await env.click(rows[0]);
    assert.equal(
      Boolean(env.document.querySelector(".code-model-menu")),
      false,
      "Model menu should be closed",
    );
    assert.equal(env.document.activeElement, trigger);
    await env.click(trigger);
    assert.equal(
      Boolean(env.document.querySelector(".code-session-effort")),
      false,
      "Effort submenu should be closed",
    );
    assert.match(trigger.getAttribute("aria-label")!, /Low$/);
    await env.key(trigger, "e", {
      code: "KeyE",
      metaKey: true,
      shiftKey: true,
    });
    await env.key(env.document.activeElement as HTMLElement, "Escape");
    assert.ok(env.document.querySelector(".code-session-model-menu"));
    await env.key(env.document.activeElement as HTMLElement, "Escape");
    assert.equal(
      Boolean(env.document.querySelector(".code-model-menu")),
      false,
    );
    await env.click(trigger);
    assert.equal(
      Boolean(env.document.querySelector(".code-session-effort")),
      false,
    );
    await env.render(
      createElement(ComposerMenuControls, {
        key: "native",
        native: true,
        opened: true,
      }),
    );
    const native = env.document.querySelector<HTMLElement>(
      ".web-code-model-trigger",
    )!;
    await env.click(native);
    assert.equal(
      env.document.querySelector(".code-session-model-heading"),
      null,
    );
    assert.equal(
      Boolean(env.document.querySelector("[data-code-effort]")),
      false,
    );
  } finally {
    await env.restore();
  }
});

test("Composer gives session Effort to both home hosts and keeps the opened-session slider", () => {
  const surfaceGuard = composerSource.match(
    /const webSurface\s*=\s*([\s\S]*?);/,
  )?.[1];
  const draftGuard = composerSource.match(
    /const codeHomeDraft\s*=\s*([\s\S]*?);/,
  )?.[1];
  assert.ok(surfaceGuard);
  assert.ok(draftGuard);
  const evaluate = new Function(
    "host",
    "mode",
    "active",
    "window",
    `const webSurface=(${surfaceGuard});return (${draftGuard});`,
  ) as (
    host: { kind: "web" | "desktop" },
    mode: "chat" | "cowork" | "code",
    active: { id: string } | undefined,
    window: { ClaudexConversation?: object } | undefined,
  ) => boolean;
  for (const kind of ["web", "desktop"] as const)
    for (const mode of ["chat", "cowork", "code"] as const)
      for (const active of [undefined, { id: "existing" }])
        for (const window of [undefined, {}, { ClaudexConversation: {} }])
          assert.equal(
            evaluate({ kind }, mode, active, window),
            mode === "code" && !active,
            `${kind}/${mode}/${active ? "existing" : "draft"}/${window && "ClaudexConversation" in window ? "native controller" : "browser or SSR"}`,
          );
  // The Code home draft and a web Code session share the live footer
  // (session Effort in the model menu); a desktop session keeps its slider.
  assert.match(
    composerSource,
    /const liveCode = codeLiveLayout\(mode, host, codeHomeDraft\);/,
  );
  assert.match(composerSource, /sessionEffort=\{\s*liveCode\s*\?/);
  assert.match(
    composerSource,
    /mode === "code" && !liveCode \? \(\s*<CodeEffortSlider/,
  );
  for (const kind of ["web", "desktop"] as const)
    for (const mode of ["chat", "cowork", "code"] as const)
      for (const draft of [true, false])
        assert.equal(
          codeLiveLayout(mode, { kind }, draft),
          draft || (mode === "code" && kind === "web"),
          `${kind}/${mode}/${draft ? "home draft" : "opened"}`,
        );
});

test("environment body wrapper preserves real portal search, keyboard selection, edit, and default Menu DOM", async () => {
  const env = await environment();
  const chosen: string[] = [],
    edited: string[] = [];
  let closed = 0;
  const profile = (id: string, name: string) => ({
    id,
    name,
    network: "trusted" as const,
    allowedDomains: [],
    includeDefaultDomains: true,
    variables: "",
    setupScript: "",
    updatedAt: 1,
  });
  function Popup() {
    const [open, setOpen] = useState(true);
    return open
      ? createElement(WebCodeEnvironmentMenu, {
          position: { left: 100, top: 100 },
          anchors: [],
          onClose: () => {
            closed++;
            setOpen(false);
          },
          options: {
            environments: [
              profile("first", "Build"),
              profile("wanted", "STAGING"),
            ],
            loaded: true,
            selectedId: "first",
            onChoose: (id) => chosen.push(id),
            onEdit: (row) => edited.push(row.id),
            onCreate: noop,
            onDownload: noop,
          },
        })
      : null;
  }
  try {
    const opener = env.document.querySelector<HTMLElement>("#outside")!;
    opener.focus();
    await env.render(createElement(Popup));
    const input = env.document.querySelector<HTMLInputElement>(
      ".web-code-environment-menu input",
    )!;
    assert.equal(env.document.activeElement, input);
    await env.input(input, "staging");
    assert.equal(
      env.document.querySelectorAll(".web-code-environment-body > button")
        .length,
      1,
    );
    await env.key(input, "ArrowDown");
    const row = env.document.querySelector<HTMLElement>(
      ".web-code-environment-body > button",
    )!;
    assert.equal(env.document.activeElement, row);
    await env.key(row, "Enter");
    assert.deepEqual(chosen, ["wanted"]);
    assert.equal(closed, 1);
    assert.equal(
      Boolean(env.document.querySelector(".web-code-environment-menu")),
      false,
    );
    assert.equal(env.document.activeElement === opener, true);
    await env.render(createElement(Popup, { key: "edit" }));
    const editInput = env.document.querySelector<HTMLInputElement>(
      ".web-code-environment-menu input",
    )!;
    await env.input(editInput, "STAGING");
    await env.key(editInput, "ArrowDown");
    const editRow = env.document.querySelector<HTMLElement>(
      ".web-code-environment-body > button",
    )!;
    await env.key(editRow, "ArrowRight");
    assert.deepEqual(edited, ["wanted"]);
    assert.equal(closed, 2);
    assert.equal(
      Boolean(env.document.querySelector(".web-code-environment-menu")),
      false,
    );
    assert.equal(env.document.activeElement === opener, true);
    await env.render(
      createElement(Menu, {
        entries: [{ label: "Plain", onSelect: noop }],
        position: { left: 0, top: 0 },
        width: 100,
        label: "Plain menu",
        onClose: noop,
      }),
    );
    assert.ok(
      env.document.querySelector(
        '[aria-label="Plain menu"] > button[data-index="0"]',
      ),
    );
    assert.equal(
      env.document.querySelector(".web-code-environment-body"),
      null,
    );
  } finally {
    await env.restore();
  }
});
