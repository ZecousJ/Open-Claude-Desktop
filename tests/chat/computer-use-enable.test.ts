import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionRow } from "../../src/computer-use/PermissionRow";

const row = (
  status: "granted" | "denied" | "not-determined" | "restart-required",
) =>
  renderToStaticMarkup(
    createElement(PermissionRow, {
      kind: "screen",
      label: "Screen recording",
      status,
      attention: true,
      onError() {},
    }),
  );

test("a permission shows the original's status and Open System Settings until granted", () => {
  assert.match(row("granted"), /Granted/);
  assert.doesNotMatch(row("granted"), /Open System Settings/);
  assert.match(row("denied"), /data-variant="danger"[^>]*>Denied/);
  assert.match(row("denied"), /Open System Settings/);
  assert.match(row("not-determined"), /Not requested/);
  assert.match(row("restart-required"), /Restart/);
});
