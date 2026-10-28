import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import {
  TaskPermissionPicker,
  taskPermissionEntries,
} from "../../src/composer/TaskPermissionPicker";
import { CodeModelTrigger } from "../../src/composer/CodeModelTrigger";
import { modelTriggerLabel } from "../../src/composer/model-trigger-label";
import { setLocale } from "../../src/i18n";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { TaskPermission } from "../../shared/settings-extras";
import { readFileSync } from "node:fs";

async function environment(
  run: (fixture: {
    document: Document;
    render(element: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
    key(target: Element, key: string): Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.innerWidth = 1440;
  window.innerHeight = 900;
  window.desktop = {
    customizeSkills: async () => [],
    listDesignSystems: async () => [],
  } as never;
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100,
    y: 500,
    top: 500,
    left: 100,
    bottom: 524,
    right: 150,
    width: 50,
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
    navigator: { userAgent: "node-test", language: "en-US" },
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: () => 1,
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
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
  try {
    await run({
      document,
      render: (element) => act(async () => root.render(element)),
      click: async (selector) => {
        const target = document.querySelector<HTMLButtonElement>(selector);
        assert.ok(target, selector);
        await act(async () => {
          target.dispatchEvent(
            new window.Event("pointerdown", {
              bubbles: true,
              cancelable: true,
            }),
          );
          target.click();
        });
      },
      key: (target, key) =>
        act(async () => {
          const event = new window.Event("keydown", {
            bubbles: true,
            cancelable: true,
          });
          Object.assign(event, { key });
          target.dispatchEvent(event);
        }),
    });
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("current web Add menu omits duplicate project/search/thinking roots, keeps real Research, and preserves legacy actions", async () => {
  await environment(async ({ document, render, click }) => {
    const actions: string[] = [];
    const menu = (presentation: "web-chat" | "legacy", research = true) =>
      createElement(
        "div",
        { className: "popover-anchor" },
        createElement(ComposerAddMenu, {
          presentation,
          platform: "darwin",
          projects: [],
          webSearch: true,
          webSearchAvailable: true,
          onWebSearch: () => actions.push("search"),
          research: false,
          researchAvailable: true,
          onResearch: research ? () => actions.push("research") : undefined,
          thinking: true,
          onThinking: () => actions.push("thinking"),
          onFiles: () => actions.push("files"),
          onGitHub: () => actions.push("github"),
          onProject: () => actions.push("project"),
          onCreateProject: () => actions.push("create"),
          onSettings: (tab) => actions.push(tab),
          onUnavailable() {},
          onClose: () => actions.push("close"),
        }),
      );
    const rows = () =>
      [
        ...document.querySelectorAll(
          ".composer-add-menu > button, .composer-add-menu > .composer-add-branch > button",
        ),
      ].map((button) =>
        button
          .querySelector(":scope > span:not([data-icon])")
          ?.textContent?.trim(),
      );
    await render(menu("web-chat"));
    assert.deepEqual(rows(), [
      "Upload or add files",
      "Skills",
      "Add connector",
      "Design system",
      "Add plugins",
      "Research",
    ]);
    assert.equal(document.querySelector('[data-add-branch="project"]'), null);
    await click(".composer-add-research");
    assert.deepEqual(actions, ["close", "research"]);
    actions.length = 0;
    await render(menu("legacy"));
    for (const label of [
      "Add to project",
      "Web search",
      "Extended thinking",
      "Add content from GitHub",
    ])
      assert.ok(rows().includes(label));
    assert.throws(
      () => assert.ok(!rows().includes("Add to project")),
      { code: "ERR_ASSERTION" },
      "the old root is a negative control for the captured web variant",
    );
    await render(menu("web-chat", false));
    assert.equal(
      rows().includes("Research"),
      false,
      "a missing research handler never creates a fake available action",
    );
    assert.notEqual(
      document
        .querySelector(".composer-add-menu")
        ?.lastElementChild?.getAttribute("role"),
      "separator",
      "filtered actions do not leave a trailing separator",
    );
  });
});

test("current web Permission mode contains exactly two real radio actions; legacy bypass and cloud restrictions retain their behavior", async () => {
  await environment(async ({ document, render, click, key }) => {
    const selected: string[] = [];
    const picker = (
      presentation: "web-chat" | "legacy",
      value: TaskPermission = "auto",
    ) =>
      createElement(TaskPermissionPicker, {
        presentation,
        settings: { taskPermission: value },
        onChange: (mode) => selected.push(mode),
      });
    await render(picker("web-chat"));
    await click(".task-permission-trigger");
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
    assert.ok(document.querySelector(".menu.task-permission-web-chat"));
    const check = document.querySelector<HTMLElement>(
      ".task-permission-check",
    )!;
    assert.equal(check.tagName.toLowerCase(), "svg");
    assert.equal(check.getAttribute("data-icon"), "Check");
    assert.equal(check.getAttribute("width"), "20");
    assert.deepEqual(
      rows.map(
        (button) => button.querySelector(".menu-item-text > span")?.textContent,
      ),
      ["Manual", "Auto"],
    );
    assert.deepEqual(
      rows.map((button) => button.getAttribute("aria-checked")),
      ["false", "true"],
    );
    assert.equal(document.querySelector('[role="menuitemcheckbox"]'), null);
    assert.equal(
      document.querySelector<HTMLElement>('[role="menu"]')?.style.width,
      "288px",
    );
    await key(document.querySelector('[role="menu"]')!, "Home");
    assert.equal(document.activeElement, rows[0]);
    await key(rows[0], "Enter");
    assert.deepEqual(selected, ["default"]);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(
      document.querySelector(".task-permission-label")?.textContent,
      "Auto",
      "a pending or rejected preference write cannot invent a successful mode change",
    );
    await render(picker("web-chat", "default"));
    assert.equal(
      document.querySelector(".task-permission-label")?.textContent,
      "Manual",
      "the trigger updates only when its actual stored value changes",
    );
    await click(".task-permission-trigger");
    await click('[role="menuitemradio"][aria-checked="false"]');
    assert.deepEqual(
      selected,
      ["default", "auto"],
      "a real inside pointer press reaches the popup action before dismissal",
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    await render(picker("legacy"));
    await click(".task-permission-trigger");
    assert.match(
      document.querySelector('[role="menu"]')?.textContent ?? "",
      /Skip all approvals/,
    );
    const filtered = taskPermissionEntries(
      "default",
      () => {},
      undefined,
      true,
      [],
      "web-chat",
    );
    assert.equal(filtered.length, 3);
    assert.ok("disabled" in filtered[2] && filtered[2].disabled);
    const current = taskPermissionEntries(
      "auto",
      () => {},
      undefined,
      true,
      [],
      "web-chat",
    );
    assert.ok(
      !("disabled" in current[2]),
      "the actually selected Auto is never disabled by missing supported metadata",
    );
    assert.equal(
      taskPermissionEntries("auto", () => {}).length,
      4,
      "native/task windows retain their three choices",
    );
    assert.throws(
      () => assert.equal(taskPermissionEntries("auto", () => {}).length, 3),
      { code: "ERR_ASSERTION" },
    );
  });
});

test("current web permission geometry loads with the private popup and derives its height from the captured text metrics", () => {
  const read = (file: string) =>
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const css = read("src/composer/task-permission-menu.css");
  // A generic .menu.compact sheet can be loaded later. These two rules
  // must win the cascade, including the 1px ring and 7px row bottom.
  assert.match(
    css,
    /:root\[data-surface="web"\] \.menu\.task-permission-web-chat\s*\{/,
  );
  assert.match(
    css,
    /:root\[data-surface="web"\]\s+\.menu\.task-permission-web-chat\s+> button\.has-description\s*\{/,
  );
  assert.match(
    read("src/composer/TaskPermissionMenu.tsx"),
    /import "\.\/task-permission-menu\.css"/,
  );
  assert.doesNotMatch(read("src/main.tsx"), /task-permission-menu\.css/);
  assert.match(
    css,
    /\.menu\.task-permission-web-chat\s*\{[^}]*padding:\s*4px;[^}]*border-bottom:\s*1px solid transparent;[^}]*border-radius:\s*12px;/,
  );
  assert.match(
    css,
    /> \.menu-heading\s*\{[^}]*height:\s*auto;[^}]*padding:\s*4px 10px;[^}]*font-size:\s*13px;[^}]*line-height:\s*17px;/,
  );
  assert.match(
    css,
    /> button\.has-description\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*6px 10px 7px;/,
  );
  assert.match(
    css,
    /\.menu-description\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*17px;/,
  );
  assert.doesNotMatch(css, /(?:min-)?height:\s*168px|width:\s*220px/);
  assert.equal(4 + 4 + 1 + (4 + 17 + 4) + 2 * (6 + 20 + 2 * 17 + 7), 168);
  const assertCapturedMetrics = (sheet: string) =>
    assert.match(sheet, /padding:\s*6px 10px 7px;/);
  assert.throws(
    () => assertCapturedMetrics(read("src/ui/menu.css")),
    { code: "ERR_ASSERTION" },
    "the old generic popup cannot satisfy the captured permission row chain",
  );
});

test("model trigger labels announce the real catalog model and every active effort without inventing a model", async () => {
  const catalog: ModelCatalog = {
    defaultModel: "r4-real-model",
    items: [
      {
        id: "r4-real-model",
        displayName: "Actual model",
        description: "",
        badges: [],
        sort: 1,
        hidden: false,
        isDefault: true,
        fast: false,
        usageHint: "",
      },
    ],
  };
  assert.equal(
    modelTriggerLabel("r4-real-model", "high", catalog),
    "Model: Actual model High",
  );
  assert.equal(
    modelTriggerLabel("r4-unlisted-model", "low", catalog),
    "Model: r4-unlisted-model Low",
  );
  assert.equal(
    modelTriggerLabel("", "medium", catalog),
    "Model: Select model Medium",
  );
  assert.equal(
    modelTriggerLabel("r4-real-model", "ultra", catalog),
    "Model: Actual model Ultracode",
  );
  const actual = parseHTML(
    renderToStaticMarkup(
      createElement(CodeModelTrigger, {
        model: "r4-unlisted-code",
        effort: "xhigh",
      }),
    ),
  ).document.querySelector("button")!;
  assert.equal(
    actual.getAttribute("aria-label"),
    "Model: r4-unlisted-code Extra",
  );
  const assertNamed = (label: string | null) =>
    assert.equal(label, "Model: r4-unlisted-code Extra");
  assert.throws(() => assertNamed("Switch models"), { code: "ERR_ASSERTION" });
  assert.throws(() => assertNamed("Model: r4-unlisted-code"), {
    code: "ERR_ASSERTION",
  });
  try {
    await setLocale("zh-CN");
    assert.equal(
      modelTriggerLabel("r4-real-model", "high", catalog),
      "模型：Actual model 高",
    );
  } finally {
    await setLocale("en-US");
  }
});
