import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {hostAuthenticatedExpression} from './official-ui-host-auth.mjs';
import {hostFeedbackNotice, hostWebFeedbackBridge} from './official-ui-host-feedback-outcome.mjs';
export const hostCodeFeedbackRevision='claudex-code-text-feedback-v4';
export const hostCodeFeedbackInputHashes={
 'ce737b2ad-MYUn7nWz.js':'4e73da481c827a9f29d80b9316e78069080ad4a685bfae0e36f206a71601be9d',
 'cef1e6037-DIC2zPYg.js':'892b640c3293b908fcade9ee420fe1ccf879c826e1ed720458d54ec021371408'};
export const hostCodeFeedbackOriginalHashes={
 'ce737b2ad-MYUn7nWz.js':'674c9d6bdd793672cc43d6fba15921eb329a09c4a36e85d66487ea89209aea32',
 'cef1e6037-DIC2zPYg.js':'892b640c3293b908fcade9ee420fe1ccf879c826e1ed720458d54ec021371408'};
export const hostCodeFeedbackHelper=hostFeedbackNotice+hostWebFeedbackBridge+`function __claudexCodeTextFeedback(e, session, survey, channel) {
 if (!(${hostAuthenticatedExpression}) || !session?.id || survey !== undefined || channel !== undefined)
   return null;
 if (session.type === "local") return "native";
 if (session.type === "remote") return typeof __claudexWebFeedbackBridge()?.submitCode === "function" ? "web" : "unavailable";
 return null;
}
` + `function __claudexCodeFeedbackUnknown(intl) {
 return /^zh(?:-|$)/i.test(intl.locale ?? "") ? "无法确认反馈是否已发送，请勿重复提交。" : "Couldn’t confirm whether your feedback was sent. Please don’t submit it again.";
}
`;
const [modal,transport]=Object.keys(hostCodeFeedbackInputHashes);
export const hostCodeFeedbackRules=[
 {file:modal,name:'existing-account-hook',before:'import { CF as ue, Io as v, vN as _ }',after:'import { Q6 as __claudexFeedbackAccount, CF as ue, Io as v, vN as _ }'},
 {file:modal,name:'host-bound-ordinary-form',before:'  let $ = J9(155),',after:'  let $ = J9(157),'},
 {file:modal,name:'host-form-identity',before:'    E = y === void 0 ? "" : y,',after:'    __hostTextFeedback = __claudexCodeTextFeedback(__claudexFeedbackAccount()?.account, _, w, C),\n    E = y === void 0 ? "" : y,'},
 {file:modal,name:'no-open-wake',before:'    M = !D && j != null && j.isArchived !== !0 && j.isShared !== !0,',after:'    M = !__hostTextFeedback && !D && j != null && j.isArchived !== !0 && j.isShared !== !0,'},
 {file:modal,name:'no-support-checkbox',before:'    P =\n      J4($, 4, N, Ue, D, j)',after:'    P = !__hostTextFeedback && (\n      J4($, 4, N, Ue, D, j)'},
 {file:modal,name:'close-checkbox-expression',before:'        : $[12],\n    [F, I]',after:'        : $[12]),\n    [F, I]'},
 {file:modal,name:'submit-memo-host-identity',before:'      J5($, 54, P, C, Be, Y, O, Ke, qe, k, D, L) ||',after:'      $[155] !== __hostTextFeedback || J5($, 54, P, C, Be, Y, O, Ke, qe, k, D, L) ||'},
 {file:modal,name:'select-web-transport-in-original-submit',before:'                      : n?.submitFeedback;',after:`                      : __hostTextFeedback === "web"
                        ? (sessionId, description, signal) => {
                            const bridge = __claudexWebFeedbackBridge();
                            return bridge ? bridge.submitCode(sessionId, description, signal) : { failureReason: "unavailable", statusCode: 503 };
                          }
                        : __hostTextFeedback === "unavailable" ? void 0 : n?.submitFeedback;`},
 {file:modal,name:'omit-vendor-preflight-for-web-submit',before:'                      checkRefusal: n?.feedbackRefusal,',after:'                      checkRefusal: __hostTextFeedback === "web" ? undefined : n?.feedbackRefusal,'},
 {file:modal,name:'submit-host-option',before:'                      sessionId: _.id,',after:'                      hostTextFeedback: __hostTextFeedback,\n                      sessionId: _.id,'},
 {file:modal,name:'no-submit-wake',before:'                      shouldWake: !D && j?.isArchived !== !0 && j?.isShared !== !0,',after:'                      shouldWake: !__hostTextFeedback && !D && j?.isArchived !== !0 && j?.isShared !== !0,'},
 {file:modal,name:'remember-submit-host-identity',before:'  let At = kt,',after:'  $[155] = __hostTextFeedback;\n  let At = kt,'},
 {file:modal,name:'notice-memo-host-identity',before:'    Lt = J5($, 93, P, C, Z, V, O, Ve, L, U, F, w)',after:'    Lt = ($[156] !== __hostTextFeedback || J5($, 93, P, C, Z, V, O, Ve, L, U, F, w))'},
 {file:modal,name:'same-paragraph-text-only-notice',before:'                      children: w\n                        ? i(ee,',after:'                      children: __hostTextFeedback ? __claudexFeedbackNotice(O) : w\n                        ? i(ee,'},
 {file:modal,name:'remember-notice-host-identity',before:'    Rt = J5($, 104, z, ct, R, T, Mt, ot, O, B, F)',after:'    __rememberHostNotice = ($[156] = __hostTextFeedback),\n    Rt = J5($, 104, z, ct, R, T, Mt, ot, O, B, F)'},
 {file:modal,name:'submit-option-argument',before:'async function Pe({\n  sessionId: t,',after:'async function Pe({\n  hostTextFeedback = false,\n  sessionId: t,'},
 {file:modal,name:'no-support-share-call',before:'  if (ee) {',after:'  if (ee && !hostTextFeedback) {'},
 {file:modal,name:'no-submit-wake-defense',before:'  o && s(t, { userInitiated: !0 });',after:'  !hostTextFeedback && o && s(t, { userInitiated: !0 });'},
 {file:modal,name:'text-only-transport-marker',before:'n(t, i, g.signal, { noFallback: ie, ...(ae !== void 0 && { channelMessageId: ae }) })',after:'n(t, i, g.signal, { noFallback: ie, ...(hostTextFeedback === "native" && { claudexTextOnlyFeedback: true }), ...(ae !== void 0 && { channelMessageId: ae }) })'},
 {file:modal,name:'existing-error-position-unknown',before:'    if (r?.unavailableReason) f(r.unavailableReason);',after:'    if (hostTextFeedback && r?.claudexProductFeedback === true && r?.deliveryState === "unknown" && !r?.feedbackId) f(__claudexCodeFeedbackUnknown(c));\n    else if (r?.unavailableReason) f(r.unavailableReason);'},
 {file:modal,name:'host-dispatched-exception-unknown',before:'  } catch (t) {\n    if (h !== l.current) return;\n    (S(',after:'  } catch (t) {\n    if (h !== l.current) return;\n    if (hostTextFeedback) { f(__claudexCodeFeedbackUnknown(c)); d("input"); return; }\n    (S('},
 {file:transport,name:'explicit-text-transport-no-warm',before:'    async submitFeedback(e, t, n) {\n      let r = a?.submitFeedback;',after:'    async submitFeedback(e, t, n, options) {\n      let r = a?.submitFeedback;\n      if (options?.claudexTextOnlyFeedback === true) {\n        if (n?.aborted) return { unavailableReason: "Cancelled." };\n        return r ? r(e, { claudexTextOnlyFeedback: true, description: t }) : { failureReason: "unavailable", statusCode: 501 };\n      }'},
];
const sha=s=>createHash('sha256').update(s).digest('hex');
export function deriveOfficialUiHostCodeFeedbackModule(file,source){
 if(!Object.hasOwn(hostCodeFeedbackInputHashes,file))return source;
 if(sha(source)!==hostCodeFeedbackInputHashes[file])throw Error('Pinned Code feedback input mismatch: '+file);
 let out=source;for(const rule of hostCodeFeedbackRules.filter(r=>r.file===file)){const at=out.indexOf(rule.before);if(at<0||out.indexOf(rule.before,at+rule.before.length)>=0)throw Error('Pinned Code feedback anchor mismatch: '+rule.name);out=out.slice(0,at)+rule.after+out.slice(at+rule.before.length);}
 return (file===modal?hostCodeFeedbackHelper:'')+out;
}
export function applyOfficialUiHostCodeFeedback(directory){directory=fs.realpathSync(directory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered sources are immutable');const rows=Object.keys(hostCodeFeedbackInputHashes).map(file=>{const location=path.join(directory,file);if(fs.lstatSync(location).isSymbolicLink())throw Error('Code feedback symlink rejected');const source=fs.readFileSync(location,'utf8');return{file,location,source,output:deriveOfficialUiHostCodeFeedbackModule(file,source)};});for(const row of rows)fs.writeFileSync(row.location,row.output);return{revision:hostCodeFeedbackRevision,modules:rows.map(row=>({file:row.file,originalSha256:hostCodeFeedbackOriginalHashes[row.file],inputSha256:sha(row.source),outputSha256:sha(row.output),rules:hostCodeFeedbackRules.filter(r=>r.file===row.file).map(r=>r.name)}))};}
