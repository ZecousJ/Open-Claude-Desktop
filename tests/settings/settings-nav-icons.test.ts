import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { navGroups } from "../../src/settings/nav";

const ids = [
  "account",
  "privacy",
  "billing",
  "usage",
  "capabilities",
  "memory",
  "design",
  "code",
  "skills",
  "connectors",
  "plugins",
  "system",
  "extensions",
  "developer",
  "import",
];

test("settings pages draw the icon-font glyph the live navigation names", () => {
  const glyph = (id: string) => {
    const tab = navGroups
      .flatMap((group) => group.tabs)
      .find((t) => t.id === id);
    assert.ok(tab, id);
    return renderToStaticMarkup(createElement(tab.Icon, { size: 20 })).match(
      /data-icon="(\w+)"/,
    )?.[1];
  };
  assert.deepEqual(Object.fromEntries(ids.map((id) => [id, glyph(id)])), {
    account: "UserCircle",
    privacy: "LockShield",
    billing: "CreditCard",
    usage: "UsageGaugeMiddle",
    capabilities: "Tool",
    memory: "Memory",
    design: "Palette",
    code: "Code",
    skills: "Scroll",
    connectors: "Connectors",
    plugins: "Plugin",
    system: "Computer",
    extensions: "Plugin",
    developer: "Wrench",
    import: "Download",
  });
});
