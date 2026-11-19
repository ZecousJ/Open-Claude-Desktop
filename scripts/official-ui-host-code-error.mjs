/** Use the original neutral error copy when the host owns model execution. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const hostCodeErrorRevision = "claudex-code-service-error-v1";
export const hostCodeErrorTarget = "shared-60-BiBu3PxX.js";
export const hostCodeErrorInputHashes = {
  [hostCodeErrorTarget]: "1a6a94527688bccb68758ddcadcdbadcca013275cbf8bd23fdb6946f70350106",
};
export const hostCodeErrorOriginalHashes = {
  [hostCodeErrorTarget]: "4ecedfdc81480f06be45a24d416a526dc8af773a0362c310edabb84f94b6849f",
};
export const hostCodeErrorRules = [
  {
    file: hostCodeErrorTarget,
    name: "bind-original-neutral-copy",
    before: '\nM7({\n  overloadedWithoutComposer: { defaultMessage: "This is usually temporary.", id: "upWIU2" },',
    after: '\nvar WF = M7({\n  overloadedWithoutComposer: { defaultMessage: "This is usually temporary.", id: "upWIU2" },',
  },
  {
    file: hostCodeErrorTarget,
    name: "share-neutral-code-error-copy",
    before: "var WF = o$,\n  LC = ",
    after: "var LC = ",
  },
];
const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostCodeErrorModule(file, source) {
  if (file !== hostCodeErrorTarget) return source;
  if (sha(source) !== hostCodeErrorInputHashes[file])
    throw Error("Pinned Code server error input mismatch");
  let output = source;
  for (const { before, after, name } of hostCodeErrorRules) {
    if (output.split(before).length !== 2)
      throw Error("Pinned Code server error anchor mismatch: " + name);
    output = output.replace(before, after);
  }
  return output;
}

export function applyOfficialUiHostCodeError(directory) {
  const file = hostCodeErrorTarget;
  const location = path.join(fs.realpathSync(directory), file);
  if (location.split(path.sep).includes(".restore") || !fs.lstatSync(location).isFile())
    throw Error("Code server error derivation requires a regular assembled file");
  const output = deriveOfficialUiHostCodeErrorModule(file, fs.readFileSync(location, "utf8"));
  fs.writeFileSync(location, output);
  return {
    revision: hostCodeErrorRevision,
    modules: [{
      file,
      originalSha256: hostCodeErrorOriginalHashes[file],
      inputSha256: hostCodeErrorInputHashes[file],
      outputSha256: sha(output),
      rules: hostCodeErrorRules.map(({ name }) => name),
    }],
  };
}
