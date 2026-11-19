/** Exact, presentation-only error mapping for the recovered side-chat consumer. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sideQuestionErrorRevision = 'claudex-side-question-error-v1';
export const sideQuestionErrorTarget = 'shared-100-CDJp2jvs.js';
export const sideQuestionErrorInputSha256 = '3d682c106dde49b83b678fb3a9c408d6dd0ce43eb2b0cf79ac4e065688287f10';
const sha = value => createHash('sha256').update(value).digest('hex');
const openBefore = '        throw f9({\n          status: e.status,';
const openAfter = '        const __claudexSideCode = __claudexSideQuestionErrorCode(e.status, t);\n        if (__claudexSideCode) throw Object.assign(new Error("Side question context unavailable"), { claudexSideQuestionCode: __claudexSideCode });\n' + openBefore;
const renderBefore = 'a.formatMessage({ defaultMessage: "Something went wrong", id: "JqiqNj0Ooi" }),';
const renderAfter = '__claudexSideQuestionErrorText(e, a),';
const imports = 'import { sideQuestionErrorCode as __claudexSideQuestionErrorCode, sideQuestionErrorText as __claudexSideQuestionErrorText } from "./claudex-host-side-question-error.js";\n';
export function deriveOfficialSideQuestionErrorModule(file, source) {
  if (file !== sideQuestionErrorTarget) return source;
  if (typeof source !== 'string' || sha(source) !== sideQuestionErrorInputSha256) throw Error('Pinned side-question error input mismatch');
  let out = source;
  for (const [before, after] of [[openBefore, openAfter], [renderBefore, renderAfter]]) {
    const i = out.indexOf(before);
    if (i < 0 || out.indexOf(before, i + before.length) >= 0) throw Error('Pinned side-question error anchor mismatch');
    out = out.slice(0, i) + after + out.slice(i + before.length);
  }
  return imports + out;
}
export function applyOfficialSideQuestionError(directory) {
  const root = fs.realpathSync(directory);
  if (root.split(path.sep).includes('.restore')) throw Error('Recovered sources are immutable');
  const file = path.join(root, sideQuestionErrorTarget);
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('Linked side-question module rejected');
  const input = fs.readFileSync(file, 'utf8'), output = deriveOfficialSideQuestionErrorModule(sideQuestionErrorTarget, input);
  fs.writeFileSync(file, output);
  const helper = 'shared/side-question-errors.mjs', bytes = fs.readFileSync(helper);
  fs.copyFileSync(helper, path.join(root, 'claudex-host-side-question-error.js'));
  return { revision: sideQuestionErrorRevision, modules: [{ file: sideQuestionErrorTarget, inputSha256: sha(input), outputSha256: sha(output) }], ownedFiles: [{ file: 'assets/v1/claudex-host-side-question-error.js', source: helper, sha256: sha(bytes) }] };
}
