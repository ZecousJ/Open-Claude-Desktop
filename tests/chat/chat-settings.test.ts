import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { defaultSettings } from "../../electron/store/store";
import type { Settings } from "../../shared/types";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { GeneralTab } from "../../src/settings/tabs/General";
import { TranscriptAppearance } from "../../src/settings/tabs/TranscriptAppearance";
import {
  Row,
  Section,
  SelectField,
  TextField,
  Toggle,
} from "../../src/settings/controls";
import { routineDom } from "../support/routine-dom";

// These assertions run the real components and stylesheets. JSDOM does not
// lay out wrapped text; the browser acceptance owns measured row heights.
async function settingsDom() {
  const env = await routineDom(
    { trustedCoworkFolders: async () => [] },
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  for (const file of [
    "styles/00-foundation.css",
    "ui/segmented-control.css",
    "settings/settings.css",
  ]) {
    const style = env.document.createElement("style");
    style.textContent = readFileSync(
      new URL(`../../src/${file}`, import.meta.url),
      "utf8",
    );
    env.document.head.append(style);
  }
  env.document.documentElement.dataset.theme = "dark";
  const render = (child: ReturnType<typeof h>) =>
    env.render(h("div", { className: "settings-dialog" }, child));
  return {
    ...env,
    render,
    style(selector: string) {
      const element = env.document.querySelector(selector);
      assert.ok(element, selector);
      return env.window.getComputedStyle(element);
    },
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("shared Settings renders the live typography and control dimensions without a fixed row height", async () => {
  const env = await settingsDom();
  try {
    await env.render(
      h(
        Section,
        { title: "Profile" },
        h(
          Row,
          { label: "Full name" },
          h(TextField, { label: "Full name", value: "Ada", onCommit() {} }),
        ),
        h(
          Row,
          {
            label: "Notifications",
            description: "Notify when a response is ready.",
          },
          h(Toggle, { label: "Notifications", checked: true }),
        ),
        h(
          Row,
          { label: "Shortcut" },
          h(SelectField, {
            label: "Shortcut",
            value: "none",
            options: [{ value: "none", label: "None" }],
            onChange() {},
          }),
        ),
      ),
    );
    const heading = env.style("h3");
    assert.equal(heading.fontSize, "15px");
    assert.equal(heading.lineHeight, "20px");
    assert.equal(heading.fontWeight, "580");
    for (const selector of [".settings-row-label", ".settings-row-text > p"]) {
      assert.equal(env.style(selector).fontSize, "14px");
      assert.equal(env.style(selector).lineHeight, "20px");
    }
    const row = env.style(".settings-row");
    assert.equal(row.paddingTop, "12px");
    assert.equal(row.paddingBottom, "12px");
    assert.equal(row.gap, "28px");
    assert.ok(
      ["", "auto"].includes(row.height),
      "content and wrapping determine height",
    );
    assert.equal(
      env
        .style("html")
        .getPropertyValue("--settings-alpha-1")
        .replaceAll(" ", ""),
      "rgb(255255255/5%)",
    );
    assert.equal(env.style(".settings-row-text").flex, "1 1 0%");
    assert.equal(env.style(".settings-row-control").flex, "0 0 auto");
    assert.equal(env.style(".settings-input").width, "224px");
    assert.equal(env.style(".settings-input").height, "32px");
    assert.equal(env.style(".settings-select").height, "32px");
    assert.equal(env.style(".settings-toggle").width, "36px");
    assert.equal(env.style(".settings-toggle").height, "20px");
  } finally {
    await env.clean();
  }
});

test("both transcript segments retain their stored selection and save independent size and width choices", async () => {
  const env = await settingsDom();
  try {
    let settings: Settings = {
      ...defaultSettings,
      transcriptTextSize: "l",
      transcriptWidth: "s",
    };
    const patches: Partial<Settings>[] = [];
    const render = () =>
      env.render(
        h(TranscriptAppearance, {
          settings,
          save(patch) {
            patches.push(patch);
            settings = { ...settings, ...patch };
          },
        }),
      );
    await render();
    const group = (name: string) =>
      env.document.querySelector(`[role="radiogroup"][aria-label="${name}"]`)!;
    assert.equal(
      group("Transcript text size").querySelector('[aria-checked="true"]')
        ?.textContent,
      "Large",
    );
    assert.equal(
      group("Transcript width").querySelector('[aria-checked="true"]')
        ?.textContent,
      "Narrow",
    );
    for (const button of env.document.querySelectorAll(
      ".settings-segmented > button",
    ))
      assert.equal(env.window.getComputedStyle(button).height, "30px");
    await env.event(group("Transcript text size"), "keydown", { key: "Home" });
    await render();
    await env.event(group("Transcript width"), "keydown", { key: "End" });
    await render();
    assert.deepEqual(patches, [
      { transcriptTextSize: "s" },
      { transcriptWidth: "l" },
    ]);
    assert.equal(
      group("Transcript text size").querySelector('[aria-checked="true"]')
        ?.textContent,
      "Small",
    );
    assert.equal(
      group("Transcript width").querySelector('[aria-checked="true"]')
        ?.textContent,
      "Wide",
    );
    assert.equal(
      group("Transcript width")
        .querySelector('[aria-checked="true"]')
        ?.getAttribute("tabindex"),
      "0",
    );
    assert.equal(env.document.activeElement?.textContent, "Wide");
  } finally {
    await env.clean();
  }
});

async function generalDom(referenceFonts: boolean) {
  const env = await settingsDom();
  env.document.documentElement.dataset.referenceFonts = String(referenceFonts);
  let settings = {
    ...defaultSettings,
    theme: "system",
    chatFont: "serif",
  } as Settings;
  const patches: Partial<Settings>[] = [];
  const render = () =>
    env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(GeneralTab, {
          settings,
          save(patch) {
            patches.push(patch);
            settings = { ...settings, ...patch };
          },
          platform: "darwin",
          engine: { state: "ready" },
          onError(error) {
            throw error;
          },
          goTo() {},
        }),
      ),
    );
  await render();
  return { ...env, refresh: render, patches };
}

test("General font picker retains the four official choices, previews each face and saves the selected value", async () => {
  const env = await generalDom(true);
  try {
    await env.click('[aria-label="Chat font"]');
    const options = [
      ...env.document.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    assert.deepEqual(
      options.map((option) => option.querySelector("span")?.textContent),
      ["Serif", "Sans", "System", "OpenDyslexic"],
    );
    assert.equal(options[0].getAttribute("aria-selected"), "true");
    assert.ok(options.every((option) => !option.hasAttribute("aria-disabled")));
    assert.ok(
      options.every((option) =>
        Boolean(option.querySelector<HTMLElement>("span")?.style.fontFamily),
      ),
    );
    await env.event(options[1], "click");
    await env.refresh();
    assert.deepEqual(env.patches, [{ chatFont: "sans" }]);
    assert.equal(env.document.querySelector('[role="listbox"]'), null);
    assert.equal(
      env.document.querySelector('[aria-label="Chat font"]')?.textContent,
      "Sans",
    );
    assert.equal(env.style('[aria-label="Chat font"]').height, "32px");
    assert.equal(
      env.document.activeElement?.getAttribute("aria-label"),
      "Chat font",
    );
  } finally {
    await env.clean();
  }
});

test("General uses fallback face labels without reference fonts and keeps Theme and Motion independently selectable", async () => {
  const env = await generalDom(false);
  try {
    assert.equal(
      env.document.querySelector('[aria-label="Chat font"]')?.textContent,
      "Serif",
    );
    await env.click('[role="radio"][aria-label="Dark"]');
    await env.refresh();
    const motion = env.document.querySelector(
      '[role="radiogroup"][aria-label="Motion"]',
    )!;
    await env.event(motion, "keydown", { key: "End" });
    await env.refresh();
    assert.deepEqual(env.patches, [{ theme: "dark" }, { motion: "reduced" }]);
    assert.equal(
      env.document
        .querySelector('[role="radio"][aria-label="Dark"]')
        ?.getAttribute("aria-checked"),
      "true",
    );
    assert.equal(
      motion.querySelector('[aria-checked="true"]')?.textContent,
      "Reduced",
    );
    for (const button of motion.querySelectorAll("button"))
      assert.equal(env.window.getComputedStyle(button).height, "30px");
  } finally {
    await env.clean();
  }
});

test("shared switch and text field respond to interaction while keeping the current draft until commit", async () => {
  const env = await settingsDom();
  try {
    let checked = false;
    let name = "Ada";
    const commits: string[] = [];
    const render = () =>
      env.render(
        h(
          Section,
          { title: "Profile" },
          h(
            Row,
            { label: "Full name" },
            h(TextField, {
              label: "Full name",
              value: name,
              onCommit(value) {
                name = value;
                commits.push(value);
              },
            }),
          ),
          h(
            Row,
            { label: "Notifications" },
            h(Toggle, {
              label: "Notifications",
              checked,
              onChange(value) {
                checked = value;
              },
            }),
          ),
        ),
      );
    await render();
    await env.click('[role="switch"]');
    await render();
    assert.equal(
      env.document
        .querySelector('[role="switch"]')
        ?.getAttribute("aria-checked"),
      "true",
    );
    const input = env.document.querySelector<HTMLInputElement>("input")!;
    await act(async () => input.focus());
    await env.change("input", "Grace");
    assert.deepEqual(commits, []);
    assert.equal(input.value, "Grace");
    await env.event(input, "keydown", { key: "Enter" });
    await render();
    assert.deepEqual(commits, ["Grace"]);
    assert.equal(input.value, "Grace");
  } finally {
    await env.clean();
  }
});
