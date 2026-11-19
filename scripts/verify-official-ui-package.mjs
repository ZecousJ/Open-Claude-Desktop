import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOfficialWebAssets } from "./official-web-assets.mjs";
import { verifyPackagedHostWindowManager } from "./official-ui-host-window-manager.mjs";

export function verifyOfficialUiPackage(root = process.cwd()) {
  const officialUi = path.join(root, "build", "official-ui");
  if (!fs.existsSync(officialUi)) return false;
  if (!fs.existsSync(path.join(officialUi, "ui", "index.html")) || !fs.existsSync(path.join(officialUi, "manifest.json")))
    throw new Error("Official UI assembly is incomplete.");
  verifyPackagedHostWindowManager(officialUi);
  verifyOfficialWebAssets(root);
  return true;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (verifyOfficialUiPackage()) console.log("Official UI package resources verified.");
}
