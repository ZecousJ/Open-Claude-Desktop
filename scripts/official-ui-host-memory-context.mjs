/** Preserve settings mode and expose account files only when the host can serve them. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const hostMemoryContextRevision = 'claudex-memory-context-v2';
export const hostMemoryContextInputHashes = {
  'shared-20-C2JgSgMH.js':'f71787e720158beb9c6c3da1375b02022548b89fc79ff970599f650cec9c583a',
  'c953053b7-DrQ3In9z.js':'baf29b627384c498f19c5f03e0a17c1ca73c40f8deab43c39f315540902f4e48',
};
export const hostMemoryContextOriginalHashes = {
  'shared-20-C2JgSgMH.js':'5079a46295b93a1bcb76333a1e52709e1c448f4ea744774b5c5655f22ab118e0',
  'c953053b7-DrQ3In9z.js':'8082b9a3b939a2e2ed8eff99b1cc62d62212c414b5ed3d255db0f3508a8194e9',
};
export const hostMemoryContextRules = [
 {file:'c953053b7-DrQ3In9z.js',name:'consume-hosted-memory-readiness',before:'  bo as a,\n  qa as o,',after:'  bo as a,\n  po as __claudexUseMemoryReady,\n  qa as o,'},
 {file:'c953053b7-DrQ3In9z.js',name:'hosted-file-placement',before:'    } = it(n),',after:'    } = it(effectivePlacement),'},
 {file:'shared-20-C2JgSgMH.js', name:'settings-selected-mode',
  before:'node: It(B.SettingsModalContent, {\n                    section: P,\n                    onSubpage: R,\n                    subPortalEl: Ne,\n                    hideHeaderRow: Ve,\n                    popupScrolls: O,\n                    simpleEntries: d,\n                  }),',
  after:'node: It(__claudexSettingsMode, {component:B.SettingsModalContent, contentProps:{\n                    section: P,\n                    onSubpage: R,\n                    subPortalEl: Ne,\n                    hideHeaderRow: Ve,\n                    popupScrolls: O,\n                    simpleEntries: d,\n                  }}),'},
 {file:'c953053b7-DrQ3In9z.js',name:'account-file-panel-host-capability',
  before:'    a = P(),\n    s = j(),\n    {\n      memories: c,',
  after:'    a = P(),\n    hostedMemoryProbe = a && window.__claudexHostedCoworkMemoryReady,\n    hostedMemoryReady = hostedMemoryProbe ? __claudexUseMemoryReady(hostedMemoryProbe) : false,\n    effectivePlacement = hostedMemoryReady ? "sessionHost" : n,\n    memoryState = ie(),\n    s = j() || (a && memoryState.memoryOn && ((effectivePlacement === "device" && !!globalThis["claude.web"]?.CoworkMemory?.listAccountMemories && !!globalThis["claude.web"]?.CoworkMemory?.writeAccountMemory && !!globalThis["claude.web"]?.CoworkMemory?.deleteAccountMemory) || (effectivePlacement === "sessionHost" && hostedMemoryReady))),\n    {\n      memories: c,'},
];
const sha = s => createHash('sha256').update(s).digest('hex');
export function deriveOfficialUiHostMemoryContextModule(name, source) {
 if (!Object.hasOwn(hostMemoryContextInputHashes,name)) return source;
 if (sha(source)!==hostMemoryContextInputHashes[name]) throw Error('Pinned memory context checksum mismatch: '+name);
 let output=source;
 for (const rule of hostMemoryContextRules.filter(r=>r.file===name)) {
  const at=output.indexOf(rule.before);
  if(at<0||output.indexOf(rule.before,at+rule.before.length)!==-1) throw Error('Pinned memory context anchor mismatch: '+rule.name);
  output=output.slice(0,at)+rule.after+output.slice(at+rule.before.length);
 }
 if(name==='shared-20-C2JgSgMH.js') output='import {Uf as __claudexModeContext} from "./shared-1-B16QIYNI.js";\nimport {kY as __claudexSelectedMode} from "./shared-m-4-CbJwwS_m.js";\n'+output+'\nfunction __claudexSettingsMode({component,contentProps}) {const {selectedMode}=__claudexSelectedMode(); return It(__claudexModeContext.Provider,{value:selectedMode,children:It(component,contentProps)});}\n';
 return output;
}
export function applyOfficialUiHostMemoryContext(directory) {
 directory=fs.realpathSync(directory);
 if(directory.split(path.sep).includes('.restore')) throw Error('Recovered sources are immutable');
 const rows=Object.keys(hostMemoryContextInputHashes).map(file=>{
  const target=path.join(directory,file); if(fs.lstatSync(target).isSymbolicLink()) throw Error('Symlink output rejected');
  const input=fs.readFileSync(target,'utf8');return {file,target,input,output:deriveOfficialUiHostMemoryContextModule(file,input)};
 });
 for(const row of rows) fs.writeFileSync(row.target,row.output);
 return {revision:hostMemoryContextRevision,modules:rows.map(row=>({file:row.file,originalSha256:hostMemoryContextOriginalHashes[row.file],inputSha256:sha(row.input),outputSha256:sha(row.output),rules:hostMemoryContextRules.filter(rule=>rule.file===row.file).map(rule=>rule.name)}))};
}
