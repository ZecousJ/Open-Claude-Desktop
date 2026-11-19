/** Pure derivation plus explicit assembly-output application; archives and flags remain unchanged. */
import {createHash} from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';
export const chatStarReconcileRevision='original-chat-star-infinite-reconcile-v2';
export const chatStarReconcileTarget='f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js';
export const chatStarReconcileInputHashes=Object.freeze({
 [chatStarReconcileTarget]:'dffc7c14786b7d86458e7ac86ed3e33ce9d322fe6063fc4e61de385df0381476',
 'shared-m-1-Nm0kn4Ee.js':'35709256161ff9ce70f2c06409e7409be97ec3d244a105be9a3af44c53e8df63',
 'shared-l-p-m-w-0-C_nAiu5o.js':'e715632eecebd51dbb739ec04e49ab87648d3a2aaeb31fc543ed0d58e0b8fded',
 'vendor-query-CdfkcLg6.js':'ed628c805205ec48fedc2fb9169aba2649c4022e9abeacff3b838635b0abd764',
});
export const chatStarReconcileOriginalHashes=Object.freeze({
 [chatStarReconcileTarget]:'06181192d0913e979ee2bd32ad3d83219e49ab69517b3d6e0931f1bf97224df2',
 'shared-m-1-Nm0kn4Ee.js':'885e84da6a4a4c2e10be0081d2e75e6479cb774d0c74a945c98c2ccf26741381',
 'shared-l-p-m-w-0-C_nAiu5o.js':'5c684e05b8c5804f72fbc4e2e10bc09ec98d7053974d632cd5718c9383c8ed24',
 'vendor-query-CdfkcLg6.js':'ed628c805205ec48fedc2fb9169aba2649c4022e9abeacff3b838635b0abd764',
});
export const chatStarReconcileBefore='(e.action === "star_conversation" && BP && oo(BP, br), e.modelCannotTake && jP(e.model));';
export const chatStarReconcileAfter='(e.action === "star_conversation" && BP && (oo(BP, br), typeof br === "string" && br.length > 0 && void BP.invalidateQueries({ queryKey: [claudexChatStarListKey, { orgUuid: br }, "infinite"], predicate: query => query.queryKey[1]?.orgUuid === br }).catch(() => {})), e.modelCannotTake && jP(e.model));';
const sha=s=>createHash('sha256').update(s).digest('hex');
function once(source,needle){const i=source.indexOf(needle);if(i<0||source.indexOf(needle,i+needle.length)>=0)throw Error('Chat star reconcile anchor mismatch');}
export function deriveOfficialChatStarReconcile(sources){
 for(const [file,hash] of Object.entries(chatStarReconcileInputHashes))if(typeof sources[file]!=='string'||sha(sources[file])!==hash)throw Error('Chat star reconcile pinned input mismatch: '+file);
 return deriveOfficialChatStarReconcileModule(chatStarReconcileTarget,sources[chatStarReconcileTarget]);
}
export function deriveOfficialChatStarReconcileModule(file,source){
 if(!Object.hasOwn(chatStarReconcileInputHashes,file))return source;
 if(typeof source!=='string'||sha(source)!==chatStarReconcileInputHashes[file])throw Error('Chat star reconcile pinned input mismatch: '+file);
 if(file!==chatStarReconcileTarget)return source;
 for(const anchor of [chatStarReconcileBefore,'  yS as Ht,','  Sq as oo,','  ko as Io,'])once(source,anchor);
 if(source.includes("claudexChatStarListKey"))throw Error("Chat star alias already bound");
 return source.replace("  yS as Ht,", "  yS as Ht,\n  yS as claudexChatStarListKey,").replace(chatStarReconcileBefore,chatStarReconcileAfter);
}

function manifestFor(outputSha256){return {revision:chatStarReconcileRevision,dependencies:Object.keys(chatStarReconcileInputHashes).map(file=>({file,originalSha256:chatStarReconcileOriginalHashes[file],inputSha256:chatStarReconcileInputHashes[file]})),modules:[{file:chatStarReconcileTarget,originalSha256:chatStarReconcileOriginalHashes[chatStarReconcileTarget],inputSha256:chatStarReconcileInputHashes[chatStarReconcileTarget],outputSha256,rules:['original-star-refusal-refetch-existing-own-infinite-queries']}]};}
export function applyOfficialChatStarReconcile(directory){
 const resolved=path.resolve(directory);if(fs.realpathSync(resolved)!==resolved||resolved.split(path.sep).includes('.restore'))throw Error('Chat star reconcile requires an explicit unlinked assembly output');
 const sources=Object.fromEntries(Object.keys(chatStarReconcileInputHashes).map(file=>{const p=path.join(resolved,file);if(fs.realpathSync(p)!==p||!fs.lstatSync(p).isFile())throw Error('Linked/non-file chat star input');return [file,fs.readFileSync(p,'utf8')];}));
 const output=deriveOfficialChatStarReconcile(sources);fs.writeFileSync(path.join(resolved,chatStarReconcileTarget),output);return manifestFor(sha(output));
}
export function verifyOfficialChatStarReconcileManifest(manifest,files,expectedOutputSha256){
 if(!/^[a-f0-9]{64}$/.test(expectedOutputSha256??'')||JSON.stringify(manifest)!==JSON.stringify(manifestFor(expectedOutputSha256)))throw Error('Chat star reconcile manifest mismatch');
 for(const [file,input] of Object.entries(chatStarReconcileInputHashes)){const rows=files.filter(row=>row.path==='assets/v1/'+file);if(rows.length!==1||rows[0].sha256!==(file===chatStarReconcileTarget?expectedOutputSha256:input))throw Error('Chat star reconcile dependency mismatch: '+file);}
}
