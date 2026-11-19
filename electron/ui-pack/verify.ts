/**
 * Checks a downloaded interface pack (docs/desktop-ui-hot-update.md): a zip
 * with `manifest.json`, its ed25519 signature `manifest.sig` (base64) and
 * the files the manifest lists, each with its SHA-256. Only a pack signed by
 * the release key (kept off every server) is ever loaded: the window's code
 * can reach `window.desktop`, which reads files and runs commands.
 */
import crypto from "node:crypto";
import JSZip from "jszip";
import { parseUiManifest, type UiManifest } from "../../shared/ui-pack";

/** The release key's public half (SPKI, DER, base64). */
export const uiPackPublicKey =
  "MCowBQYDK2VwAyEAL5Gm2BZwViQkVWmZ4ie4w4x2Z5k+j6FSS3KfulbHdX8=";

/** The largest pack accepted, unpacked. */
export const maxPackBytes = 200 * 1024 * 1024;

export interface VerifiedPack {
  manifest: UiManifest;
  files: Map<string, Buffer>;
}

const sha256 = (data: Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");

/** Verifies a manifest's signature with `publicKey` (base64 SPKI DER). */
export function manifestSigned(
  manifest: Buffer,
  signatureBase64: string,
  publicKey = uiPackPublicKey,
) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      manifest,
      key,
      Buffer.from(signatureBase64.trim(), "base64"),
    );
  } catch {
    return false;
  }
}

/** Unpacks and checks a pack; throws with the reason when anything is off. */
export async function verifyPack(
  zip: Buffer,
  options: { publicKey?: string; expectVersion?: string; maxBytes?: number } = {},
): Promise<VerifiedPack> {
  const archive = await JSZip.loadAsync(zip);
  const manifestFile = archive.file("manifest.json");
  const signatureFile = archive.file("manifest.sig");
  if (!manifestFile || !signatureFile)
    throw new Error("The interface pack is not signed.");
  const manifestBytes = await manifestFile.async("nodebuffer");
  const signature = await signatureFile.async("string");
  if (!manifestSigned(manifestBytes, signature, options.publicKey))
    throw new Error("The interface pack's signature is not valid.");
  const manifest = parseUiManifest(manifestBytes.toString("utf8"));
  if (options.expectVersion && manifest.version !== options.expectVersion)
    throw new Error(
      `The interface pack is ${manifest.version}, not ${options.expectVersion}.`,
    );
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const [name, hash] of Object.entries(manifest.files)) {
    const entry = archive.file(`files/${name}`);
    if (!entry) throw new Error(`The interface pack is missing ${name}.`);
    const data = await entry.async("nodebuffer");
    total += data.length;
    if (total > (options.maxBytes ?? maxPackBytes))
      throw new Error("The interface pack is too large.");
    if (sha256(data) !== hash)
      throw new Error(
        `The interface pack's ${name} does not match its manifest.`,
      );
    files.set(name, data);
  }
  // Nothing the manifest does not list rides along.
  for (const name of Object.keys(archive.files))
    if (
      !archive.files[name].dir &&
      name !== "manifest.json" &&
      name !== "manifest.sig" &&
      !(name.startsWith("files/") && files.has(name.slice(6)))
    )
      throw new Error(`The interface pack has an unlisted file: ${name}`);
  return { manifest, files };
}
