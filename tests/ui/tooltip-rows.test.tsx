import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipRows } from "../../src/ui/Tooltip";

test("a multi-line tooltip row carries its own keys, written for the platform", () => {
  const rows = [
    { label: "Send", keys: ["↵"] },
    { label: "Queue for later", keys: ["mod", "↵"] },
  ];
  const mac = renderToStaticMarkup(
    createElement(TooltipRows, { platform: "darwin", rows }),
  );
  assert.equal((mac.match(/chrome-tooltip-row"/g) ?? []).length, 2);
  assert.match(mac, /Send<span class="chrome-tooltip-keys"><kbd>↵<\/kbd>/);
  assert.match(mac, /<kbd>⌘<\/kbd><kbd>↵<\/kbd>/);
  const other = renderToStaticMarkup(
    createElement(TooltipRows, { platform: "win32", rows }),
  );
  assert.match(other, /<kbd>Ctrl\+↵<\/kbd>/);
});
