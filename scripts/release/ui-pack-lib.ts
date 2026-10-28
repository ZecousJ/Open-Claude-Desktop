/**
 * Builds a signed desktop interface pack from a `dist/` folder
 * (docs/releasing.md): `manifest.json` (version, bridge level,
 * every file's SHA-256), `manifest.sig` (ed25519, base64) and the files
 * under `files/`. electron/ui-pack/verify.ts checks exactly this.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { UiManifest } from "../../shared/ui-pack";

const listFiles = (dir: string, base = dir): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(file, base);
    return [path.relative(base, file).split(path.sep).join("/")];
  });

/** Files a pack never carries (maps, OS litter). */
const skipped = (name: string) =>
  name.endsWith(".map") ||
  name.split("/").some((part) => part === ".DS_Store" || part.startsWith("._"));

export async function buildUiPack(options: {
  dist: string;
  version: string;
  bridge: number;
  /** PEM (PKCS#8) ed25519 private key. */
  privateKey: string;
}): Promise<{ zip: Buffer; manifest: UiManifest }> {
  const names = listFiles(options.dist)
    .filter((name) => !skipped(name))
    .sort();
  if (!names.includes("index.html"))
    throw new Error(`${options.dist} has no index.html; build it first.`);
  const files: Record<string, string> = {};
  const archive = new JSZip();
  for (const name of names) {
    const data = fs.readFileSync(path.join(options.dist, ...name.split("/")));
    files[name] = crypto.createHash("sha256").update(data).digest("hex");
    archive.file(`files/${name}`, data);
  }
  const manifest: UiManifest = {
    format: 1,
    version: options.version,
    bridge: options.bridge,
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1));
  const signature = crypto
    .sign(null, manifestBytes, crypto.createPrivateKey(options.privateKey))
    .toString("base64");
  archive.file("manifest.json", manifestBytes);
  archive.file("manifest.sig", signature);
  const zip = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return { zip, manifest };
}
