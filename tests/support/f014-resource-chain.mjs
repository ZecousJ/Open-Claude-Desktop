/** Test-only in-memory inverse. Never writes assets or accepts unpinned final modules. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stopFeedbackInputs,stopFeedbackRules,deriveOfficialStopFeedbackModule} from '../../scripts/official-ui-stop-feedback.mjs';
import {legacyQuoteIdentityTarget,legacyQuoteIdentityInputSha256,deriveOfficialLegacyQuoteIdentityModule} from '../../scripts/official-ui-legacy-quote-identity.mjs';
const finalHashes={
 'f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js':'f379e7edf89c9e47f87b352769905a8fdac6ac8f45981fcee52d7ff350b6b62f',
 '30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js':'8b25253c958671c9a455199de55f3b3fe347156bd574438134c4aa0cbe05f9f9',
};
const sha=s=>createHash('sha256').update(s).digest('hex');
export function beforeF014Stop(name,source){
 if(name===legacyQuoteIdentityTarget&&sha(source)!==legacyQuoteIdentityInputSha256){
  const before='return At(e) || /^msg_[A-Za-z0-9_]{1,252}$/.test(e);';
  const after='return At(e) || /^msg_[A-Za-z0-9_]{1,252}$/.test(e) || (e.length <= 256 && /^[A-Za-z0-9_.:-]{1,245}:(?:user|assistant)$/.test(e));';
  if(source.split(after).length===2){
   const prior=source.replace(after,before);
   if(sha(prior)===legacyQuoteIdentityInputSha256){assert.equal(deriveOfficialLegacyQuoteIdentityModule(name,prior),source);source=prior;}
  }
 }
 if(!Object.hasOwn(finalHashes,name)||sha(source)!==finalHashes[name])return source;
 const r=stopFeedbackRules[name];assert.equal(source.split(r.after).length,2);
 const prior=source.replace(r.after,r.before);assert.equal(sha(prior),stopFeedbackInputs[name]);
 assert.equal(deriveOfficialStopFeedbackModule(name,prior),source);return prior;
}
