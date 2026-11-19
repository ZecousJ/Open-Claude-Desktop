import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {deriveOfficialUiHostAuthModule} from '../../scripts/official-ui-host-auth.mjs';
import {deriveOfficialUiHostCompletionModule} from '../../scripts/official-ui-host-completion.mjs';
import {brandedModule,verifyHostCodeDerivationSet} from '../../scripts/official-web-assets.mjs';
import {deriveOfficialUiHostCapabilityModule,hostCapabilityInputHashes,hostCapabilityOriginalHashes,hostCapabilityRules} from '../../scripts/official-ui-host-capabilities.mjs';
import {deriveOfficialUiHostCodeCapabilityModule,hostCodeCapabilityRevision} from '../../scripts/official-ui-host-code-capability.mjs';
import {deriveOfficialUiHostSkillSearchModule} from '../../scripts/official-ui-host-skill-search.mjs';
import {deriveOfficialUiHostInstalledPluginsModule} from '../../scripts/official-ui-host-installed-plugins.mjs';
import {deriveOfficialUiHostWorkspaceTrustModule,hostWorkspaceTrustRevision,hostWorkspaceTrustOriginalHashes,hostWorkspaceTrustInputHashes} from '../../scripts/official-ui-host-workspace-trust.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const sha=x=>createHash('sha256').update(x).digest('hex');
const current=()=>({hostDerivationSet:'claudex-host-workspace-trust-v1',hostWorkspaceTrust:{revision:hostWorkspaceTrustRevision},hostCodeCapability:{revision:hostCodeCapabilityRevision},hostAuth:{},hostCapabilities:{},hostInstalledPlugins:{},hostSkillSearch:{}});
const verifier=fs.readFileSync(path.join(root,'scripts/official-web-assets.mjs'),'utf8');
const start=verifier.indexOf('          const skillAware ='),end=verifier.indexOf('      const content = deriveOfficialWebAccountModule',start);
assert.ok(start>0&&end>start);
const tail='if(true){if(true){\n'+verifier.slice(start,end);
function bytesCheck(meta,name,input,bytes){verifyHostCodeDerivationSet(meta);vm.runInNewContext(tail,{meta,name,pluginAware:input,bytes:Buffer.from(bytes),expected:null,relative:'assets/v1/'+name,Buffer,options:{},desktopSessionExport:null,deriveOfficialUiHostCodeCapabilityModule,deriveOfficialUiHostSkillSearchModule,deriveOfficialUiHostWorkspaceTrustModule});}
const inputs=Object.keys(hostWorkspaceTrustOriginalHashes).map(name=>{const raw=fs.readFileSync(path.join(root,'.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1',name),'utf8');assert.equal(sha(raw),hostWorkspaceTrustOriginalHashes[name]);const branded=brandedModule(raw);const capable=Object.hasOwn(hostCapabilityInputHashes,name)?deriveOfficialUiHostCapabilityModule(name,branded):branded;const input=deriveOfficialUiHostInstalledPluginsModule(name,capable);assert.equal(sha(input),hostWorkspaceTrustInputHashes[name]);return{name,input,output:deriveOfficialUiHostWorkspaceTrustModule(name,input)}});
test('five pinned modules validate exact final bytes, including previous capability derivation',()=>{assert.equal(inputs.length,5);for(const x of inputs){bytesCheck(current(),x.name,x.input,x.output);assert.throws(()=>bytesCheck(current(),x.name,x.input,x.output+' '),/differs from approved/);}});
test('new trust set rejects incomplete or unknown metadata; historical Code set needs historical bytes',()=>{for(const x of inputs){for(const mutate of[m=>delete m.hostWorkspaceTrust,m=>delete m.hostDerivationSet,m=>m.hostWorkspaceTrust.revision='unknown',m=>m.hostDerivationSet='unknown',m=>delete m.hostCodeCapability]){const m=current();mutate(m);assert.throws(()=>bytesCheck(m,x.name,x.input,x.output));}const old=current();delete old.hostWorkspaceTrust;old.hostDerivationSet='claudex-host-code-navigation-v1';assert.throws(()=>bytesCheck(old,x.name,x.input,x.output),/differs from approved/);bytesCheck(old,x.name,x.input,x.input);delete old.hostCodeCapability;delete old.hostDerivationSet;assert.throws(()=>bytesCheck(old,x.name,x.input,x.output),/differs from approved/);bytesCheck(old,x.name,x.input,x.input);}});
test('overlapping capability metadata retains exact intermediate output instead of trusting final module hash',()=>{const x=inputs.find(x=>Object.hasOwn(hostCapabilityInputHashes,x.name));assert.ok(x);assert.notEqual(sha(x.input),sha(x.output));assert.match(verifier,/expectedCapabilities\.set\(name, sha\(capable\)\)/);assert.match(verifier,/const output = expectedCapabilities\.get\(name\)/);assert.match(verifier,/record\.outputSha256 !== output/);assert.match(verifier,/\[meta.hostWorkspaceTrust, hostWorkspaceTrustInputHashes, hostWorkspaceTrustRules, hostWorkspaceTrustOriginalHashes, null\]/);const build=fs.readFileSync(path.join(root,'scripts/build-official-ui.mjs'),'utf8');assert.ok(build.indexOf('applyOfficialUiHostWorkspaceTrust(modulesDir)')>build.indexOf('applyOfficialUiHostCodeCapability(modulesDir)'));});

test('actual capability manifest validator accepts intermediate hashes and rejects substituted final hash',()=>{
 const from=verifier.indexOf('  if (meta.hostCapabilities) {',verifier.indexOf('for (const dir of'));
 const to=verifier.indexOf('  for (const [manifest, hashes, rules, originalHashes, outputs]',from);
 assert.ok(from>0&&to>from);
 const expectedCapabilities=new Map();
 const modules=Object.keys(hostCapabilityInputHashes).map(file=>{
  const raw=fs.readFileSync(path.join(root,'.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1',file),'utf8');
  const output=deriveOfficialUiHostCapabilityModule(file,brandedModule(deriveOfficialUiHostCompletionModule(file,deriveOfficialUiHostAuthModule(file,raw))));
  expectedCapabilities.set(file,sha(output));
  return {file,originalSha256:hostCapabilityOriginalHashes[file],inputSha256:hostCapabilityInputHashes[file],outputSha256:sha(output),rules:hostCapabilityRules.filter(r=>r.file===file).map(r=>r.name)};
 });
 const meta={hostCapabilities:{modules}};
 const context={meta,expectedCapabilities,hostCapabilityInputHashes,hostCapabilityOriginalHashes,hostCapabilityRules};
 vm.runInNewContext(verifier.slice(from,to),context);
 const overlap=inputs.find(x=>Object.hasOwn(hostCapabilityInputHashes,x.name));
 modules.find(x=>x.file===overlap.name).outputSha256=sha(overlap.output);
 assert.throws(()=>vm.runInNewContext(verifier.slice(from,to),context),/Host capability manifest derivation mismatch/);
});
