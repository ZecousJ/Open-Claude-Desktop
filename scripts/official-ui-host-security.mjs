/** Exact account-security error presentation; recovered modules stay immutable. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const hostSecurityRevision = 'claudex-security-unavailable-v2';
export const hostSecurityInputHashes = {
  'c71860c77-pnODXvGc.js': '990ff5bc3819e691953c622c3da3127cdd1019e5cfa0c409a7b1e74ec536f13f',
};
export const hostSecurityOriginalHashes = {
  'c71860c77-pnODXvGc.js': '42c4eae304e7a92ec748e90c331cbb1fb8445d1aa209561eb6f33a4011c904a1',
};
export const securityEligibilityExplanation = 'Claudex cannot verify account deletion eligibility in this interface. No account has been deleted. Return to Settings and retry, or close this page.';
export const mfaUnavailableBefore = '  if (!r && !he(a)) return null;';
export const mfaUnavailableAfter = `  if (!r && he(a)) {
    const zh = String(t.locale).toLowerCase().startsWith("zh");
    return u(G, {
      id: "two-factor-authentication",
      title: zh ? "多因素认证" : "Multi-factor authentication",
      description: zh ? "此界面无法读取 Claudex 的多因素认证设置，不代表你的账号未启用认证。现有安全设置未改变。请返回设置后重试，或关闭此页面。" : "Claudex multi-factor authentication settings cannot be read in this interface. This does not mean authentication is disabled. Existing security settings are unchanged. Return to Settings and retry, or close this page.",
      children: null,
    });
  }
  if (!r && !he(a)) return null;`;
export const hostSecurityRules = [{
  file: 'c71860c77-pnODXvGc.js',
  name: 'host-mfa-unavailable-visible-explanation',
  before: mfaUnavailableBefore,
  after: mfaUnavailableAfter,
},{
  file: 'c71860c77-pnODXvGc.js',
  name: 'host-deletion-eligibility-unavailable',
  before: '    A = !_ && g.isSuccess && !g.data?.deletable ? g.data?.display_message : void 0,',
  after: '    A = !_ && g.isSuccess && !g.data?.deletable ? g.data?.display_message : g.error?.errorCode === "account_deletion_eligibility_unavailable" ? '+JSON.stringify(securityEligibilityExplanation)+' : void 0,',
}];
const sha = value => createHash('sha256').update(value).digest('hex');
export function deriveOfficialUiHostSecurityModule(name, source) {
  if (!Object.hasOwn(hostSecurityInputHashes,name)) return source;
  if (sha(source)!==hostSecurityInputHashes[name]) throw Error('Pinned host security checksum mismatch: '+name);
  let output=source;
  for(const rule of hostSecurityRules.filter(rule=>rule.file===name)) {
    const at=output.indexOf(rule.before);
    if(at<0 || output.indexOf(rule.before,at+rule.before.length)!==-1) throw Error('Pinned host security anchor mismatch: '+rule.name);
    output=output.slice(0,at)+rule.after+output.slice(at+rule.before.length);
  }
  return output;
}
export function applyOfficialUiHostSecurity(directory) {
  directory=fs.realpathSync(directory);
  if(directory.split(path.sep).includes('.restore')) throw Error('Recovered sources are immutable');
  const rows=Object.keys(hostSecurityInputHashes).map(file=>{
    const target=path.join(directory,file);
    if(fs.lstatSync(target).isSymbolicLink()) throw Error('Symlink output rejected');
    const input=fs.readFileSync(target,'utf8');
    return {file,target,input,output:deriveOfficialUiHostSecurityModule(file,input)};
  });
  for(const row of rows) fs.writeFileSync(row.target,row.output);
  return {revision:hostSecurityRevision,modules:rows.map(row=>({file:row.file,originalSha256:hostSecurityOriginalHashes[row.file],inputSha256:sha(row.input),outputSha256:sha(row.output),rules:hostSecurityRules.filter(rule=>rule.file===row.file).map(rule=>rule.name)}))};
}
