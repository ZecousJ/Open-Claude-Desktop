import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const hostCodeConnectorMenuRevision =
  "claudex-local-code-connector-menu-v1";
const file = "ca80fca8d-LvEosFmV.js";
export const hostCodeConnectorMenuOriginalHashes = {
  [file]: "cc82cfaec6d780106ec81e36949e278f600a229e7badd394372f76528258332a",
};
export const hostCodeConnectorMenuInputHashes = {
  [file]: "ace97edd4b80692adda20e35665c29830c638a86cba58efa9fdf74d8961e051c",
};
export const hostCodeConnectorMenuRules = [
  {
    file,
    name: "subscribe-to-local-session-connector-denials",
    before: `function Qr(e) {\n  let $ = J9(193),`,
    after: `function Qr(e) {\n  let $ = J9(194),`,
  },
  {
    file,
    name: "read-local-session-connector-denials",
    before: "    we = r?.id,\n    Te = J1($, 8, we)",
    after: `    we = r?.id,
    __claudexDisabledMcp = ht((state) =>
      r?.type === "local" ? state.sessions.find((session) => session.sessionId === we)?.claudexDisabledMcp : void 0
    ),
    Te = J1($, 8, we)`,
  },
  {
    file,
    name: "invalidate-checkboxes-when-session-choices-change",
    before:
      "      J1($, 38, I.isEnabled) ||\n      J5($, 39, I.toggle, fe, N, b, Ve, H, p, xe, B, A, z, Oe, u, Be, v)",
    after:
      "      J1($, 38, I.isEnabled) ||\n      $[193] !== __claudexDisabledMcp ||\n      J5($, 39, I.toggle, fe, N, b, Ve, H, p, xe, B, A, z, Oe, u, Be, v)",
  },
  {
    file,
    name: "combine-local-session-denials-with-account-settings",
    before: "        let s = xe(e) ?? ft(e, o, N, !1);",
    after: `        let s = xe(e) ?? (
          !__claudexDisabledMcp?.connectors.includes(e.uuid) &&
          ft(e, __claudexDisabledMcp ? o.filter((key) => !__claudexDisabledMcp.tools.includes(key)) : o, N, !1)
        );`,
  },
  {
    file,
    name: "remember-local-session-connector-denials",
    before: "      (($[37] = e),\n        ($[38] = I.isEnabled),",
    after:
      "      (($[37] = e),\n        ($[38] = I.isEnabled),\n        ($[193] = __claudexDisabledMcp),",
  },
];

const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostCodeConnectorMenuModule(name, source) {
  if (name !== file) return source;
  if (sha(source) !== hostCodeConnectorMenuInputHashes[file])
    throw Error("Pinned local Code connector menu input mismatch");
  let output = source;
  for (const { before, after, name } of hostCodeConnectorMenuRules) {
    if (output.split(before).length !== 2)
      throw Error("Pinned local Code connector menu anchor mismatch: " + name);
    output = output.replace(before, after);
  }
  return output;
}

export function applyOfficialUiHostCodeConnectorMenu(directory) {
  const location = path.join(fs.realpathSync(directory), file);
  if (
    location.split(path.sep).includes(".restore") ||
    !fs.lstatSync(location).isFile()
  )
    throw Error(
      "Code connector menu derivation requires a regular assembled file",
    );
  const output = deriveOfficialUiHostCodeConnectorMenuModule(
    file,
    fs.readFileSync(location, "utf8"),
  );
  fs.writeFileSync(location, output);
  return {
    revision: hostCodeConnectorMenuRevision,
    modules: [
      {
        file,
        originalSha256: hostCodeConnectorMenuOriginalHashes[file],
        inputSha256: hostCodeConnectorMenuInputHashes[file],
        outputSha256: sha(output),
        rules: hostCodeConnectorMenuRules.map(({ name }) => name),
      },
    ],
  };
}
