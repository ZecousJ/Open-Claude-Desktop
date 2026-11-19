import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const legacyQuoteIdentityRevision = "original-legacy-quote-identity-v1";
export const legacyQuoteIdentityTarget = "30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
export const legacyQuoteIdentityInputSha256 = "8b25253c958671c9a455199de55f3b3fe347156bd574438134c4aa0cbe05f9f9";
const before = 'return At(e) || /^msg_[A-Za-z0-9_]{1,252}$/.test(e);';
const after = 'return At(e) || /^msg_[A-Za-z0-9_]{1,252}$/.test(e) || (e.length <= 256 && /^[A-Za-z0-9_.:-]{1,245}:(?:user|assistant)$/.test(e));';
const sha = value => createHash("sha256").update(value).digest("hex");
export function deriveOfficialLegacyQuoteIdentityModule(file, source) {
  if (file !== legacyQuoteIdentityTarget) return source;
  if (typeof source !== "string" || sha(source) !== legacyQuoteIdentityInputSha256 || source.split(before).length !== 2)
    throw Error("Pinned legacy quote identity input mismatch");
  return source.replace(before, after);
}
function manifestFor(outputSha256) {
  return {revision: legacyQuoteIdentityRevision, modules: [{file: legacyQuoteIdentityTarget, inputSha256: legacyQuoteIdentityInputSha256, outputSha256}]};
}
export function applyOfficialLegacyQuoteIdentity(directory) {
  const resolved = path.resolve(directory);
  if (fs.realpathSync(resolved) !== resolved || resolved.split(path.sep).includes(".restore")) throw Error("Legacy quote derivation requires unlinked assembly output");
  const file = path.join(resolved, legacyQuoteIdentityTarget);
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw Error("Linked legacy quote identity input");
  const output = deriveOfficialLegacyQuoteIdentityModule(legacyQuoteIdentityTarget, fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, output);
  return manifestFor(sha(output));
}
export function verifyOfficialLegacyQuoteIdentityManifest(manifest, files) {
  const rows = files.filter(row => row.path === "assets/v1/" + legacyQuoteIdentityTarget);
  if (rows.length !== 1 || JSON.stringify(manifest) !== JSON.stringify(manifestFor(rows[0].sha256))) throw Error("Legacy quote identity manifest mismatch");
}
