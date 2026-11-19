/** Derive the original reply-feedback modal only in an assembled UI copy. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const replyFeedbackSettlementRevision = "original-reply-feedback-settlement-v1";
export const replyFeedbackSettlementTarget = "shared-6-abVJ5RR0.js";
export const replyFeedbackSettlementOriginalSha256 = "2262035dcd5b3f51140b56cece641eb9517238cfa9a97fe708738a72b2b911dd";
export const replyFeedbackSettlementInputSha256 = "d22ca35d8b9bff9b7eead810e66a3e3d96cf8c480dff5c3dab66b753cbbc36fd";
export const replyFeedbackSettlementOutputSha256 = "291b7ae82115c5e67022943db1423db67fc0151459d4b4e26427bd9475c28bf4";
export const replyFeedbackSettlementBefore = "if (((T.current = e), R && u)) {";
export const replyFeedbackSettlementAfter = "if (((T.current = e), R)) {";
export const replyFeedbackSettlementPrivacyStart = "children: fe\n                ? It(gZ, {";
export const replyFeedbackSettlementPrivacyEnd = ": It(T2, { learnMoreHref: Ae }),";
export const replyFeedbackSettlementPrivacyAfter = `children: It(gZ, {
                  id: "claudex.reply-feedback.privacy",
                  defaultMessage: /^zh(?:-|$)/i.test(b.locale ?? "")
                    ? "评分保存在你的账户中。仅在你已启用反馈共享且服务支持时发送反馈，不包含对话内容。"
                    : "Ratings are saved to your account. Feedback is shared only when you have enabled sharing and the service supports it. Conversation content is not included.",
                }),`;
export const replyFeedbackSettlementLifecycleRules = [
  { name: "request-generation", before: "    A = vD(!1),\n    j,", after: "    A = vD(!1),\n    __claudexFeedbackEpoch = vD(0),\n    j," },
  { name: "cancel-invalidates-pending", before: "          (O(sE), E());", after: "          (++__claudexFeedbackEpoch.current, T.current = void 0, O(EA), E());" },
  { name: "ignore-retired-settlement", before: `              let t = n.uuid;
              (O({ kind: "sending", messageUuid: t }),
                R(n, r, e || void 0, (e) => P(e, t)),`, after: `              let t = n.uuid, __claudexFeedbackRequest = ++__claudexFeedbackEpoch.current;
              (O({ kind: "sending", messageUuid: t }),
                R(n, r, e || void 0, (e) => A.current && __claudexFeedbackRequest === __claudexFeedbackEpoch.current ? P(e, t) : e.kind === "recorded"),` },
];
const sha = value => createHash("sha256").update(value).digest("hex");
function once(source, anchor, name) {
  if (source.split(anchor).length !== 2) throw Error("Reply feedback anchor mismatch: " + name);
}
export function deriveOfficialReplyFeedbackSettlementModule(file, source) {
  if (file !== replyFeedbackSettlementTarget) return source;
  if (typeof source !== "string" || sha(source) !== replyFeedbackSettlementInputSha256)
    throw Error("Pinned reply feedback input mismatch");
  once(source, replyFeedbackSettlementBefore, "submit");
  once(source, replyFeedbackSettlementPrivacyStart, "privacy start");
  once(source, replyFeedbackSettlementPrivacyEnd, "privacy end");
  const start = source.indexOf(replyFeedbackSettlementPrivacyStart);
  const end = source.indexOf(replyFeedbackSettlementPrivacyEnd, start);
  if (end < start) throw Error("Reply feedback privacy range mismatch");
  source = source.slice(0, start) + replyFeedbackSettlementPrivacyAfter + source.slice(end + replyFeedbackSettlementPrivacyEnd.length);
  source = source.replace(replyFeedbackSettlementBefore, replyFeedbackSettlementAfter);
  for (const { name, before, after } of replyFeedbackSettlementLifecycleRules) {
    once(source, before, name);
    source = source.replace(before, after);
  }
  if (sha(source) !== replyFeedbackSettlementOutputSha256) throw Error("Reply feedback output mismatch");
  return source;
}
function manifestFor() {
  return { revision: replyFeedbackSettlementRevision, modules: [{
    file: replyFeedbackSettlementTarget,
    originalSha256: replyFeedbackSettlementOriginalSha256,
    inputSha256: replyFeedbackSettlementInputSha256,
    outputSha256: replyFeedbackSettlementOutputSha256,
  }] };
}
export function applyOfficialReplyFeedbackSettlement(directory) {
  const resolved = path.resolve(directory);
  if (fs.realpathSync(resolved) !== resolved || resolved.split(path.sep).includes(".restore"))
    throw Error("Reply feedback requires an explicit unlinked assembly output");
  const file = path.join(resolved, replyFeedbackSettlementTarget);
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw Error("Linked/non-file reply feedback input");
  const output = deriveOfficialReplyFeedbackSettlementModule(replyFeedbackSettlementTarget, fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, output);
  return manifestFor();
}
export function verifyOfficialReplyFeedbackSettlementManifest(manifest, files, expectedOutputSha256) {
  if (expectedOutputSha256 !== replyFeedbackSettlementOutputSha256 || JSON.stringify(manifest) !== JSON.stringify(manifestFor()))
    throw Error("Reply feedback manifest mismatch");
  const rows = files.filter(row => row.path === "assets/v1/" + replyFeedbackSettlementTarget);
  if (rows.length !== 1 || rows[0].sha256 !== expectedOutputSha256) throw Error("Reply feedback output file mismatch");
}
