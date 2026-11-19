/** Keep the original Chat/Sessions search independent of excluded scheduled tasks. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const chatSearchReadinessRevision = "original-chat-search-readiness-v1";
export const chatSearchReadinessTarget = "c2771e1f6-OQUR_HHd.js";
export const chatSearchReadinessInput =
  "afb08d2310c0309acf6c39f2232cbbc5ac6101dfbbc85508aa742ccba533b51f";
export const chatSearchReadinessOutput =
  "c9e05aeb7a86f6467b941a8d5bc2f9ebfd98ef113e78233d53d7eb4306787018";
export const chatSearchReadinessRule = {
  before:
    "    vn = we && kt && Pt && ze && vt && ut && Vt && Xe && et && Gt && Tt,",
  after:
    '    vn = we && kt && Pt && ze && vt && ut && Vt && Xe && et && (D?.type === "chat" || Gt) && Tt,',
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function deriveOfficialChatSearchReadinessModule(file, source) {
  if (file !== chatSearchReadinessTarget) return source;
  if (typeof source !== "string" || sha(source) !== chatSearchReadinessInput)
    throw Error("Chat search readiness pinned input mismatch");
  if (source.split(chatSearchReadinessRule.before).length !== 2)
    throw Error("Chat search readiness anchor mismatch");
  const output = source.replace(
    chatSearchReadinessRule.before,
    chatSearchReadinessRule.after,
  );
  if (sha(output) !== chatSearchReadinessOutput)
    throw Error("Chat search readiness pinned output mismatch");
  return output;
}
const manifestFor = (outputSha256) => ({
  revision: chatSearchReadinessRevision,
  modules: [
    {
      file: chatSearchReadinessTarget,
      inputSha256: chatSearchReadinessInput,
      outputSha256,
    },
  ],
});
export function applyOfficialChatSearchReadiness(directory) {
  const resolved = path.resolve(directory);
  if (
    fs.realpathSync(resolved) !== resolved ||
    resolved.split(path.sep).includes(".restore")
  )
    throw Error(
      "Chat search readiness requires an explicit unlinked assembly output",
    );
  const file = path.join(resolved, chatSearchReadinessTarget);
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
    throw Error("Chat search readiness requires an unlinked module file");
  const value = deriveOfficialChatSearchReadinessModule(
    chatSearchReadinessTarget,
    fs.readFileSync(file, "utf8"),
  );
  fs.writeFileSync(file, value);
  return manifestFor(sha(value));
}
export function verifyOfficialChatSearchReadinessManifest(
  manifest,
  files,
  outputSha256,
) {
  if (
    outputSha256 !== chatSearchReadinessOutput ||
    JSON.stringify(manifest) !== JSON.stringify(manifestFor(outputSha256))
  )
    throw Error("Chat search readiness manifest mismatch");
  const rows = files.filter(
    (row) => row.path === "assets/v1/" + chatSearchReadinessTarget,
  );
  if (rows.length !== 1 || rows[0].sha256 !== outputSha256)
    throw Error("Chat search readiness output mismatch");
}
