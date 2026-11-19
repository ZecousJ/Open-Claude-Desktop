import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const addon = "quick-access.node";
const releaseDigest =
  "1fe66a83f89f228429fd7a7b98abcde62ce69346d89e2d4c75702e747d9c2df1";

export function verifyOfficialQuickAccessAddon(file) {
  const bytes = fs.readFileSync(file);
  if (createHash("sha256").update(bytes).digest("hex") !== releaseDigest)
    throw Error(
      "The Quick Access addon differs from the pinned Claude Desktop 4.4212.0 release.",
    );
}

export function installOfficialQuickAccessAddon(out, file) {
  if (!file) return;
  verifyOfficialQuickAccessAddon(file);
  fs.copyFileSync(file, path.join(out, addon));
}
