/** Native local Code navigation capability; not a vendor tier or execution grant. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hostAuthenticatedExpression} from './official-ui-host-auth.mjs';
export const hostCodeCapabilityRevision='claudex-local-code-navigation-v2';
export const hostCodeCapabilityOriginalHashes={
 'shared-l-p-m-w-3-B5uNmf7O.js':'2052eb58a33ac91bb67bcbc2f56e545cdd8924410460a1aed9672150ee8259f8',
 'c56477982-BKCIDeJR.js':'e6c7ba4058da98e24ae66919ecc0a65b4b7b4a5df28a6ee3af4154fc19bd88b5',
 'cd2efac6e-DHz2EyWB.js':'016e72c5a33793f0d84bb9423296750145bfc81a0ace9e1e4450fafbe83e1993',
};
export const hostCodeCapabilityInputHashes={
 'shared-l-p-m-w-3-B5uNmf7O.js':'c2e4242c46fc128658b0cec1687dea2205af240ffe0d3198f1672d201bc9ceb6',
 'c56477982-BKCIDeJR.js':'5dc411491b39b6b450b0731ea5a674c6ad692af198dc54aeaf8721ece6b3334e',
 'cd2efac6e-DHz2EyWB.js':'03c2206b29b2f0b88c5c119785d31325349b7233ca64e145e0923e175cc63b12',
};
export const hostCodeCapabilitySource=`function __claudexLocalCodeNavigation(e, organization) {
 const capability = e?.claudex_local_code;
 return ${hostAuthenticatedExpression} && typeof organization?.uuid === "string" && organization.uuid.length > 0 && capability?.version === 1 && capability.available === true && capability.account_uuid === e.uuid && capability.organization_uuid === organization.uuid;
}\n`;
export const hostCodeCapabilityRules=[
 {file:'shared-l-p-m-w-3-B5uNmf7O.js',name:'local-code-account-context',
 before:'function aX() {\n  let $ = J9(25),\n    e = l9(),\n    t = xG(),\n    { activeOrganization: n, isLoading: r } = LO(),',
 after:'function aX() {\n  let $ = J9(25),\n    e = l9(),\n    t = xG(),\n    { account: __claudexCodeAccount, activeOrganization: n, isLoading: r } = LO(),\n    __claudexCodeOrganization = n,'},
 {file:'shared-l-p-m-w-3-B5uNmf7O.js',name:'local-code-navigation-not-vendor-tier',
 before:'    if (!e) {\n      l = J2($, 21, t, r)\n        ? K2($, 21, t, r, t ? r("no_entitlement") : n("upgrade_required"))',
 after:'    if (!e && !__claudexLocalCodeNavigation(__claudexCodeAccount, __claudexCodeOrganization)) {\n      l = J2($, 21, t, r)\n        ? K2($, 21, t, r, t ? r("no_entitlement") : n("upgrade_required"))'},
 {file:'c56477982-BKCIDeJR.js',name:'local-code-workspace-document-reader',
  before:'    L = P === null ? null : I,',
  after:'    L = localSessionId ?? (P === null ? null : I),',
 },
 {file:'c56477982-BKCIDeJR.js',name:'local-code-workspace-reader-capability',
  before:'function I(a, o) {',
  after:'function I(a, o, localSessionId) {',
 },
 {file:'c56477982-BKCIDeJR.js',name:'local-code-workspace-document-availability',
  before:`    H = J2($, 0, R, P)
      ? K2(
          $,
          0,
          R,
          P,
          (e, t) =>
            P !== null && j(e) && !p(l(e)) && !m(e) && !(R && v(e)) && (t === void 0 || t <= T),`,
  after:`    reader = P ?? localSessionId ?? null,
    H = J2($, 0, R, reader)
      ? K2(
          $,
          0,
          R,
          reader,
          (e, t) =>
            reader !== null && j(e) && !p(l(e)) && !m(e) && !(R && v(e)) && (t === void 0 || t <= T),`,
 },
 {file:'cd2efac6e-DHz2EyWB.js',name:'local-code-workspace-download-menu',
  before:'    kp = Op || z,',
  after:'    localWorkspaceDownload = I?.type === "local" && I.id.startsWith("local_") && typeof we?.readSessionPanelDocumentWithStatus === "function",\n    kp = Op || z || localWorkspaceDownload,',
 },
 {file:'cd2efac6e-DHz2EyWB.js',name:'local-code-workspace-download-action',
  before:'  let Zg = Ga("pane", Op),',
  after:'  let Zg = Ga("pane", Op, localWorkspaceDownload ? I.id : void 0),',
 },
 {file:'cd2efac6e-DHz2EyWB.js',name:'local-code-download-ready-without-preview',
  before:'    n_ = !z && Hm && t_ && (!Vc || cm instanceof ArrayBuffer),',
  after:`    n_ = !z && (localWorkspaceDownload
      ? t_ || (Y?.inSessionFolders !== !1 && Zg.canReadAsText(r, Y?.fileSize ?? Infinity))
      : Hm && t_ && (!Vc || cm instanceof ArrayBuffer)),`,
 },
];
const sha=s=>createHash('sha256').update(s).digest('hex');
export function deriveOfficialUiHostCodeCapabilityModule(file,source){
 if(!Object.hasOwn(hostCodeCapabilityInputHashes,file))return source;
 if(sha(source)!==hostCodeCapabilityInputHashes[file])throw Error('Pinned local Code capability input mismatch: '+file);
 let result=source;
 for(const rule of hostCodeCapabilityRules.filter(r=>r.file===file)){
  const at=result.indexOf(rule.before);
  if(at<0||result.indexOf(rule.before,at+rule.before.length)>=0)throw Error('Pinned local Code capability anchor mismatch: '+rule.name);
  result=result.slice(0,at)+rule.after+result.slice(at+rule.before.length);
 }
 return file==='shared-l-p-m-w-3-B5uNmf7O.js' ? hostCodeCapabilitySource+result : result;
}
export function applyOfficialUiHostCodeCapability(directory){
 directory=fs.realpathSync(directory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered sources are immutable');
 const rows=Object.keys(hostCodeCapabilityInputHashes).map(file=>{const location=path.join(directory,file);if(fs.lstatSync(location).isSymbolicLink())throw Error('Code capability output symlink rejected');const source=fs.readFileSync(location,'utf8');return{file,location,source,output:deriveOfficialUiHostCodeCapabilityModule(file,source)}});
 for(const row of rows)fs.writeFileSync(row.location,row.output);
 return{revision:hostCodeCapabilityRevision,modules:rows.map(r=>({file:r.file,originalSha256:hostCodeCapabilityOriginalHashes[r.file],inputSha256:sha(r.source),outputSha256:sha(r.output),rules:hostCodeCapabilityRules.filter(x=>x.file===r.file).map(x=>x.name)}))};
}
