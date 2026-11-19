import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyPackagedOfficialResources } from "../scripts/official-ui-packaged-resources.mjs";

test("packaged native and preview resources reject altered or extra files", (t) => {
  const root = process.cwd();
  const extracted = process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? path.join(root, ".restore/archive-extracted");
  const rows = JSON.parse(fs.readFileSync(path.join(extracted, "source-files.json"), "utf8"));
  const original = new Map(rows.map((row) => [row.path, row]));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-packaged-resources-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const output = path.join(temp, "build/official-ui"), current = path.join(root, "build/official-ui");
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(current, "manifest.json"), path.join(output, "manifest.json"));
  for (const directory of ["host", "data", "main-window", "quick-window"]) fs.cpSync(path.join(current, directory), path.join(output, directory), { recursive: true });
  fs.mkdirSync(path.join(output, "ui"));
  for (const entry of fs.readdirSync(path.join(current, "ui"), { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(current, "ui", entry.name), path.join(output, "ui", entry.name));
  }
  fs.cpSync(path.join(current, "ui/development"), path.join(output, "ui/development"), { recursive: true });
  for (const name of ["assets", "i18n", "images"]) fs.mkdirSync(path.join(output, "ui", name));
  fs.cpSync(path.join(root, "build/official-usercontent"), path.join(temp, "build/official-usercontent"), { recursive: true });
  fs.mkdirSync(path.join(temp, "electron/official-ui"), { recursive: true });
  fs.copyFileSync(path.join(root, "electron/official-ui/page-shim.cjs"), path.join(temp, "electron/official-ui/page-shim.cjs"));
  fs.mkdirSync(path.join(temp, "electron/official-ui/assets"));
  fs.copyFileSync(path.join(root, "electron/official-ui/assets/mcp_apps.html"), path.join(temp, "electron/official-ui/assets/mcp_apps.html"));
  const verify = () => verifyPackagedOfficialResources(temp, original, { extracted });
  assert.doesNotThrow(verify);
  for (const relative of [
    "build/official-ui/data/bootstrap-defaults.json",
    "build/official-ui/data/native-ipc-contract.json",
    "build/official-ui/host/official-preload.cjs",
    "build/official-ui/host/main-window-preload.cjs",
    "build/official-ui/host/claudex-shim.cjs",
    "build/official-ui/main-window/index.html",
    "build/official-ui/main-window/view.html",
    "build/official-ui/ui/app.js",
    "build/official-ui/ui/development/native-host.js",
    "build/official-usercontent/index.html",
    "build/official-usercontent/mcp_apps.html",
  ]) {
    const file = path.join(temp, relative), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, "synthetic-tamper");
    assert.throws(verify, undefined, relative);
    fs.writeFileSync(file, bytes);
  }
  const extra = path.join(temp, "build/official-usercontent/unexpected.js");
  fs.writeFileSync(extra, "synthetic");
  assert.throws(verify, /resource set mismatch/);
  fs.unlinkSync(extra);
  assert.doesNotThrow(verify);
});
