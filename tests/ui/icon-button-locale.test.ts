import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceLocale } from "../../shared/locales";
import { setLocale } from "../../src/i18n";
import { IconButton } from "../../src/ui/Controls";

// The document translator leaves the terminal panel alone, so an icon
// button there has to carry its translated name itself.
test("an icon button's accessible name follows the interface language", async () => {
  const html = () =>
    renderToStaticMarkup(
      createElement(IconButton, { label: "New terminal", children: "+" }),
    );
  assert.match(html(), /aria-label="New terminal"/);
  await setLocale("zh-CN");
  try {
    assert.match(html(), /aria-label="新建终端"/);
  } finally {
    await setLocale(sourceLocale);
  }
});
