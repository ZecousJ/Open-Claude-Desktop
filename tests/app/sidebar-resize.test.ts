import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fitSidebarWidth,
  defaultSidebarWidth,
} from "../../shared/sidebar-layout";
import { Store } from "../../electron/store/store";

test("sidebar drag clamps to a useful rail and leaves room for the workspace", () => {
  assert.equal(defaultSidebarWidth, 288);
  assert.equal(fitSidebarWidth(350, 1600), 350);
  assert.equal(fitSidebarWidth(120, 1600), 200);
  assert.equal(fitSidebarWidth(900, 1600), 420);
  assert.equal(fitSidebarWidth(460, 840), 420);
  assert.equal(fitSidebarWidth(460, 700), 280);
});

test("stored sidebar width is per profile and old data defaults without modifying history", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sidebar-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sidebar-b-"));
  try {
    const first = new Store(a),
      other = new Store(b);
    first.settings.sidebarWidth = 346;
    first.flush();
    assert.equal(new Store(a).settings.sidebarWidth, 346);
    assert.equal(other.settings.sidebarWidth, 288);
    fs.writeFileSync(
      path.join(a, "settings.json"),
      JSON.stringify({ theme: "dark", sidebarWidth: 999 }),
    );
    assert.equal(new Store(a).settings.sidebarWidth, 288);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
