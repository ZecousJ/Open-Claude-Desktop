/** Exact memory switch guards only; original page exports and archive remain unchanged. */
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
export const hostMemoryStatusRevision='claudex-memory-status-v4';
export const hostMemoryStatusInputHashes={'c6bba3086-CUv0XRS9.js':'737194767865c8615406afe2125377c0fdca081595213354236f72af2fb80084'};
export const hostMemoryStatusOriginalHashes={'c6bba3086-CUv0XRS9.js':'853b7cb0b70d003e3e1b7f1813ca33f1eb4019b0bdc67afad25bc432d40a67ba'};
export const hostMemoryStatusRules=[
 {file:'c6bba3086-CUv0XRS9.js',name:'generation-mode-host-status',before:'l(w, {\n                    "aria-labelledby": t.labelId,',after:'l(__claudexMemoryMode, {control:w,\n                    "aria-labelledby": t.labelId,'},
 {file:'c6bba3086-CUv0XRS9.js',name:'generation-switch-host-status',before:'children: l(C, {\n                        "aria-labelledby": e.labelId,\n                        checked: u,',after:'children: l(__claudexMemorySwitch, {control:C,kind:"generate",\n                        "aria-labelledby": e.labelId,\n                        checked: u,'},
 {file:'c6bba3086-CUv0XRS9.js',name:'classic-generation-switch-host-status',before:'children: l(C, {\n                                      "aria-labelledby": e.labelId,\n                                      checked: M.isAvailable,',after:'children: l(__claudexMemorySwitch, {control:C,kind:"generate",\n                                      "aria-labelledby": e.labelId,\n                                      checked: M.isAvailable,'},
 {file:'c6bba3086-CUv0XRS9.js',name:'search-switch-host-status',before:'l(C, {\n                  "aria-labelledby": e.labelId,\n                  checked: s,',after:'l(__claudexMemorySwitch, {control:C,kind:"search",\n                  "aria-labelledby": e.labelId,\n                  checked: s,'},
];
const sha=x=>createHash('sha256').update(x).digest('hex');
export function deriveOfficialUiHostMemoryStatusModule(name,source){
 if(!Object.hasOwn(hostMemoryStatusInputHashes,name))return source;
 if(sha(source)!==hostMemoryStatusInputHashes[name])throw Error('Pinned memory status checksum mismatch: '+name);
 let output=source;
 for(const rule of hostMemoryStatusRules.filter(rule=>rule.file===name)){
  const at=output.indexOf(rule.before);
  if(at<0||output.indexOf(rule.before,at+rule.before.length)!==-1)throw Error('Pinned memory status anchor mismatch: '+rule.name);
  output=output.slice(0,at)+rule.after+output.slice(at+rule.before.length);
 }
 return 'import {HostMemorySwitch as __claudexMemorySwitch,HostMemoryMode as __claudexMemoryMode} from "./claudex-host-memory-status.js";\n'+output;
}
export function applyOfficialUiHostMemoryStatus(directory){
 directory=fs.realpathSync(directory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered sources are immutable');
 const rows=Object.keys(hostMemoryStatusInputHashes).map(file=>{
  const target=path.join(directory,file);if(fs.lstatSync(target).isSymbolicLink())throw Error('Symlink output rejected');
  const input=fs.readFileSync(target,'utf8');return{file,target,input,output:deriveOfficialUiHostMemoryStatusModule(file,input)};
 });
 for(const row of rows)fs.writeFileSync(row.target,row.output);
 return{revision:hostMemoryStatusRevision,modules:rows.map(row=>({file:row.file,originalSha256:hostMemoryStatusOriginalHashes[row.file],inputSha256:sha(row.input),outputSha256:sha(row.output),rules:hostMemoryStatusRules.filter(rule=>rule.file===row.file).map(rule=>rule.name)}))};
}
