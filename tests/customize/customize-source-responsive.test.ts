import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { visibleSkills } from "../../src/collections/customize/customize-list";
import { defaultSettings } from "../../electron/store/store";
import type { CustomizeSkill } from "../../shared/collections-api";
const skill = (
  name: string,
  scope: CustomizeSkill["scope"],
  provenance?: CustomizeSkill["provenance"],
): CustomizeSkill => ({
  name,
  scope,
  path: `/fixture/${name}/SKILL.md`,
  description: "Synthetic fixture skill",
  enabled: true,
  own: scope === "user",
  ...(provenance ? { provenance } : {}),
});
const skills = [
  skill("Local author", "user"),
  skill("Declared author", "system", { source: "you" }),
  skill("Organization", "user", { source: "organization" }),
  skill("Project", "repo", { source: "project" }),
  skill("Shared", "user", { source: "shared" }),
  skill("Publisher", "user", {
    source: "publisher",
    publisher: "Fixture publisher",
  }),
  skill("Marketplace", "user", {
    source: "marketplace",
    marketplace: "Fixture marketplace",
  }),
  skill("Unattributed runtime", "system"),
];
const props = {
  settings: defaultSettings,
  route: { section: "skills", view: "yours" } as const,
  onUseSkill() {},
  onOpenSettings() {},
  onConfirmRemove() {},
  onError() {},
};
async function environment(api: object = {}) {
  const dom = await routineDom(
    {
      customizeSkills: async () => skills,
      mcpServers: async () => ({ servers: [] }),
      listPlugins: async () => ({
        plugins: [],
        marketplaces: [],
        loadErrors: [],
      }),
      listApprovedDirectory: async () => [],
      linearStatus: async () => ({ connected: false }),
      ...api,
    } as never,
    { jsdom: true },
  );
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };
  install("innerWidth", 1440);
  install("innerHeight", 900);
  let observer: ResizeObserverCallback | undefined;
  let observed: Element | undefined;
  install(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observer = callback;
      }
      observe(element: Element) {
        observed = element;
      }
      disconnect() {}
    },
  );
  const resize = async (width: number) =>
    act(async () => {
      observer?.(
        [{ target: observed!, contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
  return {
    ...dom,
    resize,
    async clean() {
      await dom.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const headings = (document: Document) =>
  [...document.querySelectorAll(".customize-section > h3")].map(
    (node) => node.firstChild?.textContent,
  );
const rows = (document: Document) =>
  [...document.querySelectorAll(".customize-rows strong")].map(
    (node) => node.textContent,
  );
async function filter(
  env: Awaited<ReturnType<typeof environment>>,
  text: string,
) {
  await env.click('button[aria-label="Filter"]');
  const item = [...env.document.querySelectorAll('[role^="menuitem"]')].find(
    (element) => element.textContent?.trim() === text,
  );
  assert.ok(item, `Missing real filter menu item: ${text}`);
  await env.event(item, "click");
}
test("source sections follow the live order, each with its count", async () => {
  const env = await environment();
  try {
    await env.render(h(CustomizePage, props));
    assert.deepEqual(headings(env.document), [
      "In this project",
      "Created by you",
      "From your organization",
      "Shared with you",
      "From Claudex & Partners",
      "From marketplaces you added",
    ]);
    assert.equal(rows(env.document).length, skills.length);
    for (const entry of skills)
      assert.equal(
        rows(env.document).filter((name) => name === entry.name).length,
        1,
      );
    const unknown = [
      ...env.document.querySelectorAll(".customize-section"),
    ].find((section) => section.textContent?.includes("Unattributed runtime"))!;
    assert.equal(
      unknown.querySelector("h3")?.firstChild?.textContent,
      "From Claudex & Partners",
    );
    assert.equal(
      unknown.querySelector(".customize-section-count")?.textContent,
      String(unknown.querySelectorAll(".customize-row").length),
    );
  } finally {
    await env.clean();
  }
});
test("actual Created-by filter uses declared provenance before storage scope/ownership", async () => {
  const env = await environment();
  try {
    await env.render(h(CustomizePage, props));
    await filter(env, "You");
    assert.deepEqual(rows(env.document), ["Declared author", "Local author"]);
    assert.deepEqual(headings(env.document), ["Created by you"]);
    await filter(env, "Your organization");
    assert.deepEqual(rows(env.document), ["Organization"]);
    await filter(env, "Built in");
    assert.deepEqual(rows(env.document), ["Unattributed runtime"]);
    await filter(env, "All");
    assert.equal(rows(env.document).length, skills.length);
    assert.deepEqual(
      visibleSkills(skills, "", "you", "name").map((entry) => entry.name),
      ["Declared author", "Local author"],
    );
  } finally {
    await env.clean();
  }
});
test("filtered empty is a real recoverable state, distinct from first-skill onboarding and load failure", async () => {
  const env = await environment({ customizeSkills: async () => [skills[5]] });
  try {
    await env.render(h(CustomizePage, props));
    assert.ok(env.document.querySelector(".customize-yours-callout"));
    await filter(env, "You");
    assert.equal(env.document.querySelector(".customize-yours-callout"), null);
    assert.equal(
      env.document
        .querySelector(".customize-filter-empty")
        ?.getAttribute("role"),
      "status",
    );
    assert.match(
      env.document.querySelector(".customize-filter-empty")?.textContent ?? "",
      /Nothing matches these filters/,
    );
    assert.equal(rows(env.document).length, 0);
    await env.event(
      env.document.querySelector(".customize-filter-empty button")!,
      "click",
    );
    assert.equal(env.document.querySelector(".customize-filter-empty"), null);
    assert.deepEqual(rows(env.document), ["Publisher"]);
  } finally {
    await env.clean();
  }
  const failed = await environment({
    customizeSkills: async () => {
      throw Error("Synthetic catalogue failure");
    },
  });
  try {
    await failed.render(h(CustomizePage, props));
    assert.equal(
      failed.document.querySelector(".customize-filter-empty"),
      null,
    );
    assert.equal(
      failed.document.querySelector(".customize-yours-callout"),
      null,
    );
    assert.match(
      failed.document.body.textContent ?? "",
      /Couldn’t load your skills/,
    );
  } finally {
    await failed.clean();
  }
});
test("real column ResizeObserver preserves search/filter state through compact, wide and compact transitions", async () => {
  const env = await environment();
  try {
    await env.render(h(CustomizePage, props));
    await env.resize(342);
    assert.ok(env.document.querySelector('button[aria-label="Search"]'));
    assert.equal(
      env.document.querySelector('input[aria-label="Search"]'),
      null,
    );
    await env.click('button[aria-label="Search"]');
    await env.change('input[aria-label="Search"]', "Local");
    assert.deepEqual(rows(env.document), ["Local author"]);
    await env.resize(960);
    assert.equal(
      env.document
        .querySelector('input[aria-label="Search"]')
        ?.getAttribute("value"),
      "Local",
    );
    assert.ok(env.document.querySelector(".customize-search.wide"));
    await env.resize(342);
    assert.ok(env.document.querySelector('input[aria-label="Search"]'));
    assert.deepEqual(rows(env.document), ["Local author"]);
    await env.click('button[aria-label="Clear search"]');
    assert.equal(
      env.document.querySelector('input[aria-label="Search"]'),
      null,
    );
    assert.equal(rows(env.document).length, skills.length);
    await env.resize(960);
    assert.ok(env.document.querySelector('input[aria-label="Search"]'));
    assert.equal(
      env.document.querySelector('button[aria-label="Clear search"]'),
      null,
    );
    await env.resize(342);
    await filter(env, "You");
    assert.deepEqual(rows(env.document), ["Declared author", "Local author"]);
    await env.resize(960);
    assert.deepEqual(rows(env.document), ["Declared author", "Local author"]);
  } finally {
    await env.clean();
  }
});
