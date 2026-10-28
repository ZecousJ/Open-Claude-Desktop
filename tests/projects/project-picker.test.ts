import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import type { Conversation, Project } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ProjectPicker } from "../../src/composer/ProjectPicker";
import {
  projectPickerRows,
  typedProjectName,
} from "../../src/composer/project-picker-model";
import {
  defaultProjectId,
  setDefaultProjectId,
} from "../../src/composer/project-picker-preferences";

const project = (id: string, name: string, createdAt: number): Project => ({
  id,
  name,
  createdAt,
  description: "",
  instructions: "",
});
const projects = [
  project("alpha", "Alpha", 1),
  project("beta", "Beta", 2),
  { ...project("old", "Archived", 3), archivedAt: 4 },
];

test("project picker sorts real metadata, excludes archived and incognito activity, and only offers new names", () => {
  const conversations = [
    { projectId: "alpha", updatedAt: 5, mode: "chat" },
    { projectId: "beta", updatedAt: 9, mode: "chat", incognito: true },
  ] as Conversation[];
  assert.deepEqual(
    projectPickerRows(projects, conversations, "", "recent").map((p) => p.id),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    projectPickerRows(projects, conversations, "", "created").map((p) => p.id),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    projectPickerRows(projects, conversations, "", "name").map((p) => p.id),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    projectPickerRows(projects, conversations, "  ALP ", "recent").map(
      (p) => p.id,
    ),
    ["alpha"],
  );
  assert.equal(typedProjectName(projects, " alpha "), undefined);
  assert.equal(typedProjectName(projects, "  New project  "), "New project");
  assert.equal(typedProjectName(projects, "   "), undefined);
});

test("project default is account isolated and removal works when storage is blocked", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        throw Error("blocked");
      },
      setItem() {
        throw Error("blocked");
      },
      removeItem() {
        throw Error("blocked");
      },
    },
  });
  try {
    setDefaultProjectId("picker-account-a", "alpha");
    assert.equal(defaultProjectId("picker-account-a"), "alpha");
    assert.equal(defaultProjectId("picker-account-b"), undefined);
    setDefaultProjectId("picker-account-a", undefined);
    assert.equal(defaultProjectId("picker-account-a"), undefined);
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("project picker keyboard defaults, sorting and typed creation keep the actual selection and form separate", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const storage = new Map<string, string>();
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
    left: 100,
    top: 500,
    bottom: 524,
    right: 172,
    x: 100,
    y: 500,
    width: 72,
    height: 24,
    toJSON() {},
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  const globals = {
    window,
    document,
    Event: window.Event,
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const picked: string[] = [],
    created: (string | undefined)[] = [];
  const trigger = () =>
    document.querySelector<HTMLButtonElement>(".cowork-options > button")!;
  const input = () =>
    document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const change = async (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), value);
      input().dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const key = async (value: string, modifiers = {}) => {
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key: value, ...modifiers });
    await act(() => input().dispatchEvent(event));
    return event;
  };
  try {
    const app = {
      accountId: "picker-ui-account",
      snapshot: { conversations: [] },
    } as unknown as AppController;
    const render = (catalog = projects) =>
      act(() =>
        root.render(
          createElement(
            AppContext.Provider,
            { value: app },
            createElement(ProjectPicker, {
              projects: catalog,
              platform: "darwin",
              collapsed: false,
              onProject: (id) => picked.push(id),
              onCreateProject: (name) => created.push(name),
            }),
          ),
        ),
      );
    await render();
    await act(() => trigger().click());
    assert.equal(focused, input());
    assert.ok(input().matches("label > input"));
    assert.ok(input().matches(".project-picker-search input"));
    assert.equal(
      input().getAttribute("placeholder"),
      "Search or create a project",
    );
    assert.equal(document.querySelectorAll('[role="option"]').length, 3);
    await change("中文");
    const chineseEscape = await key("Escape", { isComposing: true });
    assert.ok(document.querySelector(".project-picker"));
    assert.equal(input().value, "中文");
    assert.equal(chineseEscape.defaultPrevented, false);
    await change("日本語");
    const japaneseSafariEscape = await key("Escape", { keyCode: 229 });
    assert.ok(document.querySelector(".project-picker"));
    assert.equal(input().value, "日本語");
    assert.equal(japaneseSafariEscape.defaultPrevented, false);
    await change("");
    await key("ArrowDown");
    const activeBefore = input().getAttribute("aria-activedescendant");
    await render([...projects, project("gamma", "Gamma", 4)]);
    assert.equal(input().getAttribute("aria-activedescendant"), activeBefore);
    assert.equal(
      document.querySelector(
        '[role="option"][data-active] .project-picker-name',
      )?.textContent,
      "Beta",
      "a catalog update must not move keyboard selection to another project",
    );
    await render();
    await key("Enter", { altKey: true });
    assert.equal(defaultProjectId(app.accountId), "beta");
    assert.deepEqual(picked, []);
    assert.ok(document.querySelector('[aria-label="Remove default"]'));
    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Remove default"]')!
        .click(),
    );
    assert.equal(defaultProjectId(app.accountId), undefined);
    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Filter and sort"]')!
        .click(),
    );
    await act(() => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key: "ArrowDown" });
      document
        .querySelector('[aria-label="Filter and sort"]')!
        .dispatchEvent(event);
    });
    assert.equal(focused?.getAttribute("role"), "menuitemradio");
    await act(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      )
        .find((n) => n.textContent === "Name")!
        .click(),
    );
    assert.deepEqual(
      Array.from(document.querySelectorAll(".project-picker-name")).map(
        (n) => n.textContent,
      ),
      ["Alpha", "Beta", "New project"],
    );
    await key("Escape");
    assert.equal(document.querySelector('[role="menu"]'), null);
    await change("alp");
    await key("Enter");
    assert.deepEqual(picked, ["alpha"]);
    assert.equal(document.querySelector(".project-picker"), null);
    await act(() => trigger().click());
    await change("  Brand new  ");
    assert.match(
      document.querySelector(".project-picker")!.textContent!,
      /No matches.*Create Brand new/,
    );
    await key("Enter", { isComposing: true });
    assert.deepEqual(created, []);
    await key("Enter");
    assert.deepEqual(created, ["Brand new"]);
    assert.deepEqual(
      picked,
      ["alpha"],
      "typed create opens the form without selecting a fake project",
    );
    await act(() => trigger().click());
    await key("Escape");
    assert.equal(document.querySelector(".project-picker"), null);
    assert.equal(focused, trigger());
  } finally {
    await act(() => root.unmount());
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
  }
});

test("project picker geometry uses the captured width, 32px rows and a real 20px default action", () => {
  const css = readFileSync("src/composer/cowork-options.css", "utf8");
  assert.match(css, /\.project-picker\.cowork-menu\s*\{[^}]*width:\s*258px/);
  assert.match(css, /\.project-picker-row\s*\{[^}]*height:\s*32px/);
  assert.match(css, /\.project-picker-search input\s*\{[^}]*height:\s*32px/);
  assert.match(
    css,
    /\.project-picker \.project-picker-default\s*\{[^}]*width:\s*20px/,
  );
});

test("project search cancels the global label field margin with a more specific rule", () => {
  const foundation = readFileSync("src/styles/00-foundation.css", "utf8");
  const css = readFileSync("src/composer/cowork-options.css", "utf8");
  assert.match(
    foundation,
    /label > input,\s*label > textarea,\s*label > select\s*\{[^}]*margin-top:\s*7px;/,
  );
  const search = /\.project-picker-search input\s*\{([^}]*)\}/.exec(css);
  assert.ok(search);
  assert.match(search[1], /(?:^|;)\s*margin:\s*0;/);
  assert.match(search[1], /(?:^|;)\s*height:\s*32px;/);
  assert.match(search[1], /(?:^|;)\s*width:\s*100%;/);
  // Both selectors match the real input above. The class gives (0,1,1),
  // outranking label > input (0,0,2), regardless of stylesheet arrival order.
  // This is a cascade prerequisite; browser rectangle checks remain separate.
});
