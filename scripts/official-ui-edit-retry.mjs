/** Narrow, pinned original failed-edit retry derivation. No flags or new UI. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const editRetryRevision = "original-failed-edit-retry-v1";
export const editRetryMain =
  "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js";
export const editRetryHub =
  "30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
export const editRetryInputHashes = Object.freeze({
  [editRetryMain]:
    "985a0255f9587deff7a369969b90b3492e7e6d84c69378b4aa14c2d3831e7b24",
  [editRetryHub]:
    "b845ebfc11728c5bdac1b63ab3a4f03d54948715cc7649433efd1eb2b8d4ab14",
  "shared-0-BgsOqC85.js":
    "9a15e991acb7930e5e25b15a453f285cda7c41a98539ed651d154c190da4ca74",
  "shared-3-f8anTwq9.js":
    "9b9d6471a82ab5a1a2869a91312451de9be029c6ec95b15157484e54128f14f6",
});
export const editRetryMainBefore = `let z = M === void 0 ? BT(I) : void 0,
          B = z !== void 0 && j && $D(Z, z) && !Wh.some((e) => Sa.current.has(e)) ? z : void 0;`;
export const editRetryMainAfter = `let z = M === void 0 ? BT(I) : void 0;
        const claudexFailedEditRetry = I?.pressParent?.pressKind === "edit";
        if (claudexFailedEditRetry) {
          if (I.retryable !== true || I.code === "mutation_unconfirmed") {
            wr(typeof I.displayMessage === "string" && I.displayMessage.length > 0 ? I.displayMessage : je.formatMessage(Kx.noKnownParent));
            return "blocked_busy";
          }
          const claudexFailedEditRow = z === void 0 ? void 0 : Z.messages.get(z.pressedMessageId);
          if (!j || Z.conversation?.id !== e || M !== void 0 || z === void 0 ||
              typeof z.parentMessageId !== "string" || typeof z.pressedMessageId !== "string" ||
              z.pressedMessageId.length === 0 || claudexFailedEditRow?.role !== TI.USER ||
              !Z.activePathMessages.some(row => row.id === z.pressedMessageId) ||
              uM(claudexFailedEditRow.parentMessageId) !== z.parentMessageId ||
              !Xh(uk(Z, Sa.current), z.pressedMessageId) || Wh.some(action => Sa.current.has(action))) {
            wr(je.formatMessage(Kx.noKnownParent), { uniqueKey: "hub-edit-refused:no-known-parent" });
            return "blocked_busy";
          }
        }
        let B = z !== void 0 && j && ($D(Z, z) || claudexFailedEditRetry) && !Wh.some((e) => Sa.current.has(e)) ? z : void 0;`;
export const editRetryHubBefore = `m.noRetry === !0 ||
          _) && { sendFailedNoRetry: !0 })`;
export const editRetryHubAfter = `m.noRetry === !0 ||
          (m.pressParent?.pressKind === "edit" && (m.retryable !== true || m.code === "mutation_unconfirmed")) ||
          _) && { sendFailedNoRetry: !0 })`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const changes = Object.freeze({
  [editRetryMain]: [editRetryMainBefore, editRetryMainAfter],
  [editRetryHub]: [editRetryHubBefore, editRetryHubAfter],
});
function once(source, needle) {
  if (source.split(needle).length !== 2)
    throw Error("Edit retry anchor mismatch");
}
export function deriveOfficialEditRetryModule(file, source) {
  if (!Object.hasOwn(editRetryInputHashes, file)) return source;
  if (typeof source !== "string" || sha(source) !== editRetryInputHashes[file])
    throw Error("Edit retry pinned input mismatch: " + file);
  if (!changes[file]) return source;
  const [before, after] = changes[file];
  once(source, before);
  if (source.includes("claudexFailedEdit"))
    throw Error("Edit retry binding collision");
  return source.replace(before, after);
}
export function deriveOfficialEditRetry(sources) {
  const derived = {};
  for (const file of Object.keys(editRetryInputHashes))
    derived[file] = deriveOfficialEditRetryModule(file, sources[file]);
  return derived;
}
export function applyOfficialEditRetry(directory) {
  const resolved = path.resolve(directory);
  if (
    fs.realpathSync(resolved) !== resolved ||
    resolved.split(path.sep).includes(".restore")
  )
    throw Error("Edit retry requires an explicit unlinked assembly output");
  const sources = Object.fromEntries(
    Object.keys(editRetryInputHashes).map((file) => {
      const p = path.join(resolved, file);
      if (fs.realpathSync(p) !== p || !fs.lstatSync(p).isFile())
        throw Error("Linked/non-file edit retry input");
      return [file, fs.readFileSync(p, "utf8")];
    }),
  );
  const derived = deriveOfficialEditRetry(sources);
  for (const file of Object.keys(changes))
    fs.writeFileSync(path.join(resolved, file), derived[file]);
  return editRetryManifest(
    Object.fromEntries(
      Object.keys(changes).map((file) => [file, sha(derived[file])]),
    ),
  );
}

function editRetryManifest(outputs) {
  return {
    revision: editRetryRevision,
    dependencies: Object.entries(editRetryInputHashes).map(
      ([file, inputSha256]) => ({ file, inputSha256 }),
    ),
    modules: Object.keys(changes).map((file) => ({
      file,
      inputSha256: editRetryInputHashes[file],
      outputSha256: outputs[file],
    })),
  };
}
export function verifyOfficialEditRetryManifest(manifest, files, outputs) {
  for (const file of Object.keys(changes))
    if (!/^[a-f0-9]{64}$/.test(outputs?.[file] ?? ""))
      throw Error("Edit retry reconstructed output missing");
  if (JSON.stringify(manifest) !== JSON.stringify(editRetryManifest(outputs)))
    throw Error("Edit retry manifest mismatch");
  for (const [file, input] of Object.entries(editRetryInputHashes)) {
    const rows = files.filter((row) => row.path === "assets/v1/" + file);
    if (
      rows.length !== 1 ||
      rows[0].sha256 !== (Object.hasOwn(changes, file) ? outputs[file] : input)
    )
      throw Error("Edit retry dependency mismatch: " + file);
  }
}
