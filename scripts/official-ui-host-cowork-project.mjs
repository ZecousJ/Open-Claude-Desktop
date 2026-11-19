import fs from "node:fs";
import path from "node:path";

export const hostCoworkProjectRevision = "local-cowork-project-feedback-v1";
export const hostCoworkProjectFile = "shared-140-D6FnSjbS.js";

const remove = `    qe = J4($, 77, I, v, m, pe)
      ? K4($, 77, I, v, m, pe, () => {
          !m ||
            !N9?.updateSession ||
            (I(),
            N9.updateSession(m, { spaceId: "", userSelectedProjectUuids: [] }),
            pe({
              event_key: "claudeai.cowork.space.session_removed",
              session_id: m,
              space_id: v ?? "",
              session_type: "local",
            }));
        })
      : $[81],`;
const rules = [
  [
    remove,
    `    qe = async () => {
      if (!m || !N9?.updateSession) return;
      I();
      try {
        await N9.updateSession(m, { spaceId: "", userSelectedProjectUuids: [] });
      } catch (e) {
        De(Y_(e), {
          error: e,
          messageForLogging: "SessionDropdownMenu remove-from-project failed",
        });
        return;
      }
      pe({
        event_key: "claudeai.cowork.space.session_removed",
        session_id: m,
        space_id: v ?? "",
        session_type: "local",
      });
    },`,
  ],
];

export function deriveOfficialUiHostCoworkProjectModule(file, source) {
  if (file !== hostCoworkProjectFile) return source;
  for (const [before, after] of rules) {
    if (source.split(before).length !== 2)
      throw Error("Native Cowork project anchor mismatch: " + file);
    source = source.replace(before, after);
  }
  return source;
}

export function applyOfficialUiHostCoworkProject(directory) {
  const file = path.join(directory, hostCoworkProjectFile);
  fs.writeFileSync(
    file,
    deriveOfficialUiHostCoworkProjectModule(
      hostCoworkProjectFile,
      fs.readFileSync(file, "utf8"),
    ),
  );
  return { revision: hostCoworkProjectRevision };
}

export const hostCoworkFolderRevision = "local-cowork-folder-confirmation-v1";
export const hostCoworkFolderFile = "shared-3-f8anTwq9.js";

export function deriveOfficialUiCoworkFolderModule(file, source) {
  if (file !== hostCoworkFolderFile) return source;
  const before = `function b9(e, t, n, r) {
  r.current = !0;
  try {
    (e && t(e), n());`;
  if (source.split(before).length !== 2)
    throw Error("Native Cowork folder confirmation anchor mismatch: " + file);
  return source.replace(before, `async function b9(e, t, n, r) {
  r.current = !0;
  try {
    if (e && e.kind !== "file")
      await N9?.addTrustedFolder?.({ folder: e.path, scope: "session" });
    (e && t(e), n());`);
}

export function applyOfficialUiCoworkFolder(directory) {
  const file = path.join(directory, hostCoworkFolderFile);
  fs.writeFileSync(file, deriveOfficialUiCoworkFolderModule(hostCoworkFolderFile, fs.readFileSync(file, "utf8")));
  return hostCoworkFolderRevision;
}

export const hostCoworkStartRevision = "local-cowork-start-effort-v1";
export const hostCoworkStartFile = "shared-6-abVJ5RR0.js";

export function deriveOfficialUiCoworkStartModule(file, source) {
  if (file !== hostCoworkStartFile) return source;
  const before = `              model: Y && tN(Y),
              permissionMode: e.permissionMode,`;
  if (source.split(before).length !== 2)
    throw Error("Native Cowork start effort anchor mismatch: " + file);
  return source.replace(before, `              model: Y && tN(Y),
              effortLevel: e.effortLevel,
              permissionMode: e.permissionMode,`);
}

export function applyOfficialUiCoworkStart(directory) {
  const file = path.join(directory, hostCoworkStartFile);
  fs.writeFileSync(file, deriveOfficialUiCoworkStartModule(hostCoworkStartFile, fs.readFileSync(file, "utf8")));
  return hostCoworkStartRevision;
}

export const hostCoworkComputerUseRevision = "local-cowork-computer-use-approval-v1";
export const hostCoworkComputerUseFile = "c21f11e6d-CzWHzVHw.js";

export function deriveOfficialUiCoworkComputerUseModule(file, source) {
  if (file !== hostCoworkComputerUseFile) return source;
  const prefix = 'request.requestId?.startsWith("cowork-computer-use:")';
  const rules = [
    [
      'import { Qr as t, ph as e }',
      'import { t as claudexComputerApprovalCards } from "./ca44d5dae-Duwp3Ivb.js";\nimport { Qr as t, ph as e }',
    ],
    [
      '                  renderAboveInput: zd,',
      `                  renderAboveInput: Yt?.some(request => ${prefix})
                    ? o(s, { children: [zd, p(claudexComputerApprovalCards, {
                        toolPermissionRequests: Yt.filter(request => ${prefix}),
                        onToolDecision: rt,
                      })] }) : zd,`,
    ],
  ];
  for (const [before, after] of rules) {
    if (source.split(before).length !== 2)
      throw Error("Native Cowork computer-use approval anchor mismatch: " + file);
    source = source.replace(before, after);
  }
  return source;
}

export function applyOfficialUiCoworkComputerUse(directory) {
  const file = path.join(directory, hostCoworkComputerUseFile);
  fs.writeFileSync(file, deriveOfficialUiCoworkComputerUseModule(hostCoworkComputerUseFile, fs.readFileSync(file, "utf8")));
  return hostCoworkComputerUseRevision;
}
