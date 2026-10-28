import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import { TaskPermissionPicker } from "../../src/composer/TaskPermissionPicker";
import { CoworkOptions } from "../../src/composer/CoworkOptions";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { routineDom } from "../support/routine-dom";
import { parseHTML } from "linkedom";
import "../../src/composer/TaskPermissionMenu";
import { readSource } from "../support/read-source";

// Evaluate actual selectors against rendered controls in eager/lazy order.
// This is a DOM/cascade contract, not browser paint or touch-device evidence.
const sheets = [
  "styles/20-workspace.css",
  "styles/91-reference-workspace.css",
  "styles/93-reference-responsive.css",
  "home/chat-home.css",
  "transcript/transcript-text-size.css",
  "composer/cowork-options.css",
  "sidebar/sidebar.css",
  "web/web-shell.css",
  "styles/95-web.css",
  "styles/chat-phone-parity.css",
  "composer/atomic-chat-input.css",
  "live-web/composer.css",
].map((file) =>
  postcss.parse(
    readSource(new URL(`../../src/${file}`, import.meta.url), "utf8"),
  ),
);
function rank(tokens: Selector[]): number {
  return tokens.reduce((sum, token) => {
    if (token.type === "attribute")
      return sum + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element") return sum + 1;
    if (token.type !== "pseudo" || token.name === "where") return sum;
    return (
      sum +
      (["is", "not", "has"].includes(token.name) && Array.isArray(token.data)
        ? Math.max(0, ...token.data.map(rank))
        : 100)
    );
  }, 0);
}
function mediaMatches(query: string, width: number, coarse: boolean) {
  return postcss.list.comma(query).some((part) => {
    for (const match of part.matchAll(
      /\((min|max)-(width|height):\s*([\d.]+)px\)/g,
    )) {
      const dimension = match[2] === "width" ? width : 844;
      if (match[1] === "min" ? dimension < +match[3] : dimension > +match[3])
        return false;
    }
    return !(
      (part.includes("pointer: coarse") || part.includes("hover: none")) &&
      !coarse
    );
  });
}
function style(element: Element, width = 390, coarse = false) {
  const result = new Map<string, { priority: number; value: string }>();
  for (const root of sheets)
    root.walkRules((rule) => {
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
        if (parent.name === "container" || parent.name.includes("keyframes"))
          return;
        if (
          parent.name === "media" &&
          !mediaMatches(parent.params, width, coarse)
        )
          return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        if (selector.includes("::")) continue;
        let matches = false;
        try {
          matches = element.matches(selector);
        } catch {}
        if (!matches) continue;
        const priority = Math.max(...selectors(selector).map(rank));
        rule.walkDecls((decl) => {
          const weight = priority + (decl.important ? 1000000 : 0);
          if ((result.get(decl.prop)?.priority ?? -1) <= weight)
            result.set(decl.prop, { priority: weight, value: decl.value });
        });
      }
    });
  return Object.fromEntries(
    [...result].map(([key, entry]) => [key, entry.value]),
  );
}
const noop = () => {};
async function renderedControls() {
  const env = await routineDom({}, { jsdom: true });
  await env.render(
    h(
      HostContext.Provider,
      { value: webHost },
      h(
        "div",
        { className: "app web mode-chat" },
        h(
          "main",
          { className: "chat-main empty-chat" },
          h(
            "div",
            { className: "chat-home" },
            h("h1", null, "Evening thoughts"),
            h(
              "div",
              {
                className: "composer-wrap chat-composer",
                "data-presentation": "chat",
              },
              h(
                "div",
                { className: "composer" },
                h("div", { className: "composer-input-row" }, h("textarea")),
              ),
              h(
                "div",
                { className: "composer-chin", "data-place": "home" },
                h(
                  "div",
                  { className: "composer-chin-leading" },
                  h(CoworkOptions, {
                    variant: "chat",
                    platform: "darwin",
                    projects: [],
                    setCwd: noop,
                    onProject: noop,
                    onCreateProject: noop,
                    pickFolder: async () => {},
                  }),
                ),
                h(
                  "div",
                  { className: "composer-chin-trailing" },
                  h(
                    "button",
                    { className: "model-effort-pill model-button" },
                    "Opus 5.5 High",
                  ),
                  h(TaskPermissionPicker, {
                    settings: { taskPermission: "auto" },
                    onChange: noop,
                    presentation: "web-chat",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return env;
}

test("390px home keeps one chin with the official fine/coarse pointer distinction", async () => {
  const env = await renderedControls();
  try {
    for (const coarse of [false, true]) {
      const find = (selector: string) =>
        style(env.document.querySelector(selector)!, 390, coarse);
      for (const selector of [
        ".cowork-options > button",
        ".model-effort-pill",
        ".task-permission-trigger",
      ]) {
        assert.equal(find(selector).height, coarse ? "32px" : "24px");
        assert.equal(
          find(selector)["margin-block"],
          coarse ? "-4px" : undefined,
        );
      }
      // Intrinsic text widths remain font-driven: official fine-pointer
      // Project=71.773px and Opus 5.5 High=104px, not fixed 80/112px.
      assert.equal(find(".cowork-options > button").width, undefined);
      assert.equal(find(".model-effort-pill").width, undefined);
      assert.equal(
        find(".task-permission-trigger").width,
        coarse ? "32px" : "24px",
      );
      assert.equal(
        find(".cowork-options > button")["padding-inline"],
        coarse ? "12px" : "8px",
      );
      assert.equal(
        find(".model-effort-pill")["padding-inline"],
        coarse ? "12px" : undefined,
      );
      assert.equal(find(".cowork-options > button").gap, "4px");
      assert.equal(
        find('.cowork-options > button > [data-icon="CaretDown"]')[
          "margin-inline-end"
        ],
        "-4px",
      );
      assert.equal(find(".composer-chin-trailing")["margin-right"], "10px");
      assert.equal(find(".composer-chin-trailing")["flex-basis"], "auto");
      assert.equal(find(".composer-chin-trailing")["flex-wrap"], "nowrap");
      assert.equal(find(".task-permission-label").display, "none");
      assert.equal(
        find(".task-permission-mobile-icon").display,
        "inline-block",
      );
      assert.equal(
        env.document
          .querySelector(".task-permission-trigger")!
          .getAttribute("aria-label"),
        "Auto",
      );
    }
  } finally {
    await env.clean();
  }
});

test("phone home type and bottom seat use a growing column with no absolute greeting", async () => {
  const env = await renderedControls();
  try {
    const find = (selector: string) =>
      style(env.document.querySelector(selector)!);
    assert.equal(find("h1")["font-size"], "24px");
    assert.equal(find("h1").top, undefined);
    assert.equal(find(".chat-home")["min-height"], "100dvh");
    assert.equal(find(".chat-home").height, undefined);
    assert.equal(find(".composer-wrap").position, "sticky");
    assert.equal(find(".composer-wrap")["margin-top"], "auto");
    assert.equal(
      find(".composer-wrap").bottom,
      "env(safe-area-inset-bottom, 0px)",
    );
    assert.equal(find(".composer-wrap")["--composer-text"], "15px");
    assert.equal(find("textarea")["font-size"], "15px");
    assert.equal(find("textarea")["line-height"], "21px");
    const coarse = style(env.document.querySelector("textarea")!, 390, true);
    assert.equal(coarse["font-size"], "max(16px, var(--composer-text, 15px))");
    assert.equal(
      coarse["line-height"],
      "max(22px, var(--composer-line, 21px))",
    );
    assert.equal(find(".composer-input-row").padding, "5.5px 0 5.5px 8px");
  } finally {
    await env.clean();
  }
});

test("desktop chips and Code keep their prior dimensions", async () => {
  const env = await renderedControls();
  try {
    for (const selector of [
      ".cowork-options > button",
      ".model-effort-pill",
      ".task-permission-trigger",
    ])
      assert.equal(
        style(env.document.querySelector(selector)!, 1440).height,
        "24px",
      );
    const app = env.document.querySelector(".app")!;
    app.classList.remove("web");
    assert.equal(
      style(env.document.querySelector(".composer-wrap")!)["--composer-text"],
      "15px",
    );
    app.classList.add("web");
    const composer = env.document.querySelector(".composer-wrap")!;
    composer.classList.add("code-composer");
    composer.removeAttribute("data-presentation");
    assert.equal(style(composer)["--composer-text"], undefined);
  } finally {
    await env.clean();
  }
});

test("phone shell keeps the existing 32px sidebar and incognito controls", () => {
  const document = parseHTML(
    '<div class="app web"><div class="collapsed-chrome"><button class="icon-button"></button></div><div class="web-home-corner"><button class="incognito-button"></button></div></div>',
  ).document;
  const toggle = style(document.querySelector(".collapsed-chrome > button")!);
  assert.equal(toggle.width, "32px");
  assert.equal(toggle.height, "32px");
  assert.equal(style(document.querySelector(".collapsed-chrome")!).left, "8px");
  assert.equal(
    style(document.querySelector(".web-home-corner")!).height,
    "32px",
  );
});

test("permission mode keeps its accessible name and real change callback in icon presentation", async () => {
  const env = await routineDom({}, { jsdom: true });
  let selected = "";
  const saved = ["innerWidth", "innerHeight"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  try {
    await env.render(
      h(TaskPermissionPicker, {
        settings: { taskPermission: "auto" },
        presentation: "web-chat",
        iconOnly: true,
        onChange: (value) => {
          selected = value;
        },
      }),
    );
    const trigger = env.document.querySelector(".task-permission-trigger")!;
    assert.equal(trigger.getAttribute("aria-label"), "Automatically approve");
    assert.equal(trigger.querySelector(".task-permission-label"), null);
    Object.defineProperties(globalThis, {
      innerWidth: { configurable: true, value: 390 },
      innerHeight: { configurable: true, value: 844 },
    });
    await env.click(".task-permission-trigger");
    const rows = [...env.document.querySelectorAll('[role="menuitemradio"]')];
    assert.equal(rows.length, 2);
    assert.equal(rows[1].getAttribute("aria-checked"), "true");
    await env.event(rows[0], "click");
    assert.equal(selected, "default");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await env.clean();
  }
});
