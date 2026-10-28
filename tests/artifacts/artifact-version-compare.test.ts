import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionSwitcher } from "../../src/artifacts/ArtifactSwitcher";
import { VersionCompareDialog } from "../../src/artifacts/VersionCompareDialog";

const switcher = (onCompare?: (version: number) => void) =>
  renderToStaticMarkup(
    createElement(VersionSwitcher, {
      count: 3,
      shown: 3,
      open: true,
      onOpenChange() {},
      onChoose() {},
      onCompare,
    }),
  );

test("every earlier version can be compared with the current one, the latest cannot", () => {
  const html = switcher(() => {});
  assert.match(html, /aria-label="Compare version 1 with current"/);
  assert.match(html, /aria-label="Compare version 2 with current"/);
  assert.doesNotMatch(html, /aria-label="Compare version 3 with current"/);
  assert.match(html, /title="Compare with current"/);
  // The version rows themselves are unchanged.
  assert.match(html, /role="menuitemradio" aria-checked="true"/);
});

test("a file that cannot be compared offers no compare button", () => {
  assert.doesNotMatch(switcher(), /Compare version/);
});

const dialog = (before: string, after: string) =>
  renderToStaticMarkup(
    createElement(VersionCompareDialog, {
      name: "card.html",
      before,
      after,
      from: 1,
      to: 3,
      onClose() {},
    }),
  );

test("the compare dialog shows the changed lines between two versions", () => {
  const html = dialog(
    "<p>one</p>\n<p>two</p>\n<p>three</p>\n",
    "<p>one</p>\n<p>2</p>\n<p>three</p>\n<p>four</p>\n",
  );
  assert.match(html, /Compare with current/);
  assert.match(html, /Changes from version 1 to the current version, 3\./);
  assert.match(html, /<span class="changes-add">\+2<\/span>/);
  assert.match(html, /<span class="changes-del">−1<\/span>/);
  assert.match(html, /data-kind="del"/);
  assert.match(html, /data-kind="add"/);
});

test("texts with no differing line, or too many, say so", () => {
  assert.match(dialog("a\nb\n", "a\r\nb\r\n"), /Line endings only/);
  const many = (prefix: string) =>
    Array.from({ length: 1200 }, (_, i) => `${prefix}${i}`).join("\n");
  assert.match(dialog(many("a"), many("b")), /Too large to compare/);
});
