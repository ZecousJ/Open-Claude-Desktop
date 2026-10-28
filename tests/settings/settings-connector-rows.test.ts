import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import { ConnectorRows } from "../../src/settings/directory/ConnectorRows";
import { CustomizeConnectorDetail } from "../../src/settings/directory/CustomizeConnectorDetail";
import { relatedConnectors } from "../../src/settings/directory/connector-detail-model";
import {
  connectors,
  type CatalogueConnector,
} from "../../shared/connectors-catalogue";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { starterConnectorId } from "../../shared/starter-integrations";
import { routineDom } from "../support/routine-dom";

const css = postcss.parse(
  readFileSync(
    new URL("../../src/settings/directory/connector-rows.css", import.meta.url),
    "utf8",
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
// Real rendered selectors/declarations; no browser-paint or fixed text-metric claim.
function style(element: Element, after = false, width = 912) {
  const result = new Map<string, { priority: number; value: string }>();
  css.walkRules((rule) => {
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
      if (parent.type === "atrule" && parent.name === "media") {
        const max = parent.params.match(/max-width:\s*([\d.]+)px/);
        if (max && width > +max[1]) return;
      }
    }
    for (const selector of postcss.list.comma(rule.selector)) {
      if (selector.includes("::after") !== after) continue;
      const target = selector.replace("::after", "");
      let matches = false;
      try {
        matches = element.matches(target);
      } catch {}
      if (!matches) continue;
      const priority = Math.max(...selectors(selector).map(rank));
      rule.walkDecls((decl) => {
        if ((result.get(decl.prop)?.priority ?? -1) <= priority)
          result.set(decl.prop, { priority, value: decl.value });
      });
    }
  });
  return Object.fromEntries(
    [...result].map(([key, value]) => [key, value.value]),
  );
}
const entries = connectors.slice(0, 4);

test("Discover opts into 88px outlined cards with source body, icon and text geometry", async () => {
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(ConnectorRows, {
        entries: [entries[0]],
        variant: "discover",
        remoteIcons: false,
      }),
    );
    const find = (selector: string) => env.document.querySelector(selector)!;
    const grid = style(find("ul")),
      card = style(find("li"));
    assert.equal(find("ul").getAttribute("data-variant"), "discover");
    assert.equal(
      grid["grid-template-columns"],
      "repeat(auto-fill, minmax(min(340px, 100%), 1fr))",
    );
    assert.equal(grid.gap, "12px");
    assert.equal(grid.margin, "0");
    assert.equal(card["min-height"], "88px");
    assert.equal(
      card.height,
      undefined,
      "two-line descriptions may grow the card",
    );
    assert.equal(card.padding, "14px");
    assert.equal(card.border, "0");
    assert.equal(card["border-radius"], "11px");
    assert.equal(
      style(find("li"), true)["box-shadow"],
      "inset 0 0 0 1px rgb(255 255 255 / 10%)",
    );
    assert.equal(style(find("li"), true)["pointer-events"], "none");
    assert.equal(style(find(".connector-directory-row-main")).gap, "12px");
    assert.equal(style(find(".connector-logo")).background, "#1a1a19");
    assert.equal((find(".connector-logo") as HTMLElement).style.width, "48px");
    assert.equal(style(find(".connector-directory-row-text")).gap, "4px");
    assert.equal(
      style(find(".connector-directory-row-description"))["margin-top"],
      "-1px",
    );
    assert.equal(
      style(find(".connector-directory-row-description"))["-webkit-line-clamp"],
      "2",
    );
    assert.equal(style(find("small"))["font-size"], "13px");
    assert.equal(style(find("small"))["line-height"], "16px");
    env.document.documentElement.dataset.theme = "light";
    assert.equal(
      style(find("li"), true)["box-shadow"],
      "inset 0 0 0 1px rgb(11 11 11 / 10%)",
    );
  } finally {
    await env.clean();
  }
});

test("actual connector detail renders only declared Related records with the source default cards", async () => {
  const env = await routineDom({}, { jsdom: true });
  const entry = {
    ...entries[0],
    relatedIds: [entries[1].id, "missing", entries[1].id],
  };
  const related = relatedConnectors(entry, entries);
  const opened: CatalogueConnector[] = [],
    connected: CatalogueConnector[] = [];
  const props = {
    entry,
    editable: false,
    onBack() {},
    onConnect: async () => {},
    onSet() {},
    onError(error: unknown) {
      throw error;
    },
    remoteIcons: false,
    onOpenRelated: (value: CatalogueConnector) => {
      opened.push(value);
    },
    onConnectRelated: (value: CatalogueConnector) => {
      connected.push(value);
    },
  };
  try {
    await env.render(h(CustomizeConnectorDetail, { ...props, related }));
    const section = env.document.querySelector(".connector-published-related")!;
    assert.equal(
      section.querySelector("h3")!.textContent,
      "Related connectors",
    );
    assert.equal(section.querySelectorAll("li").length, 1);
    const grid = section.querySelector("ul")!,
      card = section.querySelector("li")!;
    assert.equal(grid.getAttribute("data-variant"), "related");
    assert.equal(style(grid).margin, "0");
    assert.equal(style(grid).gap, "12px");
    assert.equal(style(card)["min-height"], "88px");
    assert.equal(style(card).padding, "14px");
    assert.equal(style(card)["border-radius"], "11px");
    assert.equal(
      style(card, true)["box-shadow"],
      "inset 0 0 0 1px rgb(255 255 255 / 10%)",
    );
    assert.equal(
      (section.querySelector(".connector-logo") as HTMLElement).style.width,
      "48px",
    );
    assert.equal(style(section.querySelector("small")!)["font-size"], "13px");
    const link = section.querySelector<HTMLAnchorElement>("a")!;
    await act(async () => link.focus());
    assert.equal(env.document.activeElement, link);
    assert.equal(style(link).outline, "none");
    assert.ok(style(card, true)["box-shadow"].includes("var(--focus-accent)"));
    assert.ok(
      style(card, true)["box-shadow"].includes("var(--connector-card-page)"),
    );
    await env.event(section.querySelector("a")!, "click", { button: 0 });
    await env.event(
      section.querySelector(".connector-directory-row-action")!,
      "click",
    );
    assert.deepEqual(opened, related);
    assert.deepEqual(connected, related);
    assert.ok(env.document.querySelector(".connector-published-metadata"));
    await env.render(
      h(CustomizeConnectorDetail, {
        ...props,
        related: relatedConnectors({ ...entry, relatedIds: [] }, entries),
      }),
    );
    assert.equal(
      env.document.querySelector(".connector-published-related"),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("Discover keeps the actual logo/provenance data and honors remote-icon blocking", async () => {
  const env = await routineDom({}, { jsdom: true });
  const entry: CatalogueConnector = {
    ...entries[0],
    name: "Synthetic connector",
    type: "custom",
    iconUrl: "https://fixture.invalid/published-logo.png",
    byline: "by Synthetic publisher",
  };
  try {
    await env.render(
      h(ConnectorRows, { entries: [entry], variant: "discover" }),
    );
    const image = env.document.querySelector<HTMLImageElement>(
      ".connector-logo img",
    )!;
    assert.equal(image.getAttribute("src"), entry.iconUrl);
    assert.equal(image.style.width, "34px");
    assert.equal(image.style.height, "34px");
    assert.equal(
      env.document.querySelector("small")!.textContent,
      entry.byline,
    );
    assert.equal(env.document.querySelector('[aria-label="Verified"]'), null);
    assert.ok(env.document.querySelector('[aria-label="Custom"]'));
    await env.render(
      h(ConnectorRows, {
        entries: [entry],
        variant: "discover",
        remoteIcons: false,
      }),
    );
    assert.equal(env.document.querySelector("img"), null);
    assert.equal(env.document.querySelectorAll("li").length, 1);
  } finally {
    await env.clean();
  }
});

test("Discover connect and re-authorize buttons preserve the actual catalogue record and runtime identity", async () => {
  const env = await routineDom({}, { jsdom: true });
  const selected: CatalogueConnector[] = [];
  const server: McpServerState = {
    name: "runtime-owned",
    connectorId: starterConnectorId(entries[1].id),
    state: "ready",
    authStatus: "notLoggedIn",
    tools: 0,
  };
  try {
    await env.render(
      h(ConnectorRows, {
        entries: entries.slice(0, 2),
        variant: "discover",
        servers: [server],
        remoteIcons: false,
        onConnect: (entry) => selected.push(entry),
      }),
    );
    const buttons = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        ".connector-directory-row-action",
      ),
    ];
    assert.equal(
      buttons[0].getAttribute("aria-label"),
      `Connect ${entries[0].name} to Claudex`,
    );
    assert.equal(
      buttons[1].getAttribute("aria-label"),
      `Re-authorize ${entries[1].name}`,
    );
    assert.equal(style(buttons[0]).width, "28px");
    assert.equal(style(buttons[0]).height, "28px");
    await env.event(buttons[0], "click");
    await env.event(buttons[1], "click");
    assert.deepEqual(selected, entries.slice(0, 2));
  } finally {
    await env.clean();
  }
});

test("connected, busy and unavailable rows retain disabled actions without fabricating success", async () => {
  const env = await routineDom({}, { jsdom: true });
  let calls = 0;
  const server: McpServerState = {
    name: "runtime-connected",
    connectorId: starterConnectorId(entries[0].id),
    state: "ready",
    authStatus: "oAuth",
    tools: 0,
  };
  try {
    await env.render(
      h(ConnectorRows, {
        entries: entries.slice(0, 3),
        variant: "discover",
        servers: [server],
        remoteIcons: false,
        busy: entries[1].id,
        canConnect: (entry) => entry !== entries[2],
        onConnect: () => {
          calls++;
        },
      }),
    );
    const buttons = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        ".connector-directory-row-action",
      ),
    ];
    assert.equal(
      buttons[0].getAttribute("aria-label"),
      `${entries[0].name} is connected`,
    );
    assert.ok(buttons[1].querySelector(".spin"));
    for (const button of buttons) {
      assert.equal(button.disabled, true);
      await env.event(button, "click");
    }
    assert.equal(calls, 0);
  } finally {
    await env.clean();
  }
});

test("card navigation preserves native modified links and custom opening remains independent of connect", async () => {
  const env = await routineDom({}, { jsdom: true });
  const opened: CatalogueConnector[] = [],
    connected: CatalogueConnector[] = [];
  try {
    await env.render(
      h(ConnectorRows, {
        entries: [entries[0]],
        variant: "discover",
        remoteIcons: false,
        onOpen: (entry) => opened.push(entry),
        onConnect: (entry) => connected.push(entry),
      }),
    );
    const link = env.document.querySelector("a")!;
    const overlay = style(link, true);
    assert.equal(overlay.position, "absolute");
    assert.equal(overlay.inset, "0");
    assert.equal(overlay["border-radius"], "11px");
    const action = env.document.querySelector(
      ".connector-directory-row-action",
    )!;
    assert.equal(style(action).position, "relative");
    assert.equal(style(action)["z-index"], "1");
    const modified = await env.event(link, "click", {
      ctrlKey: true,
      button: 0,
    });
    assert.equal(modified.defaultPrevented, false);
    assert.deepEqual(opened, []);
    const ordinary = await env.event(link, "click", { button: 0 });
    assert.equal(ordinary.defaultPrevented, true);
    assert.deepEqual(opened, [entries[0]]);
    assert.deepEqual(connected, []);
    await env.event(action, "click");
    assert.deepEqual(
      opened,
      [entries[0]],
      "the overlaid connect action does not open details",
    );
    assert.deepEqual(connected, [entries[0]]);
    assert.ok(link.getAttribute("href")!.includes(entries[0].id));
  } finally {
    await env.clean();
  }
});
