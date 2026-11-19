import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {deriveOfficialSideQuestionErrorModule, sideQuestionErrorTarget} from '../scripts/official-ui-side-question-error.mjs';
test('pinned side question consumer is modified only at the explicit error boundaries',()=>{
 const out=fs.readFileSync('build/official-ui/ui/assets/v1/'+sideQuestionErrorTarget,'utf8');
 assert.match(out,/claudexSideQuestionErrorCode\(e\.status, t\)/);
 assert.match(out,/claudexSideQuestionErrorText\(e, a\)/);
 assert.throws(()=>deriveOfficialSideQuestionErrorModule(sideQuestionErrorTarget,out));
 assert.equal(deriveOfficialSideQuestionErrorModule('other.js','unrelated'),'unrelated');
});
