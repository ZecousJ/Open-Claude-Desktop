import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import type {
  CustomizeSkill,
  SkillContents,
} from "../../shared/collections-api";
import { webHost } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import { HostContext } from "../../src/host/HostContext";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { SkillDetail } from "../../src/collections/customize/SkillDetail";
import type { CustomizePlace } from "../../src/web/customize-route";
import { atomicChatDom } from "../support/atomic-chat-dom";

const skill = (name: string, editedAt: number): CustomizeSkill => ({
  name,
  description: `${name} actual description`,
  path: `/skills/${name}/SKILL.md`,
  own: false,
  scope: "system",
  enabled: true,
  editedAt,
});
const files: SkillContents = {
  markdown: "# Actual skill instructions",
  files: [
    { path: "SKILL.md", bytes: 27 },
    { path: "examples/input.txt", bytes: 13 },
  ],
  truncated: false,
};
async function environment(bridge: Partial<Window["desktop"]> = {}) {
  const env = await atomicChatDom({
    customizeSkills: async () => [],
    mcpServers: async () => ({ servers: [], configPath: "" }),
    listPlugins: async () => ({
      plugins: [],
      marketplaces: [],
      loadErrors: [],
    }),
    listApprovedDirectory: async () => [],
    ...bridge,
  });
  env.window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof matchMedia;
  return env;
}
async function click(
  env: Awaited<ReturnType<typeof environment>>,
  target: Element,
) {
  await act(async () => {
    target.dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}
const props = {
  settings: defaultSettings,
  onUseSkill(_name: string) {},
  onOpenSettings() {},
  onConfirmRemove() {},
  onError: (error: unknown) => assert.fail(String(error)),
};

test("shell 55 reused Yours empty callout, real sort/filter and Discover action preserve runtime provenance", async () => {
  const env = await environment({
    customizeSkills: async () => [skill("zeta", 2), skill("alpha", 1)],
  });
  const routes: CustomizePlace[] = [];
  function Page() {
    const [route, setRoute] = useState<CustomizePlace>({
      section: "skills",
      view: "yours",
    });
    return createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(CustomizePage, {
        ...props,
        route,
        onRouteChange(next) {
          routes.push(next);
          setRoute(next);
        },
      }),
    );
  }
  const rows = () =>
    Array.from(env.document.querySelectorAll(".customize-row-main")).map(
      (row) => row.getAttribute("aria-label"),
    );
  try {
    await env.render(createElement(Page));
    assert.equal(
      env.document.querySelector(".customize-yours-callout h3")?.textContent,
      "Add your first skills",
    );
    assert.deepEqual(
      Array.from(
        env.document.querySelectorAll('.customize-tabs [role="tab"]'),
      ).map((tab) => tab.textContent),
      ["Skills", "Connectors", "Plugins"],
    );
    assert.ok(env.document.querySelector('[aria-label="Add skill"]'));
    assert.equal(
      env.document.querySelector(".customize-yours .customize-section h3")
        ?.firstChild?.textContent,
      "From Claudex & Partners",
    );
    assert.equal(
      env.document
        .querySelector(".customize-yours")
        ?.textContent?.includes("From Anthropic & Partners"),
      false,
    );
    assert.deepEqual(rows(), ["View zeta", "View alpha"]);
    await click(
      env,
      env.document.querySelector('[aria-label="Sort by Last edited"]')!,
    );
    await click(
      env,
      Array.from(env.document.querySelectorAll('[role="menuitemradio"]')).find(
        (row) => row.textContent === "Name",
      )!,
    );
    assert.deepEqual(rows(), ["View alpha", "View zeta"]);
    assert.ok(env.document.querySelector('[aria-label="Sort by Name"]'));
    await click(env, env.document.querySelector('[aria-label="Filter"]')!);
    await click(
      env,
      Array.from(env.document.querySelectorAll('[role="menuitemradio"]')).find(
        (row) => row.textContent === "You",
      )!,
    );
    assert.deepEqual(rows(), []);
    assert.ok(
      env.document.body.textContent?.includes("Nothing matches these filters."),
    );
    const reset = Array.from(env.document.querySelectorAll("button")).find(
      (button) => button.textContent === "Reset filters",
    );
    assert.ok(reset);
    await click(env, reset);
    assert.deepEqual(rows(), ["View alpha", "View zeta"]);
    const discover = Array.from(
      env.document.querySelectorAll(".customize-yours-callout button"),
    ).find((button) => button.textContent === "Discover skills")!;
    await click(env, discover);
    assert.deepEqual(routes.at(-1), { section: "skills", view: "discover" });
  } finally {
    await env.clean();
  }
});

test("shell 55 actual Yours route opens linked details and Contents, reads real files and persists enable changes", async () => {
  let saved = skill("actual-skill", 1);
  const writes: [string, boolean][] = [],
    reads: [string, string][] = [],
    tried: string[] = [];
  const env = await environment({
    customizeSkills: async () => [saved],
    readSkill: async () => files,
    readSkillFile: async (path, file) => {
      reads.push([path, file]);
      return { text: "Actual input", binary: false, truncated: false };
    },
    setSkillEnabled: async (path, enabled) => {
      writes.push([path, enabled]);
      saved = { ...saved, enabled };
    },
  });
  const routes: CustomizePlace[] = [];
  function Page() {
    const [route, setRoute] = useState<CustomizePlace>({
      section: "skills",
      view: "yours",
    });
    return createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(CustomizePage, {
        ...props,
        route,
        onUseSkill(name) {
          tried.push(name);
        },
        onRouteChange(next) {
          routes.push(next);
          setRoute(next);
        },
      }),
    );
  }
  try {
    await env.render(createElement(Page));
    await click(
      env,
      env.document.querySelector('[aria-label="View actual-skill"]')!,
    );
    await env.settle();
    assert.deepEqual(routes.at(-1), {
      section: "skills",
      view: "yours",
      detailId: saved.name,
    });
    assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 0);
    assert.equal(
      env.document.querySelector(".installed-skill-head h2")?.textContent,
      saved.name,
    );
    // No creator is reported for this skill, so no Created by block is drawn.
    assert.equal(
      env.document.querySelector(".installed-skill-overview aside"),
      null,
    );
    const contents = env.document.querySelector<HTMLAnchorElement>(
      '.installed-skill-tabs a[href$="/contents"]',
    )!;
    assert.equal(contents.textContent, "Contents · 2");
    assert.equal(
      contents.getAttribute("href"),
      "/customize/skills/yours/id/actual-skill/contents",
    );
    await click(env, contents);
    assert.equal(routes.at(-1)?.detailView, "contents");
    assert.equal(
      env.document.querySelector(".installed-skill-reader h1")?.textContent,
      "Actual skill instructions",
    );
    assert.deepEqual(reads, []);
    await click(
      env,
      Array.from(
        env.document.querySelectorAll(".installed-skill-contents li > button"),
      ).find((button) => button.textContent === "input.txt")!,
    );
    assert.deepEqual(reads, [[saved.path, "examples/input.txt"]]);
    assert.equal(
      env.document.querySelector(".installed-skill-reader pre")?.textContent,
      "Actual input",
    );
    await click(env, env.document.querySelector('[role="switch"]')!);
    assert.deepEqual(writes, [[saved.path, false]]);
    assert.equal(
      env.document
        .querySelector('[role="switch"]')
        ?.getAttribute("aria-checked"),
      "false",
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".installed-skill-try")
        ?.disabled,
      true,
    );
    await click(env, env.document.querySelector('[role="switch"]')!);
    assert.deepEqual(writes, [
      [saved.path, false],
      [saved.path, true],
    ]);
    await click(env, env.document.querySelector(".installed-skill-back")!);
    assert.deepEqual(routes.at(-1), { section: "skills", view: "yours" });
    await click(
      env,
      env.document.querySelector('[aria-label="View actual-skill"]')!,
    );
    await env.settle();
    await click(env, env.document.querySelector(".installed-skill-try")!);
    assert.deepEqual(tried, [saved.name]);
    assert.deepEqual(routes.at(-1), { section: "skills", view: "yours" });
  } finally {
    await env.clean();
  }
});

test("shell 55 failed Contents never fabricates a count and retries through the real reader", async () => {
  let attempts = 0;
  const env = await environment({
    readSkill: async () => {
      if (++attempts === 1) throw new Error("Actual read failure");
      return files;
    },
  });
  try {
    await env.render(
      createElement(SkillDetail, {
        skill: skill("readable", 1),
        added: true,
        busy: false,
        onClose() {},
        onAdd: async () => {},
        onTry() {},
        onToggle: async () => {},
        onRemove() {},
        page: {
          view: "contents",
          onViewChange() {},
          links: {
            back: "/customize/skills/yours",
            overview: "/customize/skills/yours/id/readable",
            contents: "/customize/skills/yours/id/readable/contents",
          },
        },
      }),
    );
    await env.settle();
    assert.equal(
      env.document.querySelector('.installed-skill-tabs a[href$="/contents"]')
        ?.textContent,
      "Contents",
    );
    assert.equal(
      env.document.querySelector('[role="alert"] p')?.textContent,
      "Actual read failure",
    );
    await click(env, env.document.querySelector('[role="alert"] button')!);
    assert.equal(attempts, 2);
    assert.equal(
      env.document.querySelector('.installed-skill-tabs a[href$="/contents"]')
        ?.textContent,
      "Contents · 2",
    );
    assert.equal(
      env.document.querySelector(".installed-skill-reader h1")?.textContent,
      "Actual skill instructions",
    );
  } finally {
    await env.clean();
  }
});
