import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { TextField, TextArea } from "../../src/settings/controls";
import { Dropdown } from "../../src/settings/Dropdown";
import { routineDom } from "../support/routine-dom";

async function environment(theme: "dark" | "light", surface: "web" | "native") {
  const e = await routineDom({}, { jsdom: true });
  const root = e.document.documentElement;
  root.dataset.theme = theme;
  root.dataset.surface = surface;
  const style = e.document.createElement("style");
  style.textContent = [
    "src/styles/00-foundation.css",
    "src/settings/settings.css",
    ...(surface === "web" ? ["src/web/web-shell.css"] : []),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  e.document.head.append(style);
  return e;
}

for (const theme of ["dark", "light"] as const)
  for (const surface of ["web", "native"] as const)
    test(`settings5 actual ${surface}/${theme} text fields retain source fill, inset and focus states`, async () => {
      const e = await environment(theme, surface);
      try {
        const commits: string[] = [];
        await e.render(
          h(
            "div",
            { className: "settings-dialog" },
            h(TextField, {
              label: "Display name",
              value: "Reader",
              onCommit: (value) => commits.push(value),
            }),
            h(TextArea, { label: "Instructions", value: "", onCommit() {} }),
          ),
        );
        const field = e.document.querySelector<HTMLInputElement>("input")!;
        const area = e.document.querySelector<HTMLTextAreaElement>("textarea")!;
        // jsdom does not resolve var() colours; root compares their actual
        // resolved paints in the IAB. These assertions cover rendered controls,
        // inherited tokens, insets, focus and real commit behaviour.
        assert.equal(
          getComputedStyle(e.document.documentElement)
            .getPropertyValue("--settings-field-fill")
            .trim(),
          theme === "light"
            ? "rgb(255 255 255/50%)"
            : "var(--settings-alpha-1)",
        );
        assert.equal(getComputedStyle(field).borderTopWidth, "0px");
        assert.equal(getComputedStyle(field).paddingLeft, "12px");
        assert.equal(getComputedStyle(field).width, "224px");
        assert.equal(getComputedStyle(field).height, "32px");
        assert.equal(
          getComputedStyle(field).boxShadow,
          "inset 0 0 0 1px var(--settings-alpha-2)",
        );
        assert.equal(getComputedStyle(area).padding, "8px 12px");
        await act(async () => field.focus());
        assert.equal(e.document.activeElement, field);
        assert.equal(
          getComputedStyle(field).boxShadow,
          "var(--settings-field-focus)",
        );
        await e.change('input[aria-label="Display name"]', "New reader");
        await act(async () => field.blur());
        assert.deepEqual(commits, ["New reader"]);
        field.setAttribute("aria-invalid", "true");
        assert.equal(
          getComputedStyle(field).boxShadow,
          "inset 0 0 0 1px var(--focus-danger)",
        );
        await act(async () => field.focus());
        assert.ok(
          getComputedStyle(field).boxShadow.includes(
            "var(--focus-danger-glow)",
          ),
        );
        assert.ok(
          getComputedStyle(field).boxShadow.includes(
            "0 0 0 1px var(--focus-danger)",
          ),
        );
        await act(async () => field.blur());
        field.removeAttribute("aria-invalid");
        field.disabled = true;
        assert.equal(
          getComputedStyle(field).opacity,
          "var(--opacity-disabled)",
        );
      } finally {
        await e.clean();
      }
    });

test("settings5 current font popup uses the real selected row for pointer and keyboard acceptance", async () => {
  const e = await environment("dark", "web");
  const globals = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: e.window.addEventListener.bind(e.window),
    removeEventListener: e.window.removeEventListener.bind(e.window),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    const selected: string[] = [];
    await e.render(
      h(Dropdown, {
        label: "Chat font",
        value: "serif",
        menuWidth: 224,
        highlightSelectedOnOpen: true,
        options: [
          { value: "serif", label: "Claudex Serif" },
          { value: "sans", label: "Claudex Sans" },
        ],
        onChange: (value: string) => selected.push(value),
      }),
    );
    await e.event(e.document.querySelector("button")!, "click", { detail: 1 });
    const menu = e.document.querySelector<HTMLElement>('[role="listbox"]')!;
    const first = menu.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(menu.getAttribute("aria-activedescendant"), first.id);
    assert.equal(first.getAttribute("aria-selected"), "true");
    assert.equal(getComputedStyle(menu).width, "224px");
    assert.equal(getComputedStyle(menu).padding, "4px");
    assert.equal(getComputedStyle(menu).borderTopWidth, "0px");
    assert.equal(getComputedStyle(menu).borderRadius, "12px");
    assert.equal(
      getComputedStyle(e.document.documentElement)
        .getPropertyValue("--settings-popup")
        .trim(),
      "#20201f",
    );
    assert.equal(
      getComputedStyle(menu).boxShadow,
      "var(--settings-popup-shadow)",
    );
    assert.ok(first.classList.contains("active"));
    await e.event(menu, "keydown", { key: "ArrowDown" });
    const second = menu.querySelectorAll('[role="option"]')[1];
    assert.equal(menu.getAttribute("aria-activedescendant"), second.id);
    await e.event(menu, "keydown", { key: "Enter" });
    assert.deepEqual(selected, ["sans"]);
    assert.equal(e.document.querySelector('[role="listbox"]'), null);
  } finally {
    await e.clean();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
