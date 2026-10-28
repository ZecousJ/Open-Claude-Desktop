import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { parseHTML } from "linkedom";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import {
  newCodeEnvironmentShortcut,
  webCodeEnvironmentEntries,
} from "../../src/composer/web-code-environments";

const profile = (id: string, name: string): CloudEnvironmentConfig => ({
  id,
  name,
  network: "trusted",
  allowedDomains: [],
  includeDefaultDomains: true,
  variables: "",
  setupScript: "",
  updatedAt: 10,
});

test("New environment has an actionable platform shortcut and rejects composition or repeats", () => {
  const mac = {
    key: "º",
    code: "Digit0",
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    repeat: false,
    isComposing: false,
  } as KeyboardEvent;
  assert.equal(newCodeEnvironmentShortcut(mac, "darwin"), true);
  assert.equal(newCodeEnvironmentShortcut(mac, "win32"), false);
  assert.equal(
    newCodeEnvironmentShortcut(
      { ...mac, metaKey: false, ctrlKey: true } as KeyboardEvent,
      "win32",
    ),
    true,
  );
  for (const patch of [
    { isComposing: true },
    { repeat: true },
    { shiftKey: true },
    { altKey: false },
    { code: "Digit1" },
  ])
    assert.equal(
      newCodeEnvironmentShortcut(
        { ...mac, ...patch } as KeyboardEvent,
        "darwin",
      ),
      false,
    );
});

test("web environment root does not invent Default and retains truthful load failures", () => {
  const make = (extra: object = {}) =>
    webCodeEnvironmentEntries({
      environments: [],
      loaded: true,
      onChoose() {},
      onEdit() {},
      onCreate() {},
      onDownload() {},
      ...extra,
    });
  const empty = make();
  assert.deepEqual(
    empty.entries
      .filter((entry) => "label" in entry)
      .map((entry) => entry.label),
    ["Local", "Cloud", "New environment"],
  );
  const cloud = empty.entries.find(
    (entry) => "label" in entry && entry.label === "Cloud",
  )!;
  assert.ok("submenu" in cloud);
  assert.deepEqual(cloud.submenu, [
    { label: "No environments", disabled: true },
  ]);
  assert.deepEqual(make({ loaded: false }).entries[2], {
    ...empty.entries[2],
    submenu: [{ label: "Loading…", disabled: true }],
  });
  assert.deepEqual(make({ error: new Error("service absent") }).entries[2], {
    ...empty.entries[2],
    submenu: [{ label: "Couldn’t load cloud environments", disabled: true }],
  });
  assert.deepEqual(empty.searchEntries("Default"), []);
});

test("actual Menu searches real cloud leaf names then selects the matching id with keys", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><button id="opener">Choose environment</button><main></main></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
  const inputPrototype = window.HTMLInputElement.prototype;
  const oldFocus = window.HTMLElement.prototype.focus;
  const oldType = Object.getOwnPropertyDescriptor(inputPrototype, "type");
  Object.defineProperty(inputPrototype, "type", {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.getAttribute("type") || "text";
    },
    set(this: HTMLInputElement, value: string) {
      this.setAttribute("type", value);
    },
  });
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused ?? document.body,
  });
  Object.assign(globalThis, {
    window,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { WebCodeEnvironmentMenu } =
    await import("../../src/composer/WebCodeEnvironmentMenu");
  const root = createRoot(document.querySelector("main")!);
  const chosen: string[] = [];
  const edited: string[] = [];
  let closed = 0;
  const opener = document.getElementById("opener")!;
  opener.focus();
  const dispatchKey = async (target: Element, key: string) => {
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key });
    await act(async () => target.dispatchEvent(event));
  };
  try {
    function Popup() {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(WebCodeEnvironmentMenu, {
            options: {
              environments: [
                profile("env-a", "Project build"),
                profile("env-b", "Staging sandbox"),
              ],
              loaded: true,
              selectedId: "env-a",
              onChoose: (id) => chosen.push(id),
              onEdit: (env) => edited.push(env.id),
              onCreate() {},
              onDownload() {},
            },
            position: { left: 100, top: 100 },
            anchors: [],
            onClose: () => {
              closed++;
              setOpen(false);
            },
          })
        : null;
    }
    await act(async () => root.render(createElement(Popup)));
    const menu = document.querySelector<HTMLElement>(
      ".web-code-environment-menu",
    )!;
    assert.equal(menu.style.left, "100px");
    assert.equal(menu.style.top, "100px");
    assert.equal(menu.style.width, "260px");
    assert.equal(
      menu.querySelector(".web-code-environment-body")?.parentElement,
      menu,
    );
    const input = document.querySelector<HTMLInputElement>(
      ".web-code-environment-menu input",
    )!;
    assert.equal(focused, input);
    assert.equal(input.placeholder, "Search environments…");
    const local = document.querySelector(
      '.web-code-environment-body > [role="menuitemradio"]',
    )!;
    assert.deepEqual(
      Array.from(local.children).map((child) => child.tagName),
      ["SPAN", "SPAN", "SMALL"],
    );
    assert.equal(local.children[0].textContent, "Local");
    assert.equal(local.children[1].textContent, "Download");
    assert.equal(
      local.children[2].querySelector('[aria-hidden="true"]')?.textContent,
      "Desktop only",
    );
    assert.equal(
      local.children[2].querySelector(".sr-only")?.textContent,
      "Desktop only; Download the Claudex desktop app",
    );
    assert.equal(
      document.querySelector(
        ".web-code-environment-body > button:last-child small",
      )?.textContent,
      "⌥⌘0",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(inputPrototype, "value")!.set!.call(
        input,
        "STAGING",
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const rows = Array.from(
      document.querySelectorAll(".web-code-environment-body > button"),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].querySelector("span")?.textContent, "Staging sandbox");
    assert.equal(rows[0].getAttribute("role"), "menuitemradio");
    assert.equal(rows[0].getAttribute("aria-checked"), "false");
    assert.equal(document.querySelector('[aria-haspopup="menu"]'), null);
    await dispatchKey(input, "ArrowDown");
    assert.equal(focused, rows[0]);
    await dispatchKey(rows[0], "Enter");
    assert.deepEqual(chosen, ["env-b"]);
    assert.deepEqual(edited, []);
    assert.equal(closed, 1);
    assert.equal(document.querySelector(".web-code-environment-menu"), null);
    assert.equal(focused, opener);

    // A filtered selected profile still exposes its independent editing
    // action: Right edits that profile rather than choosing it again.
    await act(async () => root.render(createElement(Popup, { key: "edit" })));
    const editSearch = document.querySelector<HTMLInputElement>(
      ".web-code-environment-menu input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(inputPrototype, "value")!.set!.call(
        editSearch,
        "Project",
      );
      editSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const selected = document.querySelector(
      '.web-code-environment-body > [aria-checked="true"]',
    )!;
    assert.equal(
      selected.querySelector('[role="button"]')?.getAttribute("aria-label"),
      "Edit cloud environment",
    );
    await dispatchKey(editSearch, "ArrowDown");
    await dispatchKey(selected, "ArrowRight");
    assert.deepEqual(chosen, ["env-b"]);
    assert.deepEqual(edited, ["env-a"]);
    assert.equal(closed, 2);
    assert.equal(document.querySelector(".web-code-environment-menu"), null);
  } finally {
    await act(async () => root.unmount());
    if (oldType) Object.defineProperty(inputPrototype, "type", oldType);
    window.HTMLElement.prototype.focus = oldFocus;
    Object.assign(globalThis, previous);
  }
});
