import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComputerUseSettingsStore } from "../../electron/computer-use/settings-store";
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

test("Computer Use starts enabled in background mode and remembers a local opt-out", (t) => {
  const profile = mkdtempSync(path.join(tmpdir(), "claudex-computer-use-default-"));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const settings = new ComputerUseSettingsStore(profile);
  assert.equal(settings.get().enabled, true);
  assert.equal(settings.get().mode, "background");
  settings.save({ enabled: false });
  assert.equal(new ComputerUseSettingsStore(profile).get().enabled, false);
});
