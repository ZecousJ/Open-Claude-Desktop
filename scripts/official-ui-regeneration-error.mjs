/** Preserve the original regeneration notice after a settled snapshot retires its stub. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const regenerationErrorRevision = "original-regeneration-error-v1";
export const regenerationErrorTarget =
  "30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
export const regenerationErrorInput =
  "afc1d3758e53500d00ddc331375621b68bc6c5f100bffa2afbb1a1dd9294a830";
export const regenerationErrorBefore = `          o.droppedRetry)
        ) {
          an({
            id: o.droppedRetry.id,`;
export const regenerationErrorAfter = `          o.droppedRetry ||
          (!o.foreign && !o.superseded && o.failure.action === "send_message" &&
            o.failure.error !== void 0 && o.rejectedRetry))
        ) {
          an({
            id: (o.droppedRetry ?? o.rejectedRetry).id,`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function deriveOfficialRegenerationErrorModule(file, source) {
  if (file !== regenerationErrorTarget) return source;
  if (typeof source !== "string" || sha(source) !== regenerationErrorInput)
    throw Error("Regeneration error pinned input mismatch");
  if (source.split(regenerationErrorBefore).length !== 2)
    throw Error("Regeneration error anchor mismatch");
  return source.replace(regenerationErrorBefore, regenerationErrorAfter);
}
const manifestFor = (outputSha256) => ({
  revision: regenerationErrorRevision,
  modules: [
    {
      file: regenerationErrorTarget,
      inputSha256: regenerationErrorInput,
      outputSha256,
    },
  ],
});
export function applyOfficialRegenerationError(directory) {
  const resolved = path.resolve(directory),
    file = path.join(resolved, regenerationErrorTarget);
  if (
    fs.realpathSync(resolved) !== resolved ||
    resolved.split(path.sep).includes(".restore") ||
    fs.realpathSync(file) !== file ||
    !fs.lstatSync(file).isFile()
  )
    throw Error(
      "Regeneration error requires an explicit unlinked assembly output",
    );
  const derived = deriveOfficialRegenerationErrorModule(
    regenerationErrorTarget,
    fs.readFileSync(file, "utf8"),
  );
  fs.writeFileSync(file, derived);
  return manifestFor(sha(derived));
}
export function verifyOfficialRegenerationErrorManifest(
  manifest,
  files,
  expectedOutput,
) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedOutput ?? "") ||
    JSON.stringify(manifest) !== JSON.stringify(manifestFor(expectedOutput))
  )
    throw Error("Regeneration error manifest mismatch");
  const rows = files.filter(
    (row) => row.path === "assets/v1/" + regenerationErrorTarget,
  );
  if (rows.length !== 1 || rows[0].sha256 !== expectedOutput)
    throw Error("Regeneration error output mismatch");
}
