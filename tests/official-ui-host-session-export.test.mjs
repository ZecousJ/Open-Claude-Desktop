import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  desktopSessionExportAsset,
  deriveOfficialUiHostSessionExportModule,
  deriveOfficialUiSessionTransferPreload,
  hostSessionExportTarget,
} from "../scripts/official-ui-host-session-export.mjs";

const source = process.env.CLAUDEX_OFFICIAL_UI_SOURCE ?? ".restore/archive-extracted/claude-frontend-4.4212.0";

test("the original desktop export dialog mounts on the original settings action", () => {
  const desktop = fs.readFileSync(path.join(source, desktopSessionExportAsset), "utf8");
  const cloud = fs.readFileSync(path.join(source, "src/cloud/assets/v1", hostSessionExportTarget), "utf8");
  const derived = deriveOfficialUiHostSessionExportModule(hostSessionExportTarget, cloud, desktop);
  assert.ok(!cloud.includes("T?.previewSessionExport?.(N)"));
  assert.ok(derived.includes("T?.previewSessionExport?.(N)"));
  assert.ok(derived.includes("u && s(__claudexSessionExport"));
  assert.ok(derived.includes('"data-testid": "session-export-run"'));
  assert.ok(derived.includes('"data-testid": "import-zip-choose-file"'));
});

test("the localhost transfer bridge preserves the original app bridge and does not expose remote auth", () => {
  const preload = fs.readFileSync(path.join(source, "electron/official-preload.cjs"), "utf8");
  const derived = deriveOfficialUiSessionTransferPreload(preload);
  const body = derived.match(/\(Se = (\(e\) => \{[\s\S]*?\n      \})\),/)[1];
  const methods = {
    previewSessionExport() {},
    confirmImportedSessionResume() {},
    startAuth() {},
  };
  const expose = (hostname, top, originalApp) => {
    const target = {};
    vm.runInNewContext(`(${body})(target)`, {
      target, xe: methods, window: { location: { hostname } },
      u: () => top, d: () => originalApp,
    });
    return target["claude.settings"]?.ClaudeAiImport;
  };
  const local = expose("localhost", true, false);
  assert.equal(local.previewSessionExport, methods.previewSessionExport);
  assert.equal(local.confirmImportedSessionResume, methods.confirmImportedSessionResume);
  assert.equal(local.startAuth, undefined);
  assert.equal(expose("localhost", false, false), undefined);
  assert.equal(expose("claude.ai", true, false), undefined);
  assert.equal(expose("localhost", true, true), methods);
});
