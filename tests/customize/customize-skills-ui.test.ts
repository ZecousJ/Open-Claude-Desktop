import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { readFileSync } from "node:fs";
import { routineDom } from "../support/routine-dom";
import { UploadSkillPage } from "../../src/collections/customize/UploadSkillPage";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { CatalogueCards } from "../../src/collections/customize/CustomizeDirectory";
import { sections } from "../../src/collections/customize/customize-list";
import { defaultSettings } from "../../electron/store/store";

async function environment(api: object = {}) {
  const env = await routineDom(
    {
      customizeSkills: async () => [],
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
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const props = {
  settings: defaultSettings,
  onUseSkill() {},
  onOpenSettings() {},
  onConfirmRemove() {},
  onError(error: unknown) {
    throw error;
  },
};
const skill = (name: string, scope: string, provenance?: object) => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  description: "Real runtime skill",
  scope,
  own: scope === "user",
  enabled: true,
  ...(provenance ? { provenance } : {}),
});

test("scan note is shown only for an affirmative current-host scan capability", async () => {
  const env = await environment();
  try {
    await env.render(h(UploadSkillPage, { onBack() {}, onUploaded() {} }));
    assert.equal(env.document.querySelector(".upload-skill-scan"), null);
    env.window.desktop = {
      ...env.window.desktop,
      skillUploadCapabilities: async () => ({ securityScan: true }),
    };
    await env.render(h(UploadSkillPage, { onBack() {}, onUploaded() {} }));
    assert.match(
      env.document.querySelector(".upload-skill-scan")?.textContent ?? "",
      /Security scan.*Runs when you upload/,
    );
    let finish!: (value: { securityScan: boolean }) => void;
    env.window.desktop = {
      ...env.window.desktop,
      skillUploadCapabilities: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    await env.render(h(UploadSkillPage, { onBack() {}, onUploaded() {} }));
    assert.equal(env.document.querySelector(".upload-skill-scan"), null);
    env.window.desktop = {
      ...env.window.desktop,
      skillUploadCapabilities: async () => ({ securityScan: false }),
    };
    await env.render(h(UploadSkillPage, { onBack() {}, onUploaded() {} }));
    await act(async () => finish({ securityScan: true }));
    assert.equal(
      env.document.querySelector(".upload-skill-scan"),
      null,
      "an old host cannot promise a scan for this host",
    );
  } finally {
    await env.clean();
  }
});

test("Yours keeps unknown system origins honest and uses explicit shared/publisher/marketplace provenance", async () => {
  const skills = [
    skill("Generic system", "system"),
    skill("Unknown source", "system", { source: "unrecognized" }),
    skill("Partner", "user", { source: "publisher", publisher: "Claudex" }),
    skill("Shared", "system", { source: "shared" }),
    skill("Marketplace", "system", {
      source: "marketplace",
      marketplace: "Team",
    }),
  ];
  for (const entry of skills)
    assert.equal(
      sections.filter((section) => section.test(entry as never)).length,
      1,
    );
  const env = await environment({ customizeSkills: async () => skills });
  try {
    await env.render(
      h(CustomizePage, {
        ...props,
        route: { section: "skills", view: "yours" },
      }),
    );
    const titles = [
      ...env.document.querySelectorAll(".customize-section > h3"),
    ].map((node) => node.firstChild?.textContent);
    for (const title of [
      "Shared with you",
      "From Claudex & Partners",
      "From marketplaces you added",
    ])
      assert.ok(titles.includes(title), title);
    assert.ok(env.document.body.textContent?.includes("Add your first skills"));
    assert.ok(
      env.document.body.textContent?.includes(
        "Skills teach Claudex how you work. Add them from Discover, or create your own.",
      ),
    );
  } finally {
    await env.clean();
  }
});

const marketplace = {
  name: "knowledge-work-plugins",
  path: "/market",
  plugins: 2,
  source: "git",
};
const catalogPlugin = (name: string, title: string, category?: string) => ({
  id: `${name}@knowledge-work-plugins`,
  name,
  title,
  marketplace: "knowledge-work-plugins",
  marketplacePath: "/market",
  installed: false,
  enabled: true,
  installable: true,
  source: "git" as const,
  ...(category ? { category } : {}),
});
const curated = (
  slug: string,
  curation: Record<string, unknown>,
  added = "2026-10-01T00:00:00Z",
) => ({
  id: `entry-${slug}`,
  kind: "plugin",
  name: slug,
  slug,
  description: "",
  url: "https://fixture.invalid",
  added,
  curation,
});

test("Skills Discover lists the marketplaces' plugins: Data, curated New/Most installed, Categories, real Add and Add-and-try", async () => {
  const actions: string[] = [];
  const installed = new Set<string>();
  const data = catalogPlugin("data", "Data", "data");
  const docs = catalogPlugin("docs", "Docs", "productivity");
  const env = await environment({
    listPlugins: async () => ({
      plugins: [data, docs].map((plugin) => ({
        ...plugin,
        installed: installed.has(plugin.id),
      })),
      marketplaces: [marketplace],
      loadErrors: [],
    }),
    listApprovedDirectory: async () => [
      curated("docs", { isNew: true, popular: true }),
    ],
    installPlugin: async (id: string) => {
      actions.push(`install:${id}`);
      installed.add(id);
      return { appsNeedingAuth: [] };
    },
  });
  try {
    await env.render(
      h(CustomizePage, {
        ...props,
        onUsePlugin: (id) => {
          actions.push(`chat:${id}`);
        },
      }),
    );
    assert.ok(env.document.querySelector('section[aria-label="Data"]'));
    assert.ok(env.document.querySelector('button[aria-label="Add Data"]'));
    const text = env.document.body.textContent ?? "";
    for (const heading of ["New skills", "Most installed skills", "Categories"])
      assert.ok(text.includes(heading), heading);
    assert.doesNotMatch(text, /Included with Claudex|Available skills/);
    const addAndTry = env.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Docs and try it in chat"]',
    )!;
    assert.equal(addAndTry.disabled, false);
    await env.event(addAndTry, "click");
    assert.deepEqual(actions, [`install:${docs.id}`, `chat:${docs.id}`]);
  } finally {
    await env.clean();
  }
});

test("without curation, Skills Discover shows the marketplaces' plugins as Available, never an invented New list", async () => {
  const env = await environment({
    listPlugins: async () => ({
      plugins: [catalogPlugin("docs", "Docs", "productivity")],
      marketplaces: [marketplace],
      loadErrors: [],
    }),
  });
  try {
    await env.render(h(CustomizePage, props));
    const text = env.document.body.textContent ?? "";
    assert.ok(text.includes("Available skills"));
    assert.doesNotMatch(text, /New skills|Most installed skills/);
  } finally {
    await env.clean();
  }
});

test("catalog actions retain captured 60×28 and 28×28 geometry with 117px row pitch", async () => {
  const env = await environment();
  try {
    const style = env.document.createElement("style");
    style.textContent = readFileSync(
      new URL(
        "../../src/collections/customize/customize-directory.css",
        import.meta.url,
      ),
      "utf8",
    );
    env.document.head.append(style);
    await env.render(
      h(CatalogueCards, {
        entries: [
          {
            id: "docs@market",
            name: "Docs",
            description: "Write documents",
            byline: "from Market",
            icon: "file",
          },
        ],
        onOpen() {},
        onAdd() {},
        onAddAndTry() {},
      }),
    );
    const computed = (selector: string) =>
      env.window.getComputedStyle(env.document.querySelector(selector)!);
    assert.equal(computed(".customize-catalogue-try").paddingLeft, "10px");
    assert.equal(computed(".customize-catalogue-try").gap, "6px");
    assert.equal(computed(".customize-catalogue-try").height, "28px");
    assert.equal(computed(".customize-catalogue-add").width, "28px");
    assert.equal(computed(".customize-catalogue-add").height, "28px");
    assert.equal(
      Number.parseInt(computed(".customize-card").minHeight) +
        Number.parseInt(computed(".customize-catalogue-cards").gap),
      117,
    );
  } finally {
    await env.clean();
  }
});

test("the actual Customize page invokes typed search after its existing 250ms debounce", async () => {
  const requests: import("../../shared/customize-search").CustomizeSearchRequest[] =
    [];
  const env = await environment({
    customizeSearch: async (
      request: import("../../shared/customize-search").CustomizeSearchRequest,
    ) => {
      requests.push(request);
      return {
        items:
          request.section === "inPage"
            ? [
                {
                  key: "host-result",
                  kind: "plugin",
                  name: "Host ranked result",
                  yours: false,
                  target: { type: "plugin", id: "actual-plugin" },
                },
              ]
            : [],
        total: request.section === "inPage" ? 1 : 0,
      };
    },
  });
  try {
    await env.render(h(CustomizePage, props));
    if (!env.document.querySelector('input[aria-label="Search"]'))
      await env.click('button[aria-label="Search"]');
    await env.change('input[aria-label="Search"]', "a");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 270));
    });
    assert.equal(requests.length, 0);
    await env.change('input[aria-label="Search"]', "alpha");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 270));
    });
    assert.equal(requests.length, 3);
    assert.ok(
      requests.every(
        (request) => request.query === "alpha" && request.page === "skills",
      ),
    );
    assert.match(env.document.body.textContent ?? "", /Host ranked result/);
  } finally {
    await env.clean();
  }
});

test("Add-and-try waits for required app sign-in rather than opening an unusable chat", async () => {
  let chats = 0;
  const errors: unknown[] = [];
  const env = await environment({
    listPlugins: async () => ({
      plugins: [catalogPlugin("sheets", "Sheets", "data")],
      marketplaces: [marketplace],
      loadErrors: [],
    }),
    installPlugin: async () => ({ appsNeedingAuth: ["Sheets"] }),
  });
  try {
    await env.render(
      h(CustomizePage, {
        ...props,
        onError: (error) => errors.push(error),
        onUsePlugin: () => {
          chats++;
        },
      }),
    );
    await env.click('button[aria-label="Add Sheets and try it in chat"]');
    // Added; the toast asks for the apps' sign-in instead of a chat.
    assert.equal(chats, 0);
    assert.deepEqual(errors, []);
  } finally {
    await env.clean();
  }
});

test("actual Plugins Add menu keeps source actions before submission extensions", async () => {
  const env = await environment({
    listPlugins: async () => ({
      plugins: [],
      marketplaces: [{ name: "test", path: "/test", plugins: 0 }],
      loadErrors: [],
    }),
  });
  try {
    await env.render(
      h(CustomizePage, {
        ...props,
        route: { section: "plugins", view: "discover" },
      }),
    );
    await env.click('button[aria-label="Add plugin"]');
    const menu = env.document.querySelector('[role="menu"]');
    assert.ok(menu);
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((e) =>
      e.querySelector(":scope > span:last-of-type")?.textContent?.trim(),
    );
    assert.deepEqual(labels.slice(0, 4), [
      "Add marketplace",
      "Manage marketplaces",
      "Upload plugin",
      "Create a plugin",
    ]);
    assert.ok(
      labels.indexOf("Submit a plugin") > labels.indexOf("Create a plugin"),
    );
    assert.ok(menu.querySelector('hr, [role="separator"]'));
  } finally {
    await env.clean();
  }
});
