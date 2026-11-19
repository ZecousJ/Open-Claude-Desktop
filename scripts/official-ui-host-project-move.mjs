/** Host-only feedback for original project consumers; no request, retry or rollback changes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const hostProjectMoveRevision = "claudex-project-move-feedback-v1";
export const hostProjectMoveInputHashes = {
  "shared-m-2-DfdOu-fU.js": "2f48c45726d829fc3567b5aec554180e243eb35b18c7d0cc3443768bc4fd6ed1",
  "shared-9-B15zSG0N.js": "36465c3d40e669aab52f90ee5fc18d64b340392fc18e0ab18a49311efd98122b"
};
export const hostProjectMoveOriginalHashes = {
  "shared-m-2-DfdOu-fU.js": "4bff05fcf5c76e3ee12e6196f9fce0ed4409e7d560957af0cc48da3a09f29e50",
  "shared-9-B15zSG0N.js": "d2ede3a147f475aafca0d3e0bbcb8074451a8de0d8b96f3433a25ae1306983f0"
};
export const hostProjectMoveRules = [
  {
    "file": "shared-m-2-DfdOu-fU.js",
    "name": "remove-error-option",
    "before": "  { showSuccess: t, showError: n, onSuccess: r },",
    "after": "  { showSuccess: t, showError: __claudexShowProjectError, onSuccess: r },"
  },
  {
    "file": "shared-m-2-DfdOu-fU.js",
    "name": "remove-resolved-failure",
    "before": "      r?.(n),\n      n\n    );",
    "after": "      n.failed.length > 0 && __claudexShowProjectError &&\n        o(s.formatMessage({ defaultMessage: \"Couldn’t remove from project. Try again.\", id: \"KfioWb\" }), { messageForLogging: \"Project removal save unconfirmed\" }),\n      r?.(n),\n      n\n    );"
  },
  {
    "file": "shared-m-2-DfdOu-fU.js",
    "name": "remove-thrown-error-option",
    "before": "      n &&\n        o(\n          s.formatMessage({\n            defaultMessage: \"Couldn’t remove from project. Try again.\",",
    "after": "      __claudexShowProjectError &&\n        o(\n          s.formatMessage({\n            defaultMessage: \"Couldn’t remove from project. Try again.\","
  },
  {
    "file": "shared-9-B15zSG0N.js",
    "name": "move-resolved-failure",
    "before": "                (l\n                  ? n(r.formatMessage(i.moveFailedCount, { count: c.totalFailed }), {\n                      messageForLogging:\n                        \"{count, plural, one {Failed to move # chat. You can try again.} other {Failed to move # chats. You can try again.}}\",\n                    })\n                  : n(r.formatMessage(i.moveTargetGone), {\n                      messageForLogging: \"This chat does not exist or was deleted\",\n                    })),",
    "after": "                n(r.formatMessage(i.moveFailedCount, { count: c.totalFailed }), {\n                  messageForLogging: \"Failed to move chats. You can try again.\",\n                }),"
  },
];
const sha = value => createHash("sha256").update(value).digest("hex");
export function deriveOfficialUiHostProjectMoveModule(file, source) {
  if (!Object.hasOwn(hostProjectMoveInputHashes, file)) return source;
  if (sha(source) !== hostProjectMoveInputHashes[file])
    throw Error("Pinned project move input mismatch: " + file);
  let output = source;
  for (const rule of hostProjectMoveRules.filter(r => r.file === file)) {
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error("Pinned project move anchor mismatch: " + rule.name);
    output = output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
  }
  return output;
}
export function applyOfficialUiHostProjectMove(directory) {
  const supplied = path.resolve(directory);
  directory = fs.realpathSync(supplied);
  if (directory !== supplied || directory.split(path.sep).includes(".restore"))
    throw Error("Project move output must be unlinked; recovered sources are immutable");
  const rows = Object.keys(hostProjectMoveInputHashes).map(file => {
    const location = path.join(directory, file);
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error("Project move output must be an unlinked regular file");
    const input = fs.readFileSync(location, "utf8");
    return { file, location, input, output: deriveOfficialUiHostProjectMoveModule(file, input) };
  });
  // Validate every input before writing any output. A repeated application fails closed.
  for (const row of rows) fs.writeFileSync(row.location, row.output);
  return { revision: hostProjectMoveRevision, modules: rows.map(row => ({
    file: row.file, originalSha256: hostProjectMoveOriginalHashes[row.file],
    inputSha256: sha(row.input), outputSha256: sha(row.output),
    rules: hostProjectMoveRules.filter(r => r.file === row.file).map(r => r.name),
  })) };
}
