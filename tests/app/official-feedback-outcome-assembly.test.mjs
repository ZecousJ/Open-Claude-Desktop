import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {brandedModule,verifyHostCodeDerivationSet} from '../../scripts/official-web-assets.mjs';
import * as feedback from '../../scripts/official-ui-host-feedback-outcome.mjs';
import {hostWorkspaceTrustRevision} from '../../scripts/official-ui-host-workspace-trust.mjs';
import {hostCodeCapabilityRevision} from '../../scripts/official-ui-host-code-capability.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const root=path.resolve(import.meta.dirname,'../..');
const verifier=fs.readFileSync(path.join(root,'scripts/official-web-assets.mjs'),'utf8');
const build=fs.readFileSync(path.join(root,'scripts/build-official-ui.mjs'),'utf8');
const exports={};
for(const match of verifier.matchAll(/from "(\.\/official-[^"]+\.mjs)"/g)) Object.assign(exports,await import(new URL('../../scripts/'+match[1].slice(2),import.meta.url)));
const rows=Object.keys(feedback.hostFeedbackOutcomeInputHashes).map(name=>{
 const raw=fs.readFileSync(path.join(root,'.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1',name),'utf8');
 assert.equal(sha(raw),feedback.hostFeedbackOutcomeOriginalHashes[name]);
 const input=brandedModule(raw);assert.equal(sha(input),feedback.hostFeedbackOutcomeInputHashes[name]);
 return {name,input,output:feedback.deriveOfficialUiHostFeedbackOutcomeModule(name,input)};
});
const manifest={revision:feedback.hostFeedbackOutcomeRevision,modules:rows.map(x=>({file:x.name,originalSha256:feedback.hostFeedbackOutcomeOriginalHashes[x.name],inputSha256:sha(x.input),outputSha256:sha(x.output),rules:feedback.hostFeedbackOutcomeRules.filter(r=>r.file===x.name).map(r=>r.name)}))};
const current=()=>({hostDerivationSet:'claudex-host-feedback-outcome-v1',hostFeedbackOutcome:structuredClone(manifest),hostWorkspaceTrust:{revision:hostWorkspaceTrustRevision},hostCodeCapability:{revision:hostCodeCapabilityRevision},hostAuth:{},hostInstalledPlugins:{},hostSkillSearch:{}});
const start=verifier.indexOf('          const skillAware ='),end=verifier.indexOf('      files.push(',start);
const tail='if(true){if(true){\n'+verifier.slice(start,end);
function bytesCheck(meta,row,bytes){verifyHostCodeDerivationSet(meta);vm.runInNewContext(tail,{...exports,meta,options:{},sha,desktopSessionExport:null,expectedFeedbackOutcome:new Map(),name:row.name,pluginAware:row.input,bytes:Buffer.from(bytes),Buffer,expected:null,relative:'assets/v1/'+row.name});}
test('actual final derivation accepts branded pinned modules and rejects wrong bytes/missing metadata',()=>{
 for(const row of rows){bytesCheck(current(),row,row.output);assert.throws(()=>bytesCheck(current(),row,row.output+' '),/differs/);
 for(const mutate of[m=>delete m.hostFeedbackOutcome,m=>delete m.hostDerivationSet,m=>delete m.hostWorkspaceTrust,m=>m.hostFeedbackOutcome.revision='unknown']){const meta=current();mutate(meta);assert.throws(()=>bytesCheck(meta,row,row.output));}
 const old=current();delete old.hostFeedbackOutcome;old.hostDerivationSet='claudex-host-workspace-trust-v1';bytesCheck(old,row,row.input);assert.throws(()=>bytesCheck(old,row,row.output),/differs/);
 }
});
test('actual generic manifest validator rejects hashes, rule sets, duplicates and omitted modules',()=>{
 const a=verifier.indexOf('  for (const [manifest, hashes, rules, originalHashes, outputs]'),b=verifier.indexOf('  const images =',a);assert.ok(a>0&&b>a);
 const check=m=>vm.runInNewContext(verifier.slice(a,b),{...exports,meta:{hostFeedbackOutcome:m},files:rows.map(x=>({path:'assets/v1/'+x.name,sha256:sha(x.output)})),expectedCompletion:new Map(),expectedUserContent:new Map(),expectedInstalledPlugins:new Map(),expectedFeedbackOutcome:new Map(rows.map(x=>[x.name,sha(x.output)])),beforeIncognitoUploads:rows.map(x=>({path:"assets/v1/"+x.name,sha256:sha(x.output)}))});
 check(structuredClone(manifest));
 for(const mutate of[m=>m.modules.pop(),m=>m.modules.push(m.modules[0]),m=>m.modules[0].inputSha256='bad',m=>m.modules[0].originalSha256='bad',m=>m.modules[0].outputSha256='bad',m=>m.modules[0].rules=[]]){const m=structuredClone(manifest);mutate(m);assert.throws(()=>check(m),/manifest/);}
});
test('actual assembler opt-out never applies transform and records strict new set only when enabled',()=>{
 const a=build.indexOf('const hostFeedbackOutcome ='),b=build.indexOf('const hostCodeFeedback =',a);assert.ok(a>0&&b>a);assert.ok(a>build.indexOf('applyOfficialUiHostWorkspaceTrust(modulesDir)'));
 for(const enabled of [false,true]){let calls=0;const scope={process:{env:{CLAUDEX_OFFICIAL_HOST_CAPABILITIES:enabled?'1':'0'}},modulesDir:'inert',applyOfficialUiHostFeedbackOutcome(){calls++;return manifest;}};vm.runInNewContext(build.slice(a,b)+';this.result=hostFeedbackOutcome;',scope);assert.equal(calls,enabled?1:0);assert.equal(scope.result,enabled?manifest:null);}
 assert.match(build,/hostFeedbackOutcome \? "claudex-host-feedback-outcome-v1"/);
 assert.match(verifier,/hostFeedbackOutcome: meta.hostFeedbackOutcome \?\? null/);
});
