/** Settle a refused Stop using the original control state and error toast. */
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const stopFeedbackRevision='original-stop-feedback-v1';
export const stopFeedbackMain='f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js';
export const stopFeedbackHub='30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js';
export const stopFeedbackInputs={
 [stopFeedbackMain]:'9a877653b06d3c21494faeffcdb954a9688a812655426aa3b5119dfa81153c3c',
 [stopFeedbackHub]:'87194090ced9e671d94d8b6dece3bf02e344e23b4f970447ec172c0a6e3ed781',
};
export const stopFeedbackRules={
 [stopFeedbackMain]:{
  before:`          if (e === "nothing_running") {
            (V(!1), G(!1));`,
  after:`          if (e === "refused") (V(!1), G(!1));
          if (e === "nothing_running") {
            (V(!1), G(!1));`,
 },
 [stopFeedbackHub]:{
  before:`        o.version !== void 0 && TZ(R, o.version, "refused");`,
  after:`        if (o.version !== void 0 && !o.foreign && !o.local && !o.superseded &&
            o.failure.action === "stop_generation" && o.failure.error !== void 0 &&
            R.pendingStop.current === o.version) {
          for (let e of R.actionRefusedCbs) e({
            action: o.failure.action,
            displayMessage: o.failure.error.displayMessage,
            retryable: o.failure.error.retryable,
          });
        }
        o.version !== void 0 && TZ(R, o.version, "refused");`,
 },
};
const sha=s=>createHash('sha256').update(s).digest('hex');
export function deriveOfficialStopFeedbackModule(file,source){
 if(!Object.hasOwn(stopFeedbackInputs,file))return source;
 if(typeof source!=='string'||sha(source)!==stopFeedbackInputs[file])throw Error('Stop feedback pinned input mismatch');
 const r=stopFeedbackRules[file];if(source.split(r.before).length!==2)throw Error('Stop feedback anchor mismatch');
 return source.replace(r.before,r.after);
}
const manifestFor=outputs=>({revision:stopFeedbackRevision,modules:Object.entries(stopFeedbackInputs).map(([file,inputSha256])=>({file,inputSha256,outputSha256:outputs[file]}))});
export function applyOfficialStopFeedback(directory){
 const resolved=path.resolve(directory);
 if(fs.realpathSync(resolved)!==resolved||resolved.split(path.sep).includes('.restore'))throw Error('Stop feedback requires an explicit unlinked assembly output');
 // Validate and derive both modules before writing either one.
 const prepared=Object.keys(stopFeedbackInputs).map(name=>{
  const file=path.join(resolved,name);if(fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile())throw Error('Stop feedback requires unlinked module files');
  return {name,file,value:deriveOfficialStopFeedbackModule(name,fs.readFileSync(file,'utf8'))};
 });
 const outputs={};for(const item of prepared){fs.writeFileSync(item.file,item.value);outputs[item.name]=sha(item.value);}
 return manifestFor(outputs);
}
export function verifyOfficialStopFeedbackManifest(manifest,files,outputs){
 if(Object.keys(stopFeedbackInputs).some(name=>!/^[a-f0-9]{64}$/.test(outputs?.[name]??''))||JSON.stringify(manifest)!==JSON.stringify(manifestFor(outputs)))throw Error('Stop feedback manifest mismatch');
 for(const name of Object.keys(stopFeedbackInputs)){const rows=files.filter(r=>r.path==='assets/v1/'+name);if(rows.length!==1||rows[0].sha256!==outputs[name])throw Error('Stop feedback output mismatch');}
}
