import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import {
  CatalogueCards,
  type CatalogueCard,
} from "../../src/collections/customize/CustomizeDirectory";
import ConnectorFeatured from "../../src/settings/directory/ConnectorFeatured";
import { ConnectorRows } from "../../src/settings/directory/ConnectorRows";
import {
  connectors,
  type CatalogueConnector,
} from "../../shared/connectors-catalogue";
const plugins: CatalogueCard[] = [
  {
    id: "docs@market",
    name: "Docs",
    description: "Write documents",
    byline: "from Market",
    icon: "file",
  },
  {
    id: "data@market",
    name: "Data",
    description: "Query data",
    byline: "from Market",
    icon: "database",
  },
];
import type { McpServerState } from "../../shared/settings-desktop-api";

async function mounted(
  element: ReactElement,
  run: (
    document: Document,
    render: (element: ReactElement) => Promise<void>,
  ) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const render = async (next: ReactElement) => {
    await act(async () => root.render(next));
  };
  try {
    await render(element);
    await run(document as unknown as Document, render);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const click = async (button: Element | null) => {
  assert.ok(button);
  await act(async () => (button as HTMLButtonElement).click());
};

test("Add, Add-and-try and View dispatch independent actions with the actual catalogue record", async () => {
  const entry = plugins[0];
  const called: unknown[] = [];
  await mounted(
    createElement(CatalogueCards, {
      entries: [entry],
      onOpen: (item) => called.push(["open", item]),
      onAdd: (item) => called.push(["add", item]),
      onAddAndTry: (item) => called.push(["try", item]),
    }),
    async (document) => {
      const plus = document.querySelector(".customize-catalogue-add")!;
      const tryButton = document.querySelector(".customize-catalogue-try")!;
      assert.equal(plus.getAttribute("aria-label"), `Add ${entry.name}`);
      assert.equal(
        tryButton.getAttribute("aria-label"),
        `Add ${entry.name} and try it in chat`,
      );
      await click(plus);
      await click(tryButton);
      await click(document.querySelector(".customize-card"));
      assert.deepEqual(called, [
        ["add", entry],
        ["try", entry],
        ["open", entry],
      ]);
    },
  );
});

test("installed, busy and permission states prevent duplicate or unavailable installation", async () => {
  const entry = plugins[0];
  let calls = 0;
  const base = {
    entries: [entry],
    onOpen() {},
    onAdd: () => {
      calls++;
    },
    onAddAndTry: () => {
      calls++;
    },
  };
  await mounted(
    createElement(CatalogueCards, { ...base, installed: new Set([entry.id]) }),
    async (document, render) => {
      const add = () =>
        document.querySelector<HTMLButtonElement>(".customize-catalogue-add")!;
      const tryButton = () =>
        document.querySelector<HTMLButtonElement>(".customize-catalogue-try")!;
      assert.equal(add().disabled, true);
      assert.equal(add().getAttribute("aria-label"), `Added: ${entry.name}`);
      assert.equal(tryButton(), null);
      await click(add());
      assert.equal(calls, 0);
      await render(createElement(CatalogueCards, { ...base, busy: entry.id }));
      assert.equal(add().getAttribute("aria-busy"), "true");
      assert.equal(add().disabled, true);
      assert.equal(tryButton().disabled, true);
      await render(
        createElement(CatalogueCards, { ...base, canAdd: () => false }),
      );
      assert.equal(add().disabled, true);
      assert.equal(tryButton().disabled, true);
      await click(add());
      await click(tryButton());
      assert.equal(calls, 0);
    },
  );
});

test("catalogue entries without an installation source expose truthful disabled actions", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(CatalogueCards, {
        entries: plugins.slice(0, 2),
        onOpen() {},
      }),
    ),
  );
  const actions = document.querySelectorAll(
    ".customize-catalogue-actions button",
  );
  assert.equal(actions.length, 4);
  for (const button of actions) {
    assert.equal(button.hasAttribute("disabled"), true);
    assert.equal(button.getAttribute("title"), "Not available in Claudex yet");
  }
});

const feature = (index: number): CatalogueConnector => ({
  ...connectors[index],
  featured: {
    title: `Published feature ${index}`,
    subtitle: connectors[index].description,
    curator: "Published curator",
  },
});

test("carousel is absent without real feature metadata and Settings keeps its original tile contract", () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(ConnectorFeatured, {
        entries: connectors,
        variant: "customize",
      }),
    ),
    "",
  );
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(ConnectorFeatured, { entries: [feature(0)] }),
    ),
  );
  assert.ok(document.querySelector(".connector-featured-tile"));
  assert.equal(document.querySelector(".customize-connector-featured"), null);
  assert.equal(
    document.querySelector("button")?.hasAttribute("disabled"),
    false,
  );
});

test("Customize carousel navigates actual slides, exposes active dots and opens the selected record", async () => {
  const entries = [feature(0), feature(1)];
  const opened: CatalogueConnector[] = [];
  await mounted(
    createElement(ConnectorFeatured, {
      entries,
      variant: "customize",
      onOpen: (entry) => opened.push(entry),
      featuredMembers: () => connectors.slice(0, 3),
      remoteIcons: false,
    }),
    async (document) => {
      const active = () =>
        document.querySelector(
          '.connector-featured-slide[aria-hidden="false"]',
        )!;
      assert.equal(
        active().getAttribute("aria-label"),
        entries[0].featured!.title,
      );
      assert.equal(
        active().querySelectorAll(
          ".customize-connector-featured-cluster > span",
        ).length,
        3,
      );
      assert.equal(document.querySelectorAll("img").length, 0);
      await click(document.querySelector('[aria-label="Next slide"]'));
      assert.equal(
        active().getAttribute("aria-label"),
        entries[1].featured!.title,
      );
      assert.equal(
        document
          .querySelector('.connector-featured-dots [aria-current="true"]')
          ?.getAttribute("aria-label"),
        `Show ${entries[1].featured!.title}`,
      );
      assert.equal(
        document
          .querySelector('.connector-featured-slide[aria-hidden="true"]')
          ?.hasAttribute("inert"),
        true,
      );
      await click(active().querySelector("button"));
      assert.deepEqual(opened, [entries[1]]);
      await click(document.querySelector('[aria-label="Previous slide"]'));
      assert.equal(
        active().getAttribute("aria-label"),
        entries[0].featured!.title,
      );
    },
  );
});

test("a standalone published feature never invents a cluster from matching labels", () => {
  const first = feature(0);
  const second = { ...feature(1), featured: first.featured };
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(ConnectorFeatured, {
        entries: [first, second],
        variant: "customize",
      }),
    ),
  );
  assert.equal(
    document.querySelectorAll(".customize-connector-featured-cluster > span")
      .length,
    2,
  );
  assert.equal(
    document.querySelectorAll(".connector-featured-slide").length,
    2,
  );
  for (const button of document.querySelectorAll(
    ".connector-featured-slide button",
  ))
    assert.ok(button.hasAttribute("disabled"));
});

test("reused connector rows show source verification and publisher while respecting real connection state", async () => {
  const entries = connectors.slice(0, 2);
  assert.equal(entries[0].id, "google-drive");
  const server: McpServerState = {
    name: "installed-google",
    connectorId: "google-drive",
    state: "ready",
    authStatus: "oAuth",
    tools: 0,
  };
  const opened: CatalogueConnector[] = [];
  await mounted(
    createElement(ConnectorRows, {
      entries,
      servers: [server],
      onOpen: (entry) => opened.push(entry),
      onConnect: () => {
        throw Error("permission must prevent this");
      },
      canConnect: () => false,
      remoteIcons: false,
    }),
    async (document) => {
      assert.equal(
        document.querySelectorAll('[aria-label="Verified"]').length,
        2,
      );
      assert.equal(
        document.querySelector(".connector-directory-row-text small")
          ?.textContent,
        entries[0].byline,
      );
      const actions = document.querySelectorAll<HTMLButtonElement>(
        ".connector-directory-row-action",
      );
      assert.equal(
        actions[0].getAttribute("aria-label"),
        `${entries[0].name} is connected`,
      );
      for (const button of actions) {
        assert.equal(button.disabled, true);
        await click(button);
      }
      await click(document.querySelector(".connector-directory-row-main"));
      assert.deepEqual(opened, [entries[0]]);
    },
  );
});
