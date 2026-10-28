import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { NoSkillsMatch } from "../../src/collections/customize/CustomizeDirectory";
import { SearchSortButton } from "../../src/collections/history/HistoryControls";
import { historyLabels } from "../../src/sidebar/recents-labels";
import { ImportTab } from "../../src/settings/tabs/Import";
import { HostContext } from "../../src/host/HostContext";
import { hostFor } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import { Menu } from "../../src/ui/Menu";

test("Discover empty states distinguish skills and plugins with the same retry hint", () => {
  for (const noun of ["skills", "plugins"] as const) {
    const html = renderToStaticMarkup(createElement(NoSkillsMatch, { noun }));
    assert.match(html, /role="status"/);
    assert.ok(
      html.includes(
        `No ${noun} match your search<span>Try a different term.</span>`,
      ),
    );
    assert.doesNotMatch(html, /match your search\./);
  }
});

test("history search follows the available kinds without ICU select syntax", () => {
  assert.equal(
    historyLabels("chat", false, "chats").searchPlaceholder,
    "Search recents...",
  );
  assert.equal(
    historyLabels("cowork", false, "tasks").searchPlaceholder,
    "Search recents...",
  );
  assert.equal(
    historyLabels("chat", false, "both").searchPlaceholder,
    "Search recents...",
  );
  assert.equal(
    historyLabels("chat", true, "chats").searchPlaceholder,
    "Search recents...",
  );
  for (const kind of ["both", "chats", "tasks"] as const) {
    assert.equal(
      historyLabels("chat", false, kind).searchLabel,
      "Search your activity",
    );
    assert.equal(
      historyLabels("code", true, kind).searchLabel,
      "Search sessions",
    );
  }
});

test("history search sort stays visible while disabled and Date is pressed", () => {
  const render = (value: "type" | "date", disabled = false) =>
    renderToStaticMarkup(
      createElement(SearchSortButton, { value, disabled, onChange() {} }),
    );
  assert.match(render("type", true), /aria-label="Sort by"/);
  assert.match(render("type", true), /aria-disabled="true"/);
  assert.match(render("type"), /aria-pressed="false"/);
  assert.match(render("date"), /aria-pressed="true"/);
});

test("sort choices use radio semantics without changing toggle menus", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    innerHeight: 800,
    innerWidth: 1200,
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
    await act(() =>
      root.render(
        createElement(Menu, {
          label: "Sort by",
          position: { left: 0, top: 0 },
          width: 200,
          autoFocus: false,
          entries: [
            { label: "Type", checked: true, checkedRole: "radio" },
            { label: "Date", checked: false, checkedRole: "radio" },
            { label: "Toggle", checked: true },
          ],
          onClose() {},
        }),
      ),
    );
    assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 2);
    assert.equal(
      document.querySelectorAll('[role="menuitemcheckbox"]').length,
      1,
    );
    assert.equal(
      document.querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?.textContent,
      "Type",
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("desktop Import exposes the local ZIP export with platform-specific copy", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const html = renderToStaticMarkup(
      createElement(HostContext.Provider, {
        value: hostFor("desktop"),
        children: createElement(ImportTab, {
          settings: defaultSettings,
          platform,
          engine: { state: "ready" },
          save() {},
          onError() {},
          goTo() {},
        }),
      }),
    );
    assert.ok(
      html.includes(
        `Save this ${platform === "darwin" ? "Mac" : "PC"}’s chats, Cowork tasks, and Code sessions as a zip file.`,
      ),
    );
    assert.match(html, /Export…/);
    assert.doesNotMatch(html, /emailed|email/);
  }
});
