import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hostAuthenticatedExpression } from "./official-ui-host-auth.mjs";
export const hostFeedbackOutcomeRevision = "claudex-feedback-outcome-v4";
export const hostFeedbackOutcomeInputHashes = {
  "c4b740774-EVvUEVti.js":
    "7b02f6aade608385583a4d8e637bf5e412fb9ba773f04327ce1c97c8c6903289",
  "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js":
    "fb89bf1603e7d807bd4fc6255de10dc99f672ec0003a5457159fe7c3593d3ec6",
  "c0a09de85-CP6gEsls.js":
    "d995b8698e8148e37fa0df6ef4fab18ecc53682c095849fa5c8c137ef0d1981a",
  "shared-28-CcQ2xpO-.js":
    "7546473cea295ce6b8f8dd7910333c71de988a2c53bad6bb96cc45f508727544",
  "shared-23-xVessQLu.js":
    "720d0f1ba2c8104eb28bc4c0ef23cad660121cac93dea73cf7af434201c4ab25",
  "shared-22-Ciy9U3_0.js":
    "d33cbdf098b85ed04d782b7f2c94334b7b7e43bfa6c3ed13ff3f75dee711d0e9",
};
export const hostFeedbackOutcomeOriginalHashes = {
  "c4b740774-EVvUEVti.js":
    "a7b0991e6e66e052a5b97de27a7576f4f521a7778ff205e8e08d43a0794cbe4d",
  "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js":
    "06181192d0913e979ee2bd32ad3d83219e49ab69517b3d6e0931f1bf97224df2",
  "c0a09de85-CP6gEsls.js":
    "d995b8698e8148e37fa0df6ef4fab18ecc53682c095849fa5c8c137ef0d1981a",
  "shared-28-CcQ2xpO-.js":
    "a5e2ead73c0bda63fac45d7dd60b2e7b1bba1719d69027193e9c538544624390",
  "shared-23-xVessQLu.js":
    "71d1626ba5ffb6e705cb8cf3eadc8cdbb2c5e2fae32323a6c3f48cdbf6994527",
  "shared-22-Ciy9U3_0.js":
    "1864d927c5172f5dfe67282aa70ac945d4277a5fbab4ae1928f73897c0e80d7a",
};
export const hostFeedbackOutcomeHelper = `function __claudexFeedbackUnknown(result) {
 return result?.claudexProductFeedback === true && result?.deliveryState === "unknown" && !result?.feedbackId;
}
function __claudexFeedbackUnknownText(intl) {
 return intl.formatMessage({id:"claudex.feedback.delivery-unknown",defaultMessage:/^zh(?:-|$)/i.test(intl.locale ?? "") ? "无法确认反馈是否已发送，请勿重复提交。" : "Couldn’t confirm whether your feedback was sent. Please don’t submit it again."});
}
`;
export const hostFeedbackNotice = `function __claudexFeedbackNotice(intl) {
  return /^zh(?:-|$)/i.test(intl.locale ?? "")
    ? "仅将你填写的反馈和应用版本发送给管理员。"
    : "Only your feedback text and app version will be sent to the administrator.";
}
`;
export const hostWebFeedbackBridge = `function __claudexWebFeedbackBridge() {
  const bridge = globalThis.__claudexProductFeedback;
  if (bridge?.version === 1 && typeof bridge.submit === "function" && typeof bridge.submitCode === "function")
    return bridge;
}
`;
const hostProductFeedbackCapability = hostWebFeedbackBridge + `function __claudexCanSendProductFeedback(e, native) {
  return (${hostAuthenticatedExpression}) &&
    (typeof native?.submitFeedback === "function" || !!__claudexWebFeedbackBridge());
}
`;
const [modal, hub, transport, entry, mount, footer] = Object.keys(hostFeedbackOutcomeInputHashes);
const helpers = {
  [modal]: hostFeedbackOutcomeHelper + hostFeedbackNotice + hostProductFeedbackCapability,
  [hub]: hostFeedbackOutcomeHelper,
  [transport]: hostWebFeedbackBridge,
  [entry]: hostProductFeedbackCapability,
  [mount]: hostProductFeedbackCapability,
};
export const hostFeedbackOutcomeRules = [
  {
    file: transport,
    name: "memoize-original-hook-with-host-account",
    before: 'import { J2, J9, K2 }',
    after: 'import { J3, J9, K3 }',
  },
  {
    file: transport,
    name: "submit-product-feedback-in-original-hook",
    before: `  let $ = J9(3),
    t = e(),
    n = i().activeOrganization?.uuid;
  return J2($, 0, n, t)
    ? K2($, 0, n, t, async (e) => {
        let i = await (r?.submitFeedback ? r.submitFeedback(e) : l(t, n, e));
        return (a(n, i), i);
      })
    : $[2];`,
    after: `  let $ = J9(4),
    t = e(),
    { account, activeOrganization: org } = i(),
    n = org?.uuid,
    host = ${hostAuthenticatedExpression.replace(/\be\b/g, "account")};
  return J3($, 0, n, t, host)
    ? K3($, 0, n, t, host, async (e) => {
        if (host) {
          const bridge = __claudexWebFeedbackBridge();
          if (!bridge && typeof r?.submitFeedback !== "function")
            return { failureReason: "unavailable", statusCode: 503 };
          if (e.includeLogs || e.includeTranscript)
            return { failureReason: "attachments_unavailable", statusCode: 400 };
          try {
            return await (bridge ? bridge.submit(e) : r.submitFeedback(e));
          } catch {
            return { claudexProductFeedback: true, deliveryState: "unknown", failureReason: "unconfirmed" };
          }
        }
        let i = await (r?.submitFeedback ? r.submitFeedback(e) : l(t, n, e));
        return (a(n, i), i);
      })
    : $[3];`,
  },
  {
    file: entry,
    name: "open-original-feedback-on-authenticated-host",
    before: `function CL() {
  let e = BW(),
    t = a9("cowork_feedback_bundle");
  return e && t;
}
function Ge() {
  let e = BW(),
    t = a9("cowork_feedback_web_submit"),
    { orgAvailable: n } = fh(),
    r = kC();
  return e && !r && (!!UG?.submitFeedback || (n && t));`,
    after: `function CL(allowHost = true) {
  let e = BW(),
    t = a9("cowork_feedback_bundle"),
    host = __claudexCanSendProductFeedback(__claudexFeedbackAccount()?.account, UG);
  return (allowHost && host) || (e && t);
}
function Ge(allowHost) {
  let e = BW(),
    t = a9("cowork_feedback_web_submit"),
    { orgAvailable: n } = fh(),
    r = kC(),
    host = __claudexCanSendProductFeedback(__claudexFeedbackAccount()?.account, UG);
  return !r && ((allowHost && host) || (e && (!!UG?.submitFeedback || (n && t))));`,
  },
  {
    file: entry,
    name: "accept-host-route-eligibility",
    before: `function re() {
  let e = CL(),
    t = Ge();`,
    after: `function re({ allowHost = true } = {}) {
  let e = CL(allowHost),
    t = Ge(allowHost);`,
  },
  {
    file: footer,
    name: "read-original-frame-route-mode",
    before: '  f5 as tL,\n  nV as XO,',
    after: '  f5 as tL,\n  lm as __claudexFeedbackRouteMode,\n  nV as XO,',
  },
  {
    file: footer,
    name: "offer-host-footer-feedback-on-cowork-routes",
    before: '    r = Pv(),\n    i = re(),\n    a = vG(),',
    after: '    r = Pv(),\n    i = re({ allowHost: As(__claudexFeedbackRouteMode) === "cowork" }),\n    a = vG(),',
  },
  {
    file: entry,
    name: "use-existing-account-hook",
    before: '  Jh,\n  L9,\n  Ql,\n  RO as Wk,',
    after: '  Jh,\n  L9,\n  Q6 as __claudexFeedbackAccount,\n  Ql,\n  RO as Wk,',
  },
  {
    file: mount,
    name: "mount-original-feedback-on-authenticated-host",
    before: `  let $ = J9(5),
    e = lR(),
    { orgAvailable: t } = x5(),
    n = pr("cowork_feedback_bundle"),
    r = pr("cowork_feedback_web_submit");
  return J4($, 0, n, r, e, t)
    ? K4($, 0, n, r, e, t, n && (e || (t && r)) ? tT(AZ, {}) : null)
    : $[4];`,
    after: `  let $ = J9(2),
    e = lR(),
    { orgAvailable: t } = x5(),
    n = pr("cowork_feedback_bundle"),
    r = pr("cowork_feedback_web_submit"),
    host = __claudexCanSendProductFeedback(Q6()?.account, xg),
    available = host || (n && (e || (t && r)));
  return J1($, 0, available)
    ? K1($, 0, available, available ? tT(AZ, {}) : null)
    : $[1];`,
  },
  {
    file: modal,
    name: "existing-account-and-notice",
    before: 'import { Io as se, JE as ue,',
    after: 'import { Q6 as __claudexFeedbackAccount, Io as se, JE as ue,',
  },
  {
    file: modal,
    name: "account-bound-host-form",
    before: '    ve = Se(),',
    after: '    __hostTextFeedback = __claudexCanSendProductFeedback(__claudexFeedbackAccount()?.account, ie),\n    ve = Se(),',
  },
  {
    file: modal,
    name: "omit-host-session-association",
    before: '    T = C(Re),',
    after: '    __selectedTask = C(Re),\n    T = __hostTextFeedback ? null : __selectedTask,',
  },
  {
    file: modal,
    name: "omit-host-task-list",
    before: '    Et = Tt || Ct,',
    after: '    Et = !__hostTextFeedback && (Tt || Ct),',
  },
  {
    file: modal,
    name: "omit-host-system-info",
    before: '                    ie\n                      ?.getSystemInfo?.()',
    after: '                    !__hostTextFeedback && ie\n                      ?.getSystemInfo?.()',
  },
  {
    file: modal,
    name: "omit-host-bundle",
    before: `                                r = e && N && K ? K : void 0,`,
    after: `                                r = !__hostTextFeedback && e && N && K ? K : void 0,`,
  },
  {
    file: modal,
    name: "submit-authored-fields",
    before: `                                  sessionId: r,
                                  model: q?.model,
                                  includeLogs: e,
                                  includeTranscript: !!r,
                                  source: w,`,
    after: `                                  ...(__hostTextFeedback ? {} : {
                                    sessionId: r,
                                    model: q?.model,
                                    includeLogs: e,
                                    includeTranscript: !!r,
                                    source: w,
                                  }),`,
  },
  {
    file: modal,
    name: "describe-text-only-consent-in-form",
    before: '      ce = J5($, 206, fe, M, N, y, W, K, G, At, x, rt, P, _t, gt)',
    after: '      ce = __hostTextFeedback ? null : J5($, 206, fe, M, N, y, W, K, G, At, x, rt, P, _t, gt)',
  },
  {
    file: modal,
    name: "show-consent-before-submitting-any-category",
    before: `    wn = J3($, 231, yn, bn, Cn)
      ? K3(
          $,
          231,
          yn,
          bn,
          Cn,
          r("div", { className: "flex flex-col gap-lg", children: [yn, bn, Cn] }),
        )
      : $[234],`,
    after: `    wn = __hostTextFeedback && Z && !Y && (H === "details" || (!B && J && !!j))
      ? r("div", { className: "flex flex-col gap-lg", children: [yn, bn, s("p", {
          className: "text-footnote text-secondary",
          children: __claudexFeedbackNotice(y),
        }), Cn] })
      : J3($, 231, yn, bn, Cn)
        ? K3($, 231, yn, bn, Cn,
            r("div", { className: "flex flex-col gap-lg", children: [yn, bn, Cn] }),
          )
        : $[234],`,
  },
  {
    file: hub,
    name: "claudex-account-uses-product-feedback",
    before: '  return e?.email_address?.toLowerCase().endsWith("@anthropic.com") ?? !1;',
    after: `  return !(${hostAuthenticatedExpression}) && (e?.email_address?.toLowerCase().endsWith("@anthropic.com") ?? !1);`,
  },
  {
    file: modal,
    name: "original-modal-unknown-inline",
    before: "    else if (u?.unavailableReason) l(u.unavailableReason);",
    after:
      "    else if (__claudexFeedbackUnknown(u)) l(__claudexFeedbackUnknownText(d));\n    else if (u?.unavailableReason) l(u.unavailableReason);",
  },
  {
    file: hub,
    name: "original-hub-preserves-unknown",
    before:
      '        : c && (c.isZdrOrg || c.unavailableReason || c.failureReason === "auth_error" || !Iy(c))',
    after:
      '        : __claudexFeedbackUnknown(c)\n          ? ((r = "claudex_delivery_unknown"), (i = "unconfirmed"))\n        : c && (c.isZdrOrg || c.unavailableReason || c.failureReason === "auth_error" || !Iy(c))',
  },
  {
    file: hub,
    name: "original-hub-unknown-toast",
    before:
      '          C(b.formatMessage(t === "denied" ? IX.deniedNotice : IX.toastFailed), {',
    after:
      '          C(t === "claudex_delivery_unknown" ? __claudexFeedbackUnknownText(b) : b.formatMessage(t === "denied" ? IX.deniedNotice : IX.toastFailed), {',
  },
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function deriveOfficialUiHostFeedbackOutcomeModule(file, source) {
  if (!Object.hasOwn(hostFeedbackOutcomeInputHashes, file)) return source;
  if (sha(source) !== hostFeedbackOutcomeInputHashes[file])
    throw Error("Pinned feedback outcome input mismatch: " + file);
  let output = source;
  for (const rule of hostFeedbackOutcomeRules.filter((r) => r.file === file)) {
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error("Pinned feedback outcome anchor mismatch: " + rule.name);
    output =
      output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
  }
  return (helpers[file] ?? "") + output;
}
export function applyOfficialUiHostFeedbackOutcome(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const rows = Object.keys(hostFeedbackOutcomeInputHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Feedback outcome symlink rejected");
    const input = fs.readFileSync(location, "utf8");
    return {
      file,
      location,
      input,
      output: deriveOfficialUiHostFeedbackOutcomeModule(file, input),
    };
  });
  for (const row of rows) fs.writeFileSync(row.location, row.output);
  return {
    revision: hostFeedbackOutcomeRevision,
    modules: rows.map((row) => ({
      file: row.file,
      originalSha256: hostFeedbackOutcomeOriginalHashes[row.file],
      inputSha256: sha(row.input),
      outputSha256: sha(row.output),
      rules: hostFeedbackOutcomeRules
        .filter((r) => r.file === row.file)
        .map((r) => r.name),
    })),
  };
}
