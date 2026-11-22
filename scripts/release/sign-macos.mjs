import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function signMacRelease({ electronPlatformName, appOutDir, packager, targets }) {
  if (electronPlatformName !== "darwin") return;
  const identity = process.env.CLAUDEX_MAC_SIGNING_IDENTITY;
  if (!identity) {
    if (targets.some(target => target.name === "dmg"))
      throw Error("Set CLAUDEX_MAC_SIGNING_IDENTITY to the Claudex macOS release certificate before building a DMG.");
    return;
  }

  const app = path.join(appOutDir, packager.appInfo.productFilename + ".app");
  const contents = path.join(app, "Contents");
  const timestamp = identity.startsWith("Developer ID Application:") ? "--timestamp" : "--timestamp=none";
  const codesign = (args, file) => execFileSync("/usr/bin/codesign", [...args, file], { stdio: "inherit" });
  const sign = (file, ...options) => codesign(
    ["--force", "--sign", identity, "--preserve-metadata=entitlements,flags", timestamp, ...options],
    file,
  );

  const driver = path.join(contents, "Resources", "computer-use");
  const manifestPath = path.join(driver, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const executable = path.join(driver, manifest.executable);
    const helper = path.resolve(executable, "../../..");
    sign(helper, "--identifier", "com.ifuryst.opencomputeruse");
    for (const name of Object.keys(manifest.installedFiles))
      manifest.installedFiles[name] = createHash("sha256").update(fs.readFileSync(path.join(driver, name))).digest("hex");
    manifest.executableSha256 = manifest.installedFiles[manifest.executable];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    sign(app, "--identifier", packager.appInfo.id);
  }
  codesign(["--verify", "--deep", "--strict"], app);
}
