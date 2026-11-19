/** Exact project creation and knowledge adaptations; original archive is immutable. */
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
export const hostProjectKnowledgeRevision='claudex-project-creation-knowledge-v6';
export const hostProjectKnowledgeInputHashes={'cdeaafbfc-Bs8B_xOb.js':'bfc7aff303165b1fee581819b12a8d88f645d3c38db7f4ccbb608025b0dd7146','c4a0274e5-Q8MvhwLz.js':'9601ea2b11b3c8d7cca2dd50e0e0899c7ab29497862dee023fac80a8f2c8c9a4','ca12e49f2-BafUhOMK.js':'ee0dfcbf7647832f90cc79b854ef28fbe1ba3639472f0a75486b01f95386d2ab'};
export const hostProjectKnowledgeOriginalHashes={'cdeaafbfc-Bs8B_xOb.js':'b818fa62839813fb6e08dc59b79e2bc099a480bc7d220f1286928aa15e32bb79','c4a0274e5-Q8MvhwLz.js':'7059d23ddead3990fe94633767f322c100664d3ea2dae4a2c8335449678e0614','ca12e49f2-BafUhOMK.js':'654152e0434f11e87d734d5febc9f1f8e534b89a56aedda8a081c2fb1d6cfb97'};
Object.assign(hostProjectKnowledgeInputHashes, {
  'ce4f555c7-B1ErilHU.js': '5e8bc04143ad421066a70595516d3653672347113e2892da2a8378ab3ecbe624',
  'c1b9abf13-BcRRTBWK.js': '10e7ada541b8fabac2aac27f249c39d5c65917652877ce5c5c2069d7d7c8f0e9',
});
Object.assign(hostProjectKnowledgeOriginalHashes, {
  'ce4f555c7-B1ErilHU.js': '6cab89871b2dbb27d465848578a203b92cd234a426e2b80b899e748c22b4894e',
  'c1b9abf13-BcRRTBWK.js': '7287156c045eba837792bac27bdca78614607676a47821bcaa2f4c91c96bf433',
});
export const hostProjectKnowledgeRules=[
 {file:'ce4f555c7-B1ErilHU.js',name:'remove-education-project-presets',before:'t = T("claude_ai_experience", "project_templates", De, Ee),',after:'t = De,'},
 {file:'ce4f555c7-B1ErilHU.js',name:'remove-education-project-schema',before:'var ye = n(() => t({ type: e(E), subtype: e(D), icon_type: i(), custom_instructions: i() }));\n',after:''},
 {file:'ce4f555c7-B1ErilHU.js',name:'remove-education-project-config-parser',before:'var Ee = n(() => r(ye)),\n  De = [];',after:'var De = [];'},
 {file:'ce4f555c7-B1ErilHU.js',name:'remove-education-project-config-import',before:'OeL as te, VIX as T, zh as w',after:'OeL as te, zh as w'},
 {file:'ce4f555c7-B1ErilHU.js',name:'remove-education-project-schema-import',before:'import { C as e, E as t, b as n, d as r, j as i } from "./vendor-zod-CPpenJrb.js";\n',after:''},
 {file:'c1b9abf13-BcRRTBWK.js',name:'use-normal-project-routing-for-old-links',before:'return e.has("projectStarter") || e.has("prefillName") || e.has("prefillDescription");',after:'return e.has("prefillName") || e.has("prefillDescription");'},
 {file:'c4a0274e5-Q8MvhwLz.js',name:'keep-prefills-on-old-project-links',before:'t = e.has("projectStarter") || !!F;',after:'t = !!F;'},
 {file:'c4a0274e5-Q8MvhwLz.js',name:'keep-prefill-updates-on-old-project-links',before:'Fe = I.has("projectStarter") || !!F,',after:'Fe = !!F,'},
 {file:'c4a0274e5-Q8MvhwLz.js',name:'project-create-form-operation-id',before:'                  subtype: W,\n                  is_private: !0,',after:'                  subtype: W,\n                  client_creation_id: crypto.randomUUID(),\n                  is_private: !0,'},
 {file:'cdeaafbfc-Bs8B_xOb.js',name:'knowledge-error-keeps-rail-visible',before:'      le = j || L !== 0,',after:'      le = j || L !== 0 || I.knowledgeReadFailed,'},
 {file:'cdeaafbfc-Bs8B_xOb.js',name:'knowledge-error-wrapper-start',before:'      Oe = J5($, 78, fe, we, Te, Ee, Z, Q)',after:'      Oe = __claudexKnowledgeError(I.knowledgeReadFailed,L,{projectUuid:t.uuid,organizationUuid:K,accountUuid:q}, J5($, 78, fe, we, Te, Ee, Z, Q)'},
 {file:'cdeaafbfc-Bs8B_xOb.js',name:'knowledge-error-wrapper-end',before:'        : $[84],\n      ke = J5($, 85, ue, B, me, u, V)',after:'        : $[84]),\n      ke = J5($, 85, ue, B, me, u, V)'},
 {file:'ca12e49f2-BafUhOMK.js',name:'project-file-preview-url',before:'    { activeOrganization: s } = S(),\n    c = J1($, 0, n.file_name) ? I1($, 0, M(n.file_name), n.file_name) : $[1],\n    l = s?.uuid,',after:`    { activeOrganization: s, claudexProjectWorkspace: workspace } = S(),
    c = J1($, 0, n.file_name) ? I1($, 0, M(n.file_name), n.file_name) : $[1],
    l = s?.uuid,
    contentsUrl = O(l, n.file_uuid),
    previewUrl = workspace && n.preview_url
      ? n.preview_url
      : /\\.xls$/i.test(n.file_name) ? contentsUrl.replace(/\\/contents$/, "/preview") : contentsUrl,`},
 {file:'ca12e49f2-BafUhOMK.js',name:'project-file-preview-query-key',before:'      J1($, 5, h) || J3($, 6, n.file_uuid, f, l)\n        ? I3($, 6, Z1($, 5, ["project-file-contents", l, n.file_uuid, h, f], h), n.file_uuid, f, l)',after:'      J1($, 5, h) || J3($, 6, previewUrl, f, l)\n        ? I3($, 6, Z1($, 5, ["project-file-contents", l, previewUrl, h, f], h), previewUrl, f, l)'},
 {file:'ca12e49f2-BafUhOMK.js',name:'project-file-preview-query-dependency',before:'      J1($, 10, h) || J4($, 11, n.file_uuid, f, l, u)',after:'      J1($, 10, h) || J4($, 11, previewUrl, f, l, u)'},
 {file:'ca12e49f2-BafUhOMK.js',name:'refresh-shared-project-file-preview',before:'{ queryKey: _, enabled: v, staleTime: 1 / 0, gcTime: 3e5, queryFn: y }',after:'{ queryKey: _, enabled: v, staleTime: workspace && n.preview_url ? 0 : 1 / 0, gcTime: 3e5, queryFn: y }'},
 {file:'ca12e49f2-BafUhOMK.js',name:'project-file-preview-query',before:'                  i = await u(O(l, n.file_uuid), { signal: r });',after:'                  i = await u(previewUrl, { signal: r });'},
 {file:'ca12e49f2-BafUhOMK.js',name:'project-file-preview-memo',before:'            n.file_uuid,\n            f,\n            l,\n            u,',after:'            previewUrl,\n            f,\n            l,\n            u,'},
 {file:'ca12e49f2-BafUhOMK.js',name:'project-file-preview-for-search',before:'export { pt as ProjectFilesDialog,',after:'export { Ft as ClaudexProjectFileContent, pt as ProjectFilesDialog,'},
];
const sha=x=>createHash('sha256').update(x).digest('hex');
export function deriveOfficialUiHostProjectKnowledgeModule(name,source){
 if(!Object.hasOwn(hostProjectKnowledgeInputHashes,name))return source;
 if(sha(source)!==hostProjectKnowledgeInputHashes[name])throw Error('Pinned project knowledge checksum mismatch: '+name);
 let output=source;
 for(const rule of hostProjectKnowledgeRules.filter(rule=>rule.file===name)){
  const at=output.indexOf(rule.before);
  if(at<0||output.indexOf(rule.before,at+rule.before.length)!==-1)throw Error('Pinned project knowledge anchor mismatch: '+rule.name);
  output=output.slice(0,at)+rule.after+output.slice(at+rule.before.length);
 }
 return name==='cdeaafbfc-Bs8B_xOb.js'?'import {withProjectKnowledgeError as __claudexKnowledgeError} from "./claudex-host-project-knowledge-error.js";\n'+output:output;
}
export function applyOfficialUiHostProjectKnowledge(directory){
 directory=fs.realpathSync(directory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered sources are immutable');
 const rows=Object.keys(hostProjectKnowledgeInputHashes).map(file=>{
  const target=path.join(directory,file);if(fs.lstatSync(target).isSymbolicLink())throw Error('Symlink output rejected');
  const input=fs.readFileSync(target,'utf8');return{file,target,input,output:deriveOfficialUiHostProjectKnowledgeModule(file,input)};
 });
 for(const row of rows)fs.writeFileSync(row.target,row.output);
 return{revision:hostProjectKnowledgeRevision,modules:rows.map(row=>({file:row.file,originalSha256:hostProjectKnowledgeOriginalHashes[row.file],inputSha256:sha(row.input),outputSha256:sha(row.output),rules:hostProjectKnowledgeRules.filter(rule=>rule.file===row.file).map(rule=>rule.name)}))};
}
