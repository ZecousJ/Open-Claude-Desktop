import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { act, createElement as h, useEffect, useState } from "react";
import { JSDOM } from "jsdom";
import ts from "typescript";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import { useAppearance } from "../../src/settings/useAppearance";
import { fixtureSettings } from "../../scripts/preview/app-fixture";
import type { Settings } from "../../shared/types";
import { routineDom } from "../support/routine-dom";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const html = read("index.html"),
  web = read("web.html");
const boot = ts.transpileModule(read("src/boot/native-theme.ts"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const critical = /<style id="native-boot-theme">([\s\S]*?)<\/style>/.exec(
  html,
)?.[1];
assert.ok(critical);
const foundationPaths = [
  "00-foundation",
  "90-reference-foundation",
  "93-reference-responsive",
];
const foundation = foundationPaths.map((path) =>
  read(`src/styles/${path}.css`),
);
const sheets = [critical, ...foundation];
function execute(document: Document, dark: boolean) {
  runInNewContext(boot, {
    document,
    matchMedia: () => ({ matches: dark }),
    exports: {},
  });
}
function rank(tokens: Selector[]): number {
  return tokens.reduce((sum, token) => {
    if (token.type === "attribute")
      return sum + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element") return sum + 1;
    if (token.type !== "pseudo" || token.name === "where") return sum;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return sum + Math.max(0, ...token.data.map(rank));
    return sum + 100;
  }, 0);
}
// Actual HTML nodes and real selectors/declarations, including specificity,
// media and the two intermediate reference layers. This does not simulate
// a browser paint clock; root's nativeTheme window supplies that evidence.
function value(
  element: Element,
  property: string,
  dark: boolean,
  sources = sheets,
) {
  let result: { priority: number; value: string } | undefined;
  for (const source of sources)
    postcss.parse(source).walkRules((rule) => {
      for (
        let parent:
          | postcss.AtRule
          | postcss.Rule
          | postcss.Root
          | postcss.Document
          | undefined = rule.parent;
        parent;
        parent = parent.parent
      ) {
        if (parent.type !== "atrule") continue;
        if (parent.name === "container" || /keyframes/.test(parent.name))
          return;
        if (parent.name === "media") {
          const color = /\(prefers-color-scheme:\s*(dark|light)\)/.exec(
            parent.params,
          )?.[1];
          if (!color || (color === "dark") !== dark) return;
        }
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        if (/::/.test(selector)) continue;
        let matches = false;
        try {
          matches = element.matches(selector);
        } catch {}
        if (!matches) continue;
        const priority = Math.max(...selectors(selector).map(rank));
        rule.walkDecls((declaration) => {
          if (declaration.prop !== property) return;
          const score = priority + (declaration.important ? 1000000 : 0);
          if (!result || result.priority <= score)
            result = { priority: score, value: declaration.value };
        });
      }
    });
  return result?.value;
}
function background(
  element: Element,
  dark: boolean,
  sources = sheets,
): string | undefined {
  const raw = value(element, "background", dark, sources);
  if (raw === "inherit" && element.parentElement)
    return background(element.parentElement, dark, sources);
  const variable = /^var\((--[\w-]+)(?:,\s*([^)]*))?\)$/.exec(raw ?? "");
  return variable
    ? (value(element, variable[1]!, dark, sources) ?? variable[2])
    : raw;
}

test("native CSP keeps a self-only boot module before main and leaves the web hint entry untouched", () => {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    const modules = [
      ...document.querySelectorAll('script[type="module"][src]'),
    ].map((entry) => entry.getAttribute("src"));
    assert.deepEqual(modules, ["/src/boot/native-theme.ts", "/src/main.tsx"]);
    const csp = document.querySelector(
      'meta[http-equiv="Content-Security-Policy"]',
    )!;
    const policy = csp.getAttribute("content")!;
    assert.match(policy, /(?:^|;)\s*script-src 'self';/);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
    for (const resource of document.querySelectorAll("script, style, link"))
      assert.ok(
        csp.compareDocumentPosition(resource) &
          dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
        "CSP is established before each active resource and inline stylesheet",
      );
    assert.doesNotMatch(read("src/boot/native-theme.ts"), /^import\s/m);
    assert.doesNotMatch(web, /native-boot-theme|native-theme\.ts/);
    assert.match(web, /localStorage\.getItem\("claudex\.boot"\)/);
    const order = read("src/styles.css");
    assert.ok(
      order.indexOf("00-foundation.css") <
        order.indexOf("90-reference-foundation.css"),
    );
    assert.ok(
      order.indexOf("90-reference-foundation.css") <
        order.indexOf("93-reference-responsive.css"),
    );
  } finally {
    dom.window.close();
  }
});

test("the real media canvas survives foundation arriving before the native module, then the module preserves theme through later layers", () => {
  for (const dark of [false, true]) {
    const dom = new JSDOM(html),
      root = dom.window.document.documentElement;
    try {
      const expected = dark ? "#151515" : "#fcfcfb";
      assert.equal(
        background(root, dark, [critical]),
        expected,
        "synchronous pre-module canvas follows nativeTheme media",
      );
      for (let count = 1; count <= sheets.length; count++) {
        const current = sheets.slice(0, count);
        assert.equal(root.hasAttribute("data-theme"), false);
        assert.equal(
          background(root, dark, current),
          expected,
          "late module download cannot expose the foundation's unselected dark default",
        );
        assert.equal(
          background(dom.window.document.body, dark, current),
          expected,
          "the unstamped body follows the same real native canvas",
        );
        assert.equal(
          value(root, "color-scheme", dark, current),
          dark ? "dark" : "light",
        );
      }
      execute(dom.window.document, dark);
      assert.equal(root.dataset.theme, dark ? "dark" : "light");
      for (let count = 1; count <= sheets.length; count++) {
        const current = sheets.slice(0, count);
        // Native light must never show the dark default.
        if (!dark) assert.equal(background(root, dark, current), expected);
        assert.equal(
          value(root, "color-scheme", dark, current),
          dark ? "dark" : "light",
        );
      }
      assert.equal(background(root, dark), expected);
    } finally {
      dom.window.close();
    }
  }
  const negative = new JSDOM(html);
  try {
    const missingGuard = postcss.parse(critical);
    missingGuard.walkRules((rule) => {
      if (rule.selector.includes("html:not([data-theme])")) rule.remove();
    });
    assert.equal(
      background(negative.window.document.documentElement, false, [
        missingGuard.toString(),
        ...foundation.slice(0, 2),
      ]),
      "#151515",
      "reading unselected --bg instead of the synchronous media canvas shows the dark default on a light window",
    );
  } finally {
    negative.window.close();
  }
});

test("native bootstrap preserves an already selected theme instead of replacing it with the media default", () => {
  for (const theme of ["light", "dark"]) {
    const dom = new JSDOM(html),
      root = dom.window.document.documentElement;
    try {
      root.dataset.theme = theme;
      execute(dom.window.document, theme !== "dark");
      assert.equal(root.dataset.theme, theme);
      assert.equal(
        background(root, theme !== "dark"),
        theme === "dark" ? "#151515" : "#fcfcfb",
      );
    } finally {
      dom.window.close();
    }
  }
});

test("the real appearance hook retains the native stamp while settings await and then applies the loaded preference normally", async () => {
  for (const dark of [false, true]) {
    const env = await routineDom({}, { jsdom: true });
    const old = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    const media = {
      matches: dark,
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => media,
    });
    let resolve!: (settings: Settings) => void;
    const pending = new Promise<Settings>((done) => {
      resolve = done;
    });
    function Probe() {
      const [settings, setSettings] = useState<Settings>();
      useAppearance(settings);
      useEffect(() => {
        let live = true;
        void pending.then((value) => {
          if (live) setSettings(value);
        });
        return () => {
          live = false;
        };
      }, []);
      return null;
    }
    try {
      execute(env.document, dark);
      await env.render(h(Probe));
      const root = env.document.documentElement;
      assert.equal(root.dataset.theme, dark ? "dark" : "light");
      assert.equal(background(root, dark), dark ? "#151515" : "#fcfcfb");
      const final = dark ? "light" : "dark";
      await act(async () => resolve({ ...fixtureSettings(), theme: final }));
      assert.equal(
        root.dataset.theme,
        final,
        "loaded preferences remain the real owner",
      );
      assert.equal(
        background(root, dark),
        final === "light" ? "#fcfcfb" : "#151515",
      );
    } finally {
      await env.clean();
      if (old) Object.defineProperty(globalThis, "matchMedia", old);
      else Reflect.deleteProperty(globalThis, "matchMedia");
    }
  }
});
