import fs from "node:fs";
import path from "node:path";

export const hostSessionExportTarget = "c432d56b4-2rgSihhj.js";
export const desktopSessionExportAsset = "src/renderer/assets/v1/c432d56b4-DcuNsEB3.js";
export const hostSessionExportRevision = "native-session-export-v3";

export function deriveOfficialUiSessionTransferPreload(source) {
  const anchor = `      (Se = (e) => {
        d() &&
          ((e["claude.settings"] = e["claude.settings"] || {}),
          (e["claude.settings"].ClaudeAiImport = xe));
      }),`;
  if (source.split(anchor).length !== 2) throw Error("Session transfer preload anchor mismatch.");
  return source.replace(anchor, `      (Se = (e) => {
        if (d()) {
          (e["claude.settings"] ??= {}).ClaudeAiImport = xe;
        } else if (u() && window.location.hostname === "localhost") {
          const { pickLocalZips, peekLocalZips, pickSessionSourceFolder, registerDesktop3pBundle,
            previewSessionExport, runSessionExport, cancelSessionExport, showExportInFolder,
            onOnSessionExportProgress, confirmImportedSessionResume } = xe;
          (e["claude.settings"] ??= {}).ClaudeAiImport = { pickLocalZips, peekLocalZips,
            pickSessionSourceFolder, registerDesktop3pBundle, previewSessionExport, runSessionExport,
            cancelSessionExport, showExportInFolder, onOnSessionExportProgress, confirmImportedSessionResume };
        }
      }),`);
}

export function deriveOfficialUiHostSessionExportModule(file, cloud, desktop) {
  if (file !== hostSessionExportTarget) return cloud;
  const start = "var Qt = de({\n    cowork: {";
  const end = "  tn = l(function () {";
  if (desktop.split(start).length !== 2 || desktop.split(end).length !== 2)
    throw Error("Pinned desktop session export dialog is unavailable.");
  const dialog = desktop.slice(desktop.indexOf(start), desktop.indexOf(end)).replace(/,\s*$/, ";");
  if (!dialog.includes("T?.runSessionExport?.(N)")) throw Error("Pinned session export action is unavailable.");
  const chooseZip = desktop.match(/a\(C, \{\s*variant: "secondary",\s*size: "sm",\s*onClick: d,\s*"data-testid": "import-zip-choose-file",\s*children: a\(G, \{[^\n]+\}\),\s*\}\)/)?.[0];
  if (!chooseZip) throw Error("Pinned session ZIP picker is unavailable.");
  const zipButton = chooseZip.replace("a(C,", "s(h,")
    .replace("onClick: d,", "onClick,")
    .replace("children: a(G,", "children: s(W,");

  const adapter = `import { $n as __exportSkeletonGroup, uR as __exportSkeleton } from "./shared-frame-DH1u5uQk.js";
import { n as __exportPoints } from "./c1ec8a7a7-BWfVGq8q.js";
import { K9 as __exportMac, Ue as __exportWindows } from "./shared-l-p-m-w-3-B5uNmf7O.js";
import { ob as __exportBytes } from "./shared-3-f8anTwq9.js";
const __claudexSessionExport = (({ a, r, i, o, u, n, d, c, s, l, K, G, de, T, w, C, m, b, S, f, q, me, oe, ce, wt, Et }) => {
${dialog}
  return en;
})({
  a: s, r: n, i: r, o: a, u: e, n: t, d: u, c: l, s: o, l: c,
  K: G, G: W, de: ue, T: w, w: m, C: h, m: y, b: _,
  S: __exportSkeletonGroup, f: __exportSkeleton, q: __exportBytes,
  me: __exportPoints, oe: __exportMac, ce: __exportWindows, wt: st, Et: lt,
});
const __sessionImportFileButton = (onClick) => ${zipButton};
`;
  const close = "    J0($, 4) ? K0($, 4, () => d(!1)) : $[4];";
  const mount = "          ? I2($, 50, Z1($, 49, on, r.cliUpdateRequired), r.localSessions, u)";
  const extras = "            f === 2 && s(Xe, { extras: Ee }),";
  for (const anchor of ["var Z = {", close, mount, extras])
    if (cloud.split(anchor).length !== 2) throw Error("Session export host anchor mismatch.");
  return cloud.replace("var Z = {", adapter + "var Z = {")
    .replace(extras, `            f === 2 && i.localZip && __sessionImportFileButton(be),\n${extras}`)
    .replace(close, "    const closeSessionExport = J0($, 4) ? K0($, 4, () => d(!1)) : $[4];")
    .replace(mount, `          ? I2($, 50, Z1($, 49, u && s(__claudexSessionExport, {
              open: !0, onClose: closeSessionExport, canImport: r.localSessions && !r.cliUpdateRequired,
            }), r.cliUpdateRequired), r.localSessions, u)`);
}

export function applyOfficialUiHostSessionExport(directory, source) {
  const file = path.join(directory, hostSessionExportTarget);
  const desktop = fs.readFileSync(path.join(source, desktopSessionExportAsset), "utf8");
  fs.writeFileSync(file, deriveOfficialUiHostSessionExportModule(hostSessionExportTarget, fs.readFileSync(file, "utf8"), desktop));
  return { revision: hostSessionExportRevision };
}
