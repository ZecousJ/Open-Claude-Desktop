import assert from "node:assert/strict";
import { test } from "node:test";
import { useElectronShim } from "./runner/runner-core-support.test";

useElectronShim();
const { NativeHost } = await import("../electron/official-ui/native/host");

test("official folder selections belong to a live window and activation", () => {
  const window = {};
  const other = {};
  let current = true;
  let identity = {};
  let owner = "one";
  const host: any = Object.create(NativeHost.prototype);
  host.folderSelections = new WeakMap();
  host.selectionEpoch = new WeakMap();
  host.currentWindow = (candidate: object) => current && candidate === window;
  host.ctx = { account: () => ({ id: owner }), sessionIdentity: () => identity };
  host.recordFolderSelection(window, ["/chosen"]);
  host.recordFolderSelection(window, ["/settings-choice"], "settings");
  assert.equal(host.hasFolderSelection(window, "/settings-choice"), false);
  assert.equal(host.hasFolderSelection(window, "/settings-choice", "settings"), true);
  assert.equal(host.hasFolderSelection(window, "/chosen", "settings"), false);
  host.selectionEpoch.set(window, 1);
  assert.equal(host.hasFolderSelection(window, "/settings-choice", "settings"), false);
  assert.equal(host.hasFolderSelection(window, "/chosen"), true);
  assert.equal(host.hasFolderSelection(window, "/chosen/child"), false);
  assert.equal(host.hasFolderSelection(other, "/chosen"), false);
  identity = {};
  assert.equal(host.hasFolderSelection(window, "/chosen"), false);
  host.recordFolderSelection(window, ["/chosen"]);
  owner = "two";
  assert.equal(host.hasFolderSelection(window, "/chosen"), false);
  owner = "one";
  current = false;
  assert.equal(host.hasFolderSelection(window, "/chosen"), false);
  assert.throws(() => host.recordFolderSelection(window, ["/chosen"]), /retired/);
});
