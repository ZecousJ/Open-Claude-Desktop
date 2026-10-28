import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import type { LinearAPI } from "../../shared/linear-api";
import type {
  CustomizeSkill,
  SkillContents,
} from "../../shared/collections-api";
import type { CustomizePlace } from "../../src/web/customize-route";
import { defaultSettings } from "../../electron/store/store";
import { hostFor } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import {
  directoryConnectors,
  connectors,
  connectorServer,
} from "../../shared/connectors-catalogue";
import {
  connectorCategories,
  connectorPublishedUrl,
  connectorSupportUrl,
  relatedConnectors,
} from "../../src/settings/directory/connector-detail-model";
import ConnectorDetail from "../../src/settings/tabs/ConnectorDetail";
import { collectionsFixture } from "../../scripts/preview/fixtures/collections";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";

const published: ApprovedDirectoryEntry = {
  id: "service-example",
  kind: "mcp",
  name: "Example",
  description: "Published description",
  url: "https://example.test/mcp",
  added: "2025-11-12",
  author: "Example Publisher",
  documentationUrl: "https://docs.example.test",
  isAuthless: false,
  tools: ["search_pages", "read_page"],
  curation: {
    publisherUrl: "https://example.test/",
    supportUrl: "mailto:developer@example.test",
    categories: ["Files & documents", "Notes & memory"],
    privacyPolicyUrl: "https://example.test/privacy",
    relatedIds: ["notion", "notion", "missing", "service-example"],
  },
};
const props = {
  editable: true,
  onBack() {},
  onConnect: async () => {},
  onSet() {},
  onError(error: unknown) {
    throw error;
  },
};

test("connector detail uses measured text rhythm without fixed paragraph or CTA widths", () => {
  const css = readFileSync("src/settings/tabs/connector-detail.css", "utf8");
  const description = css.match(
    /\.connector-published-description\s*\{([^}]+)\}/,
  )![1];
  const subtitle = css.match(
    /\.connector-published-title > p\s*\{([^}]+)\}/,
  )![1];
  const cta = css.match(
    /\.connector-published-primary > \.primary\s*\{([^}]+)\}/,
  )![1];
  assert.match(description, /font-size:\s*14px;/);
  assert.match(description, /line-height:\s*26\.4px;/);
  assert.doesNotMatch(description, /(?:^|;)\s*(?:min-|max-)?height\s*:/);
  assert.match(subtitle, /font-size:\s*15px;/);
  assert.match(subtitle, /line-height:\s*20px;/);
  assert.match(cta, /min-height:\s*40px;/);
  assert.doesNotMatch(cta, /(?:^|;)\s*(?:min-|max-)?width\s*:/);
});

test("connector metadata preserves the measured field and category box model", () => {
  const css = readFileSync("src/settings/tabs/connector-detail.css", "utf8");
  const rule = (selector: string) =>
    css.match(
      new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]+)\\}`,
      ),
    )![1];
  const metadata = rule(".connector-published-metadata");
  assert.match(metadata, /margin:\s*6px 0 0;/);
  assert.match(metadata, /gap:\s*24px;/);
  assert.doesNotMatch(metadata, /(?:^|;)\s*(?:min-|max-)?height\s*:/);
  const label = rule(".connector-published-field dt");
  assert.match(label, /margin-bottom:\s*4px;/);
  assert.match(label, /font-size:\s*12px;/);
  assert.match(label, /line-height:\s*17px;/);
  assert.match(label, /font-weight:\s*500;/);
  assert.match(label, /letter-spacing:\s*0\.3px;/);
  const value = rule(".connector-published-field dd");
  assert.match(value, /font-size:\s*14px;/);
  assert.match(value, /line-height:\s*20px;/);
  const categories = rule(".connector-published-categories");
  assert.match(categories, /display:\s*flex;/);
  assert.match(categories, /flex-wrap:\s*wrap;/);
  assert.match(categories, /padding-top:\s*4px;/);
  assert.doesNotMatch(categories, /(?:^|;)\s*margin-top\s*:/);
  assert.doesNotMatch(categories, /(?:^|;)\s*(?:min-|max-)?height\s*:/);
  assert.match(categories, /margin-inline:\s*-4px;/);
  assert.match(categories, /gap:\s*8px;/);
  const url = rule(".connector-published-url");
  assert.match(url, /position:\s*relative;/);
  assert.doesNotMatch(url, /(?:^|;)\s*(?:min-|max-)?height\s*:/);
  const text = rule(".connector-published-url > span");
  assert.match(text, /13px\/19px/);
  assert.doesNotMatch(text, /(?:^|;)\s*padding(?:-[a-z-]+)?\s*:/);
  const copy = rule(".connector-published-url > button");
  assert.match(copy, /position:\s*absolute;/);
  assert.match(copy, /top:\s*-6px;/);
  assert.match(copy, /height:\s*28px;/);
});

test("published metadata preserves service values, declared relations and unknown fields", () => {
  const catalogue = directoryConnectors([published]);
  const entry = catalogue.find((entry) => entry.id === published.id)!;
  assert.equal(entry.publisherUrl, published.curation!.publisherUrl);
  assert.equal(entry.supportUrl, "mailto:developer@example.test");
  assert.deepEqual(connectorCategories(entry), [
    "Files & documents",
    "Notes & memory",
  ]);
  assert.deepEqual(
    relatedConnectors(entry, catalogue).map((entry) => entry.id),
    ["notion"],
  );
  const google = catalogue.find((entry) => entry.id === "google-drive")!;
  assert.equal(google.publisherUrl, undefined);
  assert.equal(google.privacyPolicyUrl, undefined);
  assert.deepEqual(relatedConnectors(google, catalogue), []);
  const enriched = directoryConnectors([
    { ...published, name: "Notion", url: "https://mcp.notion.com/mcp" },
  ]);
  assert.deepEqual(
    relatedConnectors({ ...entry, relatedIds: [published.id] }, enriched).map(
      (entry) => entry.id,
    ),
    ["notion"],
  );
});

test("metadata links accept published websites and support email without guessing URLs", () => {
  assert.equal(
    connectorPublishedUrl("https://example.test/publisher"),
    "https://example.test/publisher",
  );
  assert.equal(
    connectorSupportUrl("mailto:developer@example.test"),
    "mailto:developer@example.test",
  );
  for (const bad of [
    "javascript:alert(1)",
    "https://user:secret@example.test",
    "notion.com",
    "https://claude.ai/help",
  ])
    assert.equal(connectorPublishedUrl(bad), undefined, bad);
  assert.equal(
    connectorSupportUrl("mailto:developer@example.test?body=unexpected"),
    undefined,
  );
});

test("Customize connector detail has real metadata order, optional links and plain published tool names", () => {
  const catalogue = directoryConnectors([published]);
  const entry = catalogue.find((entry) => entry.id === published.id)!;
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(ConnectorDetail, {
        ...props,
        presentation: "customize",
        entry,
        related: [catalogue.find((entry) => entry.id === "notion")!],
      }),
    ),
  );
  assert.equal(
    document.querySelector("h1[data-no-translate]")?.textContent,
    "Example",
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll("dt"), (item) => item.textContent),
    [
      "Made by",
      "Categories",
      "Sign-in",
      "Connector URL",
      "Added to directory",
      "More info",
    ],
  );
  assert.equal(
    document.querySelector(
      'a[href="https://example.test/"] [data-no-translate]',
    )?.textContent,
    "Example Publisher",
  );
  assert.ok(document.querySelector('a[href="mailto:developer@example.test"]'));
  assert.ok(document.querySelector('button[aria-label="Copy server URL"]'));
  assert.deepEqual(
    Array.from(
      document.querySelectorAll(".connector-published-tools li"),
      (item) => item.textContent,
    ),
    ["read_page", "search_pages"],
  );
  assert.equal(document.querySelector(".tool-permissions"), null);
  assert.equal(
    document.querySelectorAll(
      ".connector-published-related .connector-directory-rows > li",
    ).length,
    1,
  );
  const unknown = renderToStaticMarkup(
    createElement(ConnectorDetail, {
      ...props,
      presentation: "customize",
      entry: {
        ...entry,
        byline: "",
        categories: [],
        topic: "",
        isAuthless: undefined,
        url: undefined,
        added: undefined,
        publisherUrl: undefined,
        documentationUrl: undefined,
        supportUrl: undefined,
        privacyPolicyUrl: undefined,
        tools: undefined,
      },
    }),
  );
  assert.doesNotMatch(
    unknown,
    /<dt>|connector-published-related|connector-published-tools|Review status/,
  );
});

test("directory added months remain accurate west of UTC", () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const { document } = parseHTML(
      renderToStaticMarkup(
        createElement(ConnectorDetail, {
          ...props,
          presentation: "customize",
          entry: directoryConnectors([]).find(
            (entry) => entry.id === "notion",
          )!,
        }),
      ),
    );
    const added = Array.from(document.querySelectorAll("dt")).find(
      (item) => item.textContent === "Added to directory",
    );
    assert.equal(added?.nextElementSibling?.textContent, "November 2025");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

async function withPage(
  initial: CustomizePlace,
  run: (context: {
    document: Document;
    navigate: (place: CustomizePlace) => Promise<void>;
    places: CustomizePlace[];
    errors: unknown[];
    copies: string[];
  }) => Promise<void>,
  options: {
    skills?: CustomizeSkill[];
    failDirectoryOnce?: boolean;
    directory?: () => Promise<unknown>;
    linearStatus?: LinearAPI["linearStatus"];
    readSkill?: (path: string) => Promise<SkillContents>;
  } = {},
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const errors: unknown[] = [];
  const copies: string[] = [];
  let directoryFails = options.failDirectoryOnce;
  window.desktop = {
    customizeSkills: async () => options.skills ?? [],
    readSkill:
      options.readSkill ??
      (async () => ({ markdown: "", files: [], truncated: false })),
    mcpServers: async () => ({ servers: [] }),
    linearStatus: options.linearStatus ?? (async () => ({ connected: false })),
    listApprovedDirectory: async () => {
      if (options.directory) return options.directory();
      if (directoryFails) {
        directoryFails = false;
        throw new Error("Directory unavailable");
      }
      return [published];
    },
    listPlugins: async () => ({
      plugins: [],
      marketplaces: [],
      loadErrors: [],
    }),
    onEvent: () => () => {},
    copyText: async (value: string) => {
      copies.push(value);
    },
    addCustomConnector: async () => {
      throw new Error("Network unavailable");
    },
  } as never;
  const globals = {
    window,
    document,
    location: new URL("https://app.example/customize/connectors"),
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
  const places: CustomizePlace[] = [];
  let place = initial;
  const view = () =>
    createElement(
      HostContext.Provider,
      {
        value: {
          ...hostFor("web"),
          capabilities: {
            ...hostFor("web").capabilities,
            customConnectors: true,
          },
        },
      },
      createElement(CustomizePage, {
        settings: defaultSettings,
        route: place,
        onRouteChange(next) {
          places.push(next);
          place = next;
          root.render(view());
        },
        onUseSkill() {},
        onOpenSettings() {},
        onConfirmRemove() {},
        onError(error) {
          errors.push(error);
        },
      }),
    );
  const render = async () => {
    await act(async () => {
      root.render(view());
    });
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
  };
  try {
    await render();
    await run({
      document: document as unknown as Document,
      navigate: async (next) => {
        place = next;
        await render();
      },
      places,
      errors,
      copies,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

test("controlled Customize synchronizes section and view and opens real connector records in place", async () => {
  await withPage(
    { section: "skills", view: "yours" },
    async ({ document, navigate, places, errors }) => {
      await navigate({ section: "connectors", view: "discover" });
      assert.equal(
        document.querySelector('.customize-tabs [aria-selected="true"]')
          ?.textContent,
        "Connectors",
      );
      assert.equal(
        document.querySelector(
          '.customize-views[aria-label="Connectors"] [aria-checked="true"]',
        )?.textContent,
        "Discover",
      );
      const showAll = Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          ".customize-connector-shelf-head a",
        ),
      ).find((button) => button.textContent === "Show all")!;
      assert.ok(showAll);
      assert.equal(
        showAll.getAttribute("aria-label"),
        `Show all ${showAll.parentElement!.querySelector("h2")!.firstChild!.textContent}`,
      );
      await act(async () => showAll.click());
      const entry = document.querySelector<HTMLAnchorElement>(
        '.connector-directory-row-main[href="/customize/connectors/id/service-example"]',
      )!;
      assert.ok(entry);
      await act(async () => entry.click());
      for (let i = 0; i < 10; i++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      assert.deepEqual(places.at(-1), {
        section: "connectors",
        view: "discover",
        detailId: "service-example",
      });
      assert.equal(
        document.querySelector(".connector-published-detail h1")?.textContent,
        "Example",
      );
      await navigate({ section: "connectors", view: "yours" });
      assert.equal(document.querySelector(".connector-published-detail"), null);
      assert.equal(
        document.querySelector('.customize-views [aria-checked="true"]')
          ?.textContent,
        "Yours",
      );
      assert.deepEqual(errors, []);
    },
  );
});

test("all actual Customize tabs expose their accurate Add names and glyph sizes", async () => {
  await withPage(
    { section: "skills", view: "discover" },
    async ({ document, navigate }) => {
      for (const [section, label] of [
        ["skills", "Add skill"],
        ["connectors", "Add connector"],
        ["plugins", "Add plugin"],
      ] as const) {
        await navigate({ section, view: "discover" });
        const add = document.querySelector(
          ".customize-add",
        ) as HTMLButtonElement;
        assert.ok(add);
        assert.equal(add.getAttribute("aria-label"), label);
        assert.equal(add.getAttribute("aria-haspopup"), "menu");
        const size = (element: Element | null) =>
          element?.getAttribute("width") ??
          /font-size:calc\((\d+)px/.exec(
            element?.getAttribute("style") ?? "",
          )?.[1];
        assert.equal(size(add.firstElementChild), "20");
        assert.equal(size(add.lastElementChild), "16");
        await act(async () => add.click());
        assert.equal(add.getAttribute("aria-expanded"), "true");
        assert.ok(document.querySelector('[role="menu"]'));
      }
    },
  );
});

test("unknown connector deep links stay distinct from the directory list", async () => {
  await withPage(
    { section: "connectors", view: "discover", detailId: "missing" },
    async ({ document }) => {
      assert.match(
        document.querySelector('[role="status"]')?.textContent ?? "",
        /Connector not found/,
      );
      assert.equal(document.querySelector(".connector-directory-rows"), null);
    },
  );
});

test("known Notion metadata is confined to its observed record", () => {
  const notion = connectors.find((entry) => entry.id === "notion")!;
  assert.equal(notion.url, "https://mcp.notion.com/mcp");
  assert.equal(notion.publisherUrl, "https://notion.com/");
  assert.deepEqual(notion.categories, [
    "Files & documents",
    "Notes & memory",
    "Databases",
  ]);
  assert.equal(
    connectors.find((entry) => entry.id === "google-drive")!.publisherUrl,
    undefined,
  );
  const googleDrive = {
    ...connectors.find((entry) => entry.id === "google-drive")!,
    url: "https://collision.example.test/mcp",
  };
  assert.equal(
    connectorServer(googleDrive, [
      {
        name: "Custom same URL",
        state: "ready",
        tools: 0,
        url: googleDrive.url,
      },
      {
        name: "Native Google Drive",
        connectorId: "google-drive",
        state: "ready",
        tools: 0,
      },
    ])?.name,
    "Native Google Drive",
  );
  const unrelated = directoryConnectors([
    {
      ...published,
      name: "Notion",
      author: undefined,
      curation: undefined,
      tools: undefined,
    },
  ]).find((entry) => entry.id === published.id)!;
  assert.equal(unrelated.publisherUrl, undefined);
  assert.equal(unrelated.longDescription, undefined);
  assert.equal(unrelated.iconUrl, undefined);
  assert.equal(unrelated.categories, undefined);
  assert.equal(unrelated.supportUrl, undefined);
  assert.equal(unrelated.tools, undefined);
});

test("detail copy actions use real values and a failed connect never becomes connected", async () => {
  await withPage(
    { section: "connectors", view: "discover", detailId: "notion" },
    async ({ document, copies, errors }) => {
      const urlCopy = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy server URL"]',
      )!;
      assert.ok(urlCopy);
      await act(async () => urlCopy.click());
      const linkCopy = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".connector-published-copy",
        ),
      ).find((button) => button.textContent === "Copy link")!;
      assert.ok(linkCopy);
      await act(async () => linkCopy.click());
      assert.deepEqual(copies, [
        "https://mcp.notion.com/mcp",
        "https://app.example/customize/connectors/id/notion",
      ]);
      const connect = document.querySelector<HTMLButtonElement>(
        ".connector-published-primary > .primary",
      )!;
      assert.ok(connect);
      assert.equal(connect.disabled, false);
      await act(async () => connect.click());
      assert.equal(errors.length, 1);
      assert.equal((errors[0] as Error).message, "Network unavailable");
      assert.equal(connect.textContent, "Connect to Claudex");
      assert.equal(connect.disabled, false);
    },
  );
});

test("a failed directory request is recoverable and never labels an existing connector as missing", async () => {
  await withPage(
    { section: "connectors", view: "discover", detailId: published.id },
    async ({ document }) => {
      assert.match(
        document.querySelector('[role="status"]')?.textContent ?? "",
        /Couldn’t load connectors/,
      );
      assert.doesNotMatch(
        document.querySelector('[role="status"]')?.textContent ?? "",
        /Connector not found/,
      );
      const retry = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="status"] button'),
      ).find((button) => button.textContent === "Try again")!;
      assert.ok(retry);
      await act(async () => retry.click());
      for (let i = 0; i < 10; i++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      assert.equal(
        document.querySelector(".connector-published-detail h1")?.textContent,
        "Example",
      );
    },
    { failDirectoryOnce: true },
  );
});

test("empty approved-service arrays are successful and retain genuine seed records", async () => {
  await withPage(
    { section: "connectors", view: "discover", detailId: "notion" },
    async ({ document }) => {
      assert.equal(document.querySelector("h1")?.textContent, "Notion");
      assert.ok(document.querySelector('a[href="https://notion.com/"]'));
      assert.doesNotMatch(
        document.body.textContent ?? "",
        /Couldn’t load connectors/,
      );
      assert.equal(
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent === "Try again",
        ),
        undefined,
      );
    },
    { directory: async () => [] },
  );
});

test("malformed and rejected approved-service responses are recoverable failures even for a known seed detail", async (context) => {
  const failures = [
    { name: "undefined", response: undefined },
    { name: "null", response: null },
    { name: "object instead of array", response: { entries: [] } },
    { name: "malformed array row", response: [null] },
    {
      name: "malformed metadata",
      response: [{ ...published, curation: { categories: 42 } }],
    },
    { name: "rejected request", response: new Error("Directory unavailable") },
  ];
  for (const failure of failures) {
    await context.test(failure.name, async () => {
      let reads = 0;
      await withPage(
        { section: "connectors", view: "discover", detailId: "notion" },
        async ({ document }) => {
          assert.match(
            document.querySelector('[role="status"]')?.textContent ?? "",
            /Couldn’t load connectors/,
          );
          assert.equal(
            document.querySelector(".connector-published-detail"),
            null,
          );
          assert.doesNotMatch(
            document.body.textContent ?? "",
            /Connector not found/,
          );
          const retry = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent === "Try again",
          )!;
          assert.ok(retry);
          await act(async () => {
            retry.click();
            await new Promise((resolve) => setTimeout(resolve, 25));
          });
          assert.equal(reads, 2);
          assert.equal(document.querySelector("h1")?.textContent, "Notion");
          assert.doesNotMatch(
            document.body.textContent ?? "",
            /Couldn’t load connectors/,
          );
        },
        {
          directory: async () => {
            reads++;
            if (reads > 1) return [];
            if (failure.response instanceof Error) throw failure.response;
            return failure.response;
          },
        },
      );
    });
  }
});

test("offline collections explicitly supplies an empty synthetic approved feed without adding capabilities", async () => {
  const state = fixtureSnapshot({ history: "empty" });
  const hostBefore = structuredClone(state.host);
  const bridge = collectionsFixture.bridge({
    params: new URLSearchParams(
      "fonts=system&weekly=none&cloud=cowork&connectors=1",
    ),
    state,
    origin: 1,
    emit() {},
  });
  assert.ok(
    Object.prototype.hasOwnProperty.call(bridge, "listApprovedDirectory"),
  );
  assert.deepEqual(await bridge.listApprovedDirectory!(), []);
  assert.ok(Object.prototype.hasOwnProperty.call(bridge, "linearStatus"));
  assert.deepEqual(await bridge.linearStatus!(), { connected: false });
  assert.deepEqual(state.host, hostBefore);
  await withPage(
    { section: "connectors", view: "discover", detailId: "notion" },
    async ({ document, errors }) => {
      assert.equal(document.querySelector("h1")?.textContent, "Notion");
      assert.equal(document.querySelector('[role="status"]'), null);
      assert.deepEqual(errors, []);
    },
    {
      directory: bridge.listApprovedDirectory,
      linearStatus: bridge.linearStatus,
    },
  );
});

test("ambiguous installed skill names are not resolved to an arbitrary path", async () => {
  const skill = {
    name: "repeat",
    description: "",
    scope: "user" as const,
    own: true,
    enabled: true,
  };
  await withPage(
    { section: "skills", view: "yours", detailId: "repeat" },
    async ({ document }) => {
      assert.match(
        document.querySelector('[role="status"]')?.textContent ?? "",
        /More than one skill has this name\./,
      );
      assert.equal(document.querySelector(".skill-detail"), null);
    },
    {
      skills: [
        { ...skill, path: "/profile/skills/repeat/SKILL.md" },
        { ...skill, path: "/other/skills/repeat/SKILL.md" },
      ],
    },
  );
});

test("a slower previous skill response never replaces the current detail", async () => {
  const makeSkill = (name: string): CustomizeSkill => ({
    name,
    description: "",
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    own: true,
    enabled: true,
  });
  const skills = [makeSkill("A"), makeSkill("B")];
  let finishA!: (value: SkillContents) => void;
  let finishB!: (value: SkillContents) => void;
  const pendingA = new Promise<SkillContents>((resolve) => {
    finishA = resolve;
  });
  const pendingB = new Promise<SkillContents>((resolve) => {
    finishB = resolve;
  });
  const contents = (markdown: string): SkillContents => ({
    markdown,
    files: [{ path: "SKILL.md", bytes: markdown.length }],
    truncated: false,
  });
  await withPage(
    { section: "skills", view: "yours", detailId: "A", detailView: "contents" },
    async ({ document, navigate }) => {
      await navigate({
        section: "skills",
        view: "yours",
        detailId: "B",
        detailView: "contents",
      });
      assert.ok(document.querySelector(".skill-detail-loading"));
      await act(async () => finishB(contents("CURRENT_B")));
      assert.match(
        document.querySelector(".skill-detail-markdown")?.textContent ?? "",
        /CURRENT_B/,
      );
      await act(async () => finishA(contents("STALE_A")));
      assert.match(
        document.querySelector(".skill-detail-markdown")?.textContent ?? "",
        /CURRENT_B/,
      );
      assert.doesNotMatch(
        document.querySelector(".skill-detail-markdown")?.textContent ?? "",
        /STALE_A/,
      );
    },
    {
      skills,
      readSkill: (path) => (path === skills[0].path ? pendingA : pendingB),
    },
  );
});

test("user-title modal opt-in preserves names while default modal titles and buttons still translate", () => {
  const script = `
    const {parseHTML}=await import('linkedom');
    const {window,document}=parseHTML('<html><body></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
    const {createElement,Fragment}=await import('react');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {Modal}=await import('./src/ui/Controls.tsx');
    const {setLocale}=await import('./src/i18n/index.ts');
    const {startDomTranslation}=await import('./src/i18n/dom.ts');
    document.body.innerHTML=renderToStaticMarkup(createElement(Fragment,null,
      createElement(Modal,{title:'Settings',titleIsUserData:true,onClose(){},className:'user-modal'},createElement('button',{className:'probe-save'},'Save')),
      createElement(Modal,{title:'Settings',onClose(){},className:'standard-modal'},createElement('button',{className:'probe-save'},'Save'))));
    await setLocale('zh-CN');startDomTranslation();
    const user=document.querySelector('.user-modal'),standard=document.querySelector('.standard-modal');
    console.log(JSON.stringify({name:user.querySelector('h2').textContent,label:user.getAttribute('aria-label'),labelled:user.getAttribute('aria-labelledby')===user.querySelector('h2').id,userSave:user.querySelector('.probe-save').textContent,standardTitle:standard.querySelector('h2').textContent,standardLabel:standard.getAttribute('aria-label'),standardSave:standard.querySelector('.probe-save').textContent}));
  `;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/support/css-stub.mjs",
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.deepEqual(result, {
    name: "Settings",
    label: null,
    labelled: true,
    userSave: "保存",
    standardTitle: "设置",
    standardLabel: "设置",
    standardSave: "保存",
  });
});

test("tool group accessible names preserve server data while permission controls translate", () => {
  const script = `
    const {parseHTML}=await import('linkedom');
    const {window,document}=parseHTML('<html><body></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
    const {createElement}=await import('react');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {ToolPermissions}=await import('./src/settings/tabs/ToolPermissions.tsx');
    const {setLocale}=await import('./src/i18n/index.ts');
    const {startDomTranslation}=await import('./src/i18n/dom.ts');
    await setLocale('zh-CN');
    document.body.innerHTML=renderToStaticMarkup(createElement(ToolPermissions,{server:'Search',tools:[{name:'Settings',description:'Search',enabled:true,approval:'prompt'}],editable:true,onSet(){}}));
    startDomTranslation();
    const group=document.querySelector('.tool-permissions-all');
    const listName=document.querySelector('ul').getAttribute('aria-labelledby').split(' ').map(id=>document.getElementById(id).textContent).join(' ');
    console.log(JSON.stringify({name:document.getElementById(group.getAttribute('aria-labelledby')).textContent,listName,control:group.textContent,tool:document.querySelector('strong').textContent,description:document.querySelector('strong+span').textContent,needsApproval:document.querySelector('[role="radio"][aria-checked="true"]').getAttribute('aria-label')}));
  `;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/support/css-stub.mjs",
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.equal(result.name, "Search 全部工具的权限");
  assert.equal(result.listName, "工具 Search");
  assert.equal(result.tool, "Settings");
  assert.equal(result.description, "Search");
  assert.ok(result.control.includes(result.needsApproval));
  assert.notEqual(result.control, "Needs approval");
});
