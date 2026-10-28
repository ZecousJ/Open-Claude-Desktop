import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  act,
  createElement,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { Store, defaultSettings } from "../../electron/store/store";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import type { Settings } from "../../shared/types";
import { CodeThemePickers } from "../../src/settings/tabs/CodeAppearance";
import { useAppearance } from "../../src/settings/useAppearance";
import {
  applyCodeTheme,
  clearCodeTheme,
  codeColorRoles,
  codeThemeForMode,
  codeThemePreviewVariables,
  githubCodePalettes,
} from "../../src/settings/code-theme-palettes";
import { DiffLines } from "../../src/diff/DiffLines";
import { loadHighlight } from "../../src/ui/lazy-highlight";
import { readSource } from "../support/read-source";

const source = (file: string) =>
  readSource(new URL(`../../${file}`, import.meta.url), "utf8");
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("only supported mode-specific theme IDs validate and survive a real store restart", () => {
  assert.equal(preference(defaultSettings, "codeLightTheme"), "claudex-light");
  assert.equal(preference(defaultSettings, "codeDarkTheme"), "claudex-dark");
  assert.equal(
    preferenceFields.codeLightTheme.safeParse("github-light").success,
    true,
  );
  assert.equal(
    preferenceFields.codeDarkTheme.safeParse("github-dark").success,
    true,
  );
  for (const value of ["github-dark", "contrast-light", "unknown", null])
    assert.equal(
      preferenceFields.codeLightTheme.safeParse(value).success,
      false,
    );
  for (const value of ["github-light", "contrast-dark", "unknown", null])
    assert.equal(
      preferenceFields.codeDarkTheme.safeParse(value).success,
      false,
    );
  assert.equal(
    codeThemeForMode("light", "github-dark", "github-dark"),
    "claudex-light",
  );
  assert.equal(
    codeThemeForMode("dark", "github-light", "missing"),
    "claudex-dark",
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-r4-settings-theme-"),
  );
  try {
    const store = new Store(directory);
    store.settings = {
      ...store.settings,
      codeLightTheme: "github-light",
      codeDarkTheme: "github-dark",
    };
    store.flush();
    const restarted = new Store(directory);
    assert.equal(restarted.settings.codeLightTheme, "github-light");
    assert.equal(restarted.settings.codeDarkTheme, "github-dark");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("all 15 palette roles match the installed BSD-3 GitHub assets exactly", () => {
  const selectors = {
    foreground: [".hljs", "color"],
    background: [".hljs", "background"],
    keyword: [".hljs-keyword", "color"],
    entity: [".hljs-title", "color"],
    constant: [".hljs-attr", "color"],
    string: [".hljs-string", "color"],
    variable: [".hljs-built_in", "color"],
    comment: [".hljs-comment", "color"],
    tag: [".hljs-name", "color"],
    heading: [".hljs-section", "color"],
    bullet: [".hljs-bullet", "color"],
    addition: [".hljs-addition", "color"],
    "addition-background": [".hljs-addition", "background-color"],
    deletion: [".hljs-deletion", "color"],
    "deletion-background": [".hljs-deletion", "background-color"],
  } as const;
  for (const [id, file] of [
    ["github-light", "github.css"],
    ["github-dark", "github-dark.css"],
  ] as const) {
    const css = postcss.parse(
      source(`node_modules/highlight.js/styles/${file}`),
    );
    for (const [role, [selector, property]] of Object.entries(selectors)) {
      let actual = "";
      css.walkRules((rule) => {
        if (rule.selectors.includes(selector))
          rule.walkDecls(property, (declaration) => {
            actual = declaration.value;
          });
      });
      assert.equal(
        githubCodePalettes[id][role as keyof typeof selectors],
        actual,
        `${id}: ${role}`,
      );
    }
  }
  const notices = source("THIRD_PARTY_NOTICES.md");
  assert.ok(
    notices.includes(source("node_modules/highlight.js/LICENSE").trim()),
  );
  assert.match(notices, /highlight\.js 11\.11\.2/);
  assert.match(notices, /styles\/github-dark\.css/);
  assert.equal(
    codeColorRoles.length,
    17,
    "15 actual asset roles plus the existing two word-diff alpha roles",
  );
});

async function environment() {
  const { window, document } = parseHTML(
    "<html><head><meta name=theme-color></head><body><main></main></body></html>",
  );
  document.documentElement.dataset.motion = "reduced";
  (document as unknown as { oninput: null }).oninput = null;
  let dark = true;
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return dark;
    },
    addEventListener(_event: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_event: string, listener: () => void) {
      listeners.delete(listener);
    },
  };
  const globals = {
    window,
    document,
    Node: window.Node,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => media,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
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
  return {
    document,
    listeners,
    async render(node: ReactNode) {
      await act(async () => root.render(node));
    },
    async systemTheme(next: boolean) {
      await act(async () => {
        dark = next;
        for (const listener of listeners) listener();
      });
    },
    async click(element: Element) {
      await act(async () =>
        element.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    },
    async input(element: HTMLInputElement, value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(element, value);
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async key(element: Element, key: string) {
      await act(async () => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { key });
        element.dispatchEvent(event);
      });
    },
    async choose(label: string, name: string) {
      await this.click(
        document.querySelector(`button[aria-label="${label}"]`)!,
      );
      const option = Array.from(
        document.querySelectorAll('[role="option"]'),
      ).find((entry) => entry.textContent === name);
      assert.ok(option, name);
      await this.click(option);
    },
    async close() {
      await act(() => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("App-level appearance sets all roles before the next layout observer, follows system mode and clears on account/unmount", async () => {
  const env = await environment();
  const root = env.document.documentElement;
  const seen: { theme?: string; code?: string; keyword: string }[] = [];
  function Appearance({ settings }: { settings?: Settings }) {
    useAppearance(settings);
    useLayoutEffect(() => {
      seen.push({
        theme: root.dataset.theme,
        code: root.dataset.codeTheme,
        keyword: root.style.getPropertyValue("--code-keyword"),
      });
    });
    return createElement(
      "code",
      { className: "hljs" },
      "app content without Settings",
    );
  }
  try {
    root.dataset.theme = "light";
    await env.render(createElement(Appearance));
    assert.equal(
      root.dataset.theme,
      "light",
      "unloaded preferences keep the boot theme",
    );
    assert.equal(root.dataset.codeTheme, undefined);
    await env.render(
      createElement(Appearance, {
        settings: {
          ...defaultSettings,
          theme: "system",
          codeLightTheme: "github-light",
          codeDarkTheme: "github-dark",
        },
      }),
    );
    assert.deepEqual(seen.at(-1), {
      theme: "dark",
      code: "github-dark",
      keyword: "#ff7b72",
    });
    for (const role of Object.keys(githubCodePalettes["github-dark"]))
      assert.equal(
        root.style.getPropertyValue(`--code-${role}`),
        githubCodePalettes["github-dark"][
          role as keyof (typeof githubCodePalettes)["github-dark"]
        ],
      );
    await env.systemTheme(false);
    assert.equal(root.dataset.theme, "light");
    assert.equal(root.dataset.codeTheme, "github-light");
    assert.equal(root.style.getPropertyValue("--code-keyword"), "#d73a49");
    await env.systemTheme(true);
    assert.equal(root.dataset.codeTheme, "github-dark");
    root.style.setProperty("--unrelated-setting", "keep");
    await env.render(
      createElement(Appearance, {
        key: "new-account",
        settings: { ...defaultSettings, theme: "dark" },
      }),
    );
    assert.equal(root.dataset.codeTheme, "claudex-dark");
    assert.ok(
      codeColorRoles.every(
        (role) => !root.style.getPropertyValue(`--code-${role}`),
      ),
    );
    assert.equal(root.style.getPropertyValue("--unrelated-setting"), "keep");
    assert.equal(env.listeners.size, 1);
    await env.render(null);
    assert.equal(root.dataset.codeTheme, undefined);
    assert.equal(env.listeners.size, 0);
    assert.equal(root.style.getPropertyValue("--unrelated-setting"), "keep");
  } finally {
    await env.close();
  }
});

test("actual theme menus stay unchanged on pending/failed saves, apply on success and persist after Settings closes/restarts", async () => {
  const env = await environment();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-r4-settings-theme-ui-"),
  );
  const store = new Store(directory);
  store.settings = { ...store.settings, theme: "dark" };
  let gate = deferred<boolean>();
  const patches: Partial<Settings>[] = [],
    errors: unknown[] = [];
  function Harness({
    open = true,
    restored,
  }: {
    open?: boolean;
    restored?: Settings;
  }) {
    const [settings, setSettings] = useState(restored ?? store.settings);
    useAppearance(settings);
    return open
      ? createElement(CodeThemePickers, {
          settings,
          save: async (patch) => {
            patches.push(patch);
            const accepted = await gate.promise;
            if (accepted) {
              store.settings = { ...store.settings, ...patch };
              store.flush();
              setSettings({ ...store.settings });
            }
            return accepted;
          },
          onError: (error) => errors.push(error),
        })
      : createElement("div", null, "Settings closed; app remains mounted");
  }
  const root = env.document.documentElement;
  const darkButton = () =>
    env.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Dark code theme"]',
    )!;
  try {
    await env.render(createElement(Harness));
    assert.equal(darkButton().disabled, false);
    await env.choose("Dark code theme", "GitHub Dark");
    assert.equal(darkButton().disabled, true);
    assert.match(darkButton().textContent!, /Claudex Dark/);
    assert.equal(root.dataset.codeTheme, "claudex-dark");
    await env.click(darkButton());
    assert.equal(patches.length, 1);
    assert.equal(env.document.querySelector('[role="listbox"]'), null);
    await act(async () => gate.resolve(false));
    assert.equal(darkButton().disabled, false);
    assert.equal(root.style.getPropertyValue("--code-keyword") ?? "", "");
    gate = deferred<boolean>();
    await env.choose("Dark code theme", "GitHub Dark");
    await act(async () => gate.reject(new Error("save failed")));
    assert.equal(errors.length, 1);
    assert.equal(root.dataset.codeTheme, "claudex-dark");
    gate = deferred<boolean>();
    await env.choose("Dark code theme", "GitHub Dark");
    await act(async () => gate.resolve(true));
    assert.equal(root.dataset.codeTheme, "github-dark");
    assert.equal(root.style.getPropertyValue("--code-string"), "#a5d6ff");
    const preview = (mode: string) =>
      env.document.querySelector<HTMLElement>(`.code-theme-preview.${mode}`)!;
    assert.equal(
      preview("dark").style.getPropertyValue("--code-keyword"),
      "#ff7b72",
    );
    assert.equal(
      preview("light").style.getPropertyValue("--code-keyword"),
      "initial",
      "the inactive default preview blocks inherited dark GitHub variables",
    );
    gate = deferred<boolean>();
    await env.choose("Light code theme", "GitHub Light");
    await act(async () => gate.resolve(true));
    assert.equal(
      preview("light").style.getPropertyValue("--code-keyword"),
      "#d73a49",
    );
    assert.equal(
      root.dataset.codeTheme,
      "github-dark",
      "changing the inactive mode does not change the effective theme",
    );
    assert.deepEqual(patches.at(-1), { codeLightTheme: "github-light" });
    await env.render(createElement(Harness, { open: false }));
    assert.equal(env.document.querySelector(".code-themes"), null);
    assert.equal(root.dataset.codeTheme, "github-dark");
    await env.render(null);
    const restarted = new Store(directory);
    await env.render(createElement(Harness, { restored: restarted.settings }));
    assert.equal(root.dataset.codeTheme, "github-dark");
    assert.match(darkButton().textContent!, /GitHub Dark/);
    assert.equal(restarted.settings.codeLightTheme, "github-light");
    assert.equal(restarted.settings.codeDarkTheme, "github-dark");
  } finally {
    gate.resolve(false);
    await env.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("actual highlighted diff tokens have complete selected-role bindings and exact default colour fallbacks", async () => {
  await loadHighlight();
  const html = renderToStaticMarkup(
    createElement(DiffLines, {
      language: "typescript",
      lines: [{ kind: "add", text: 'const answer = "yes";', newNo: 1 }],
    }),
  );
  assert.match(html, /hljs-keyword/);
  assert.match(html, /hljs-string/);
  const gated = new Map<string, Record<string, string>>();
  const prefix = ':root[data-code-theme^="github-"] ';
  postcss
    .parse(source("src/transcript/chat-transcript.css"))
    .walkRules((rule) => {
      for (const raw of rule.selectors) {
        const selector = raw.replace(/\s+/g, " ");
        if (selector.startsWith(prefix)) {
          const declarations: Record<string, string> = {};
          rule.walkDecls((declaration) => {
            declarations[declaration.prop] = declaration.value;
          });
          const target = selector.slice(prefix.length);
          const targets = target.startsWith(":is(")
            ? target
                .slice(4, -1)
                .split(",")
                .map((part) => part.trim())
            : [target];
          for (const target of targets) gated.set(target, declarations);
        }
      }
    });
  let tokenSelectors = 0;
  for (const [id, file] of [
    ["github-light", "github.css"],
    ["github-dark", "github-dark.css"],
  ] as const) {
    const variables = codeThemePreviewVariables(id);
    postcss
      .parse(source(`node_modules/highlight.js/styles/${file}`))
      .walkRules((rule) => {
        if (!rule.selector.startsWith(".hljs")) return;
        const color = rule.nodes.find(
          (node) => node.type === "decl" && node.prop === "color",
        );
        for (const selector of rule.selectors) {
          const actual = gated.get(selector);
          assert.ok(actual, `${id}: selector ${selector} is actually styled`);
          const resolved = actual.color.replace(
            /var\((--code-[\w-]+)\)/,
            (_whole, name) => variables[name],
          );
          assert.equal(
            resolved,
            color && color.type === "decl" ? color.value : "inherit",
            `${id}: ${selector}`,
          );
          if (id === "github-light") tokenSelectors++;
          const background = rule.nodes.find(
            (node) =>
              node.type === "decl" &&
              /^(background|background-color)$/.test(node.prop),
          );
          if (background?.type === "decl") {
            const value = actual[background.prop].replace(
              /var\((--code-[\w-]+)\)/,
              (_whole, name) => variables[name],
            );
            assert.equal(
              value,
              background.value,
              `${id}: ${selector} background`,
            );
          }
        }
      });
  }
  assert.ok(
    tokenSelectors > 40,
    "all upstream token selectors, including intentionally inherited ones",
  );
  const defaults = [
    [
      "src/transcript/chat-transcript.css",
      ".hljs-keyword",
      "color",
      "var(--code-keyword, #c483f4)",
    ],
    [
      "src/transcript/chat-transcript.css",
      ':root[data-theme="light"] .hljs-keyword',
      "color",
      "var(--code-keyword, #7c3bb5)",
    ],
    [
      "src/diff/diff.css",
      ".diff-lines .hljs-keyword",
      "color",
      "var(--code-keyword, #be8ce1)",
    ],
    [
      "src/artifacts/file-viewer.css",
      ':root:not([data-theme="light"]) .file-source[data-language="html"] .hljs-meta',
      "color",
      "var(--code-constant, #7ec4c4)",
    ],
  ];
  for (const [file, selector, property, expected] of defaults) {
    let actual = "";
    postcss.parse(source(file)).walkRules((rule) => {
      if (rule.selectors.some((item) => item.replace(/\s+/g, " ") === selector))
        rule.walkDecls(property, (declaration) => {
          actual = declaration.value;
        });
    });
    assert.equal(actual, expected, `${file}: ${selector}`);
  }
  const { document } = parseHTML("<html><body></body></html>");
  applyCodeTheme(document.documentElement, "github-dark");
  assert.equal(
    document.documentElement.style.getPropertyValue("--code-keyword"),
    "#ff7b72",
  );
  assert.equal(
    document.documentElement.style.getPropertyValue(
      "--code-addition-background",
    ),
    "#033a16",
  );
  clearCodeTheme(document.documentElement);
  assert.equal(document.documentElement.dataset.codeTheme, undefined);
  assert.ok(
    Object.values(codeThemePreviewVariables("claudex-light")).every(
      (value) => value === "initial",
    ),
  );
  assert.ok(
    source("src/artifacts/file-viewer.css").includes(
      ':where(:not([data-code-theme^="github-"]))',
    ),
    "default HTML neutralisation keeps its original specificity",
  );
  assert.doesNotMatch(
    source("src/transcript/chat-transcript.css").slice(
      source("src/transcript/chat-transcript.css").indexOf(
        "/* Supported GitHub asset roles",
      ),
    ),
    /!important/,
  );
});

test("the real code-theme combobox has a searchable dialog and keyboard selection without closing Settings", async () => {
  const env = await environment();
  const { CodeThemeSelect } =
    await import("../../src/settings/CodeThemeSelect");
  const selected: string[] = [];
  try {
    await env.render(
      createElement(CodeThemeSelect, {
        label: "Light code theme",
        value: "claudex-light",
        options: [
          { value: "claudex-light", label: "Claudex Light" },
          { value: "github-light", label: "GitHub Light" },
        ],
        onChange: (value) => selected.push(value),
      }),
    );
    const trigger = env.document.querySelector('button[role="combobox"]')!;
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    await env.click(trigger);
    assert.ok(
      env.document.querySelector(
        '[role="dialog"][aria-label="Light code theme"]',
      ),
    );
    const input = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await env.input(input, "GitHub");
    assert.deepEqual(
      [...env.document.querySelectorAll('[role="option"]')].map(
        (e) => e.textContent,
      ),
      ["GitHub Light"],
    );
    await env.key(input, "Enter");
    assert.deepEqual(selected, ["github-light"]);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    await env.click(trigger);
    await env.key(
      env.document.querySelector('input[role="combobox"]')!,
      "Escape",
    );
    assert.deepEqual(selected, ["github-light"]);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally {
    await env.close();
  }
});
