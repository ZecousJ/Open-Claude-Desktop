import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {brandedModule} from '../scripts/official-web-assets.mjs';
// @ts-expect-error Build-time pinned JavaScript helper has no declaration file.
import {applyOfficialUiHostSecurity,deriveOfficialUiHostSecurityModule,hostSecurityRules,hostSecurityInputHashes,hostSecurityOriginalHashes,securityEligibilityExplanation,mfaUnavailableBefore,mfaUnavailableAfter} from '../scripts/official-ui-host-security.mjs';
const name='c71860c77-pnODXvGc.js';
const original='.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/'+name;
const input=()=>brandedModule(fs.readFileSync(original,'utf8'));
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
test('pinned transform changes only exact eligibility error explanation, not account deletion rules',()=>{
 const source=input();
 assert.equal(sha(fs.readFileSync(original,'utf8')),hostSecurityOriginalHashes[name]);
 assert.equal(sha(source),hostSecurityInputHashes[name]);
 const output=deriveOfficialUiHostSecurityModule(name,source);
 assert.equal(output,hostSecurityRules.reduce((text:any,rule:any)=>text.replace(rule.before,rule.after),source));
 assert.ok(output.includes('if (e)\n    return s(c, {'));
 assert.ok(output.includes('description: e,'));
 assert.ok(output.includes('return m && !f\n    ? u("div"'));
 assert.ok(output.includes('if (!r && !he(a)) return null;'));
 assert.equal(sha(fs.readFileSync(original,'utf8')),hostSecurityOriginalHashes[name]);
});
test('actual transformed eligibility expression preserves true and blocked source states; precise unknown has explanation',()=>{
 const expression=hostSecurityRules.find((rule:any)=>rule.name==='host-deletion-eligibility-unavailable').after.trim().slice(4,-1);
 const evaluate=(g:unknown,managed=false)=>vm.runInNewContext(expression,{g,_:managed},{timeout:1000});
 assert.equal(evaluate({isSuccess:true,data:{deletable:true}}),undefined);
 assert.equal(evaluate({isSuccess:true,data:{deletable:false,display_message:'Real source reason'}}),'Real source reason');
 assert.equal(evaluate({isSuccess:false,error:{errorCode:'account_deletion_eligibility_unavailable'}}),securityEligibilityExplanation);
 assert.equal(evaluate({isSuccess:false,error:{errorCode:'other'}}),undefined);
 assert.equal(evaluate({isSuccess:false}),undefined);
 assert.equal(evaluate({isSuccess:true,data:{deletable:true},error:{errorCode:'other'}}),undefined);
});
test('checksum drift, repeated transform and recovered/symlink writes fail closed',()=>{
 const source=input();
 assert.throws(()=>deriveOfficialUiHostSecurityModule(name,source+'\n'),/checksum/);
 const output=deriveOfficialUiHostSecurityModule(name,source);
 assert.throws(()=>deriveOfficialUiHostSecurityModule(name,output),/checksum/);
 assert.equal(deriveOfficialUiHostSecurityModule('unrelated.js','untouched'),'untouched');
 assert.throws(()=>applyOfficialUiHostSecurity(path.dirname(original)),/immutable/);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'security-transform-'));
 try{
  fs.writeFileSync(path.join(root,name),source);
  const result=applyOfficialUiHostSecurity(root);
  assert.equal(result.modules[0].outputSha256,sha(output));
  assert.equal(fs.readFileSync(path.join(root,name),'utf8'),output);
  fs.unlinkSync(path.join(root,name));fs.symlinkSync(path.resolve(original),path.join(root,name));
  assert.throws(()=>applyOfficialUiHostSecurity(root),/Symlink/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('actual MFA consumer prelude renders explicit host unavailable text, never setup, while normal/loading remain unchanged',()=>{
 const source=input(), start=source.indexOf('function gr() {'), end=source.indexOf('  let w = r?.methods.find',start);
 assert.ok(start>0&&end>start);
 const prelude=source.slice(start,end).replace(mfaUnavailableBefore,mfaUnavailableAfter)+'return {normal:true}; }';
 for(const locale of ['en-US','zh-CN']){
  const check=(data:any,error:any)=>vm.runInNewContext(prelude+';gr();',{
   Z:()=>({locale}),e:()=>({add(){}}),me:()=>({data,error}),i:()=>[false,()=>{}],Qe:()=>({}),gt:()=>({}),bt:()=>({largeEnough:false,tooSmall:false,confirmLargeEnough(){}}),xt:()=>false,pe:()=>({mutate(){},isPending:false}),he:(value:any)=>value?.errorCode==='mfa_unavailable',u:(tag:any,props:any)=>({tag,props}),G:'section',
  },{timeout:1000});
  const unavailable=check(undefined,{errorCode:'mfa_unavailable'});
  assert.equal(unavailable.tag,'section');assert.equal(unavailable.props.id,'two-factor-authentication');
  assert.ok(unavailable.props.title.length>0);assert.ok(unavailable.props.description.includes('Claudex'));
  assert.equal(unavailable.props.children,null);
  assert.match(unavailable.props.description,locale==='zh-CN'?/不代表.*未启用/:/does not mean authentication is disabled/);
  assert.equal(check(undefined,undefined),null);assert.equal(check(undefined,{errorCode:'other'}),null);
  assert.equal(check({methods:[],mfa_enrolled:false},undefined).normal,true);
  assert.equal(check({methods:[{method:'sms'}],mfa_enrolled:true},undefined).normal,true);
 }
});
