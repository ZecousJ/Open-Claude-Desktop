import fs from "node:fs";
import path from "node:path";

export const hostImportedChatResumeTarget = "shared-160-BGt89-ku.js";
const hubTarget = "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js";
export const hostImportedChatResumeFiles = [hostImportedChatResumeTarget, hubTarget];
export const hostImportedChatResumeRevision = "native-imported-chat-resume-v2";

export function deriveOfficialUiHostImportedChatResumeModule(file, source) {
  if (!hostImportedChatResumeFiles.includes(file)) return source;
  const rules = file === hubTarget ? [
    [
      'console.assert("__eap_only__");\nfunction bne(e) {',
      `import { lo as __claudexResumeLazy, no as __claudexResumeSuspense } from "./vendor-frame-iz8L1jC9.js";
import { sS as __claudexReadImportedChat } from "./shared-m-1-Nm0kn4Ee.js";
const __claudexHubImportedChatResume = __claudexResumeLazy(() =>
  import("./c3e34355f-DtXSgFZ9.js").then(({ t }) => ({ default: t })),
);
console.assert("__eap_only__");
function bne(e) {`,
    ],
    [
      '  let WP = A(\n      () =>\n        At && J === void 0',
      `  const __claudexImportDetail = __claudexReadImportedChat(e ?? "", {
    enabled: !!e && At && J === void 0 && !!globalThis["claude.settings"]?.ClaudeAiImport?.confirmImportedSessionResume,
    suppressError: !0,
  });
  const __claudexImportPending = __claudexImportDetail.data?.claudex_imported_resume_session_id;
  let WP = A(
      () =>
        At && J === void 0`,
    ],
    [
      "                                    renderAboveInput: a.aboveInput,",
      `                                    renderAboveInput: __claudexImportPending
                                      ? f(p, { children: [a.aboveInput, D(__claudexResumeSuspense, { fallback: null, children:
                                          D(__claudexHubImportedChatResume, {
                                            sessionId: __claudexImportPending,
                                            errorCategory: "imported_needs_resume_confirm",
                                            errorMessage: "",
                                            canSendMessage: !1,
                                            onRetry: __claudexImportDetail.refetch,
                                          }),
                                        })] })
                                      : a.aboveInput,`,
    ],
    [
      '                                    inputDisabled:\n                                      (pt?.startsWith("__hub_terminal__:") ?? !1) ||',
      '                                    inputDisabled:\n                                      !!__claudexImportPending ||\n                                      (pt?.startsWith("__hub_terminal__:") ?? !1) ||',
    ],
  ] : [
    [
      "function T$(e) {",
      `const __claudexImportedChatResume = ut(() =>
  import("./c3e34355f-DtXSgFZ9.js").then(({ t }) => ({ default: t })),
);
function T$(e) {`,
    ],
    [
      "{ data: b, error: x } = h_(t, y),",
      "{ data: b, error: x, refetch: __claudexRefetchChat } = h_(t, y),",
    ],
    [
      "                renderAboveInput: Ee,\n                composerBannersHang: !0,",
      `                renderAboveInput: b?.claudex_imported_resume_session_id
                  ? UK(W5, { children: [Ee, gl(GW, { fallback: null, children:
                      gl(__claudexImportedChatResume, {
                        sessionId: b.claudex_imported_resume_session_id,
                        errorCategory: "imported_needs_resume_confirm",
                        errorMessage: "",
                        canSendMessage: !1,
                        onRetry: __claudexRefetchChat,
                      }),
                    })] })
                  : Ee,
                composerBannersHang: !0,`,
    ],
    [
      "                inputDisabled: ae,\n                appendOnly: U.appendOnly,",
      "                inputDisabled: ae || !!b?.claudex_imported_resume_session_id,\n                appendOnly: U.appendOnly,",
    ],
  ];
  let output = source;
  for (const [before, after] of rules) {
    if (output.split(before).length !== 2)
      throw Error("Pinned imported Chat resume anchor mismatch.");
    output = output.replace(before, () => after);
  }
  return output;
}

export function applyOfficialUiHostImportedChatResume(directory) {
  for (const name of hostImportedChatResumeFiles) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, deriveOfficialUiHostImportedChatResumeModule(name, fs.readFileSync(file, "utf8")));
  }
  return { revision: hostImportedChatResumeRevision };
}
