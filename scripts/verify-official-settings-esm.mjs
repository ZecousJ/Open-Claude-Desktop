/** Link the final assembled assets without evaluating any module.
 * Run: node --experimental-vm-modules scripts/verify-official-settings-esm.mjs [official-ui-root]
 * Intended after assembly/integrity verification, never as an application runtime dependency.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const settingsEsmEntries = Object.freeze([
  "cc011544b-Pr8E2gr7.js",
  "cf0e8a0d3-DUFBw2XT.js",
  "shared-m-4-CbJwwS_m.js",
  "c08f249ae-5qhemGT7.js",
  "c5e558aae-38ebsbqD.js",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function verifyOfficialSettingsEsm(directory) {
  if (typeof vm.SourceTextModule !== "function")
    throw Error("Run this verifier with --experimental-vm-modules.");
  const base = fs.realpathSync(directory);
  const root = fs.realpathSync(path.join(base, "ui/assets/v1"));
  const manifestSha256 = sha(fs.readFileSync(path.join(base, "manifest.json")));
  const results = [];
  for (const entry of settingsEsmEntries) {
    const cache = new Map();
    function read(location) {
      const real = fs.realpathSync(location);
      if (!real.startsWith(root + path.sep)) throw Error("ESM dependency escapes asset directory.");
      if (cache.has(real)) return cache.get(real);
      const module = new vm.SourceTextModule(fs.readFileSync(real, "utf8"), {identifier: real});
      cache.set(real, module);
      return module;
    }
    const location = path.join(root, entry);
    await read(location).link((specifier, referring) => {
      if (!specifier.startsWith("./") && !specifier.startsWith("../"))
        throw Error("Non-relative ESM dependency is not allowed in this pinned asset graph.");
      return read(path.resolve(path.dirname(referring.identifier), specifier));
    });
    if (entry === settingsEsmEntries[0]) {
      // Skills page is a separate lazy entry, not a static dependency of this modal.
      for (const changed of settingsEsmEntries.slice(1, 4))
        if (!cache.has(fs.realpathSync(path.join(root, changed))))
          throw Error("Settings modal graph omitted pinned installed-library dependency: " + changed);
    }
    results.push({entry, modules: cache.size, sha256: sha(fs.readFileSync(location))});
  }
  return {manifestSha256, mode: "static-link-only", evaluated: false, results};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyOfficialSettingsEsm(process.argv[2] ?? "build/official-ui"), null, 2));
  } catch (error) {
    console.error("Official Settings ESM verification failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
