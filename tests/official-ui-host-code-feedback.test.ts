import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createHash} from 'node:crypto';
import {brandedModule} from '../scripts/official-web-assets.mjs';
import {deriveOfficialUiHostCodeFeedbackModule as derive,hostCodeFeedbackInputHashes as hashes,hostCodeFeedbackOriginalHashes as originals,hostCodeFeedbackHelper as helper,hostCodeFeedbackRules as rules} from '../scripts/official-ui-host-code-feedback.mjs';
const dir=path.resolve('build/official-ui/ui/assets/v1'),[modalFile,transportFile]=Object.keys(hashes),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function input(file:string){const raw=fs.readFileSync('.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/'+file,'utf8');assert.equal(sha(raw),originals[file]);const branded=brandedModule(raw);assert.equal(sha(branded),hashes[file]);return branded;}
const modal=derive(modalFile,input(modalFile)),transport=derive(transportFile,input(transportFile));
function scope(){const box:any={};vm.runInNewContext(helper,box);return box;}
test('ordinary Code feedback selects the authenticated native or versioned Web transport',()=>{
 const b=scope();
 const account={uuid:'owner',claudex_host_authentication:{version:1,status:'authenticated',account_uuid:'owner'}};
 const local={type:'local',id:'local_owned'}, remote={type:'remote',id:'session_owned'};
 assert.equal(b.__claudexCodeTextFeedback(account,local,undefined,undefined),'native');
 assert.equal(b.__claudexCodeTextFeedback(account,remote,undefined,undefined),'unavailable');
 b.__claudexProductFeedback={version:2,submit(){},submitCode(){}};
 assert.equal(b.__claudexCodeTextFeedback(account,remote,undefined,undefined),'unavailable');
 b.__claudexProductFeedback.version=1;
 assert.equal(b.__claudexCodeTextFeedback(account,remote,undefined,undefined),'web');
 for(const args of [[{},local,undefined,undefined],[account,local,{},undefined],[account,remote,undefined,'channel'],[{...account,uuid:'other'},local,undefined,undefined]])
  assert.equal(b.__claudexCodeTextFeedback(...args),null);
 assert.match(b.__claudexFeedbackNotice({locale:'zh-CN'}),/仅将你填写的反馈和应用版本发送给管理员/);
 assert.match(b.__claudexFeedbackNotice({locale:'en-US'}),/Only your feedback text and app version will be sent to the administrator\./);
});
function actualTransport(calls:any[],present=true){const at=transport.indexOf('    async submitFeedback(e, t, n, options) {'),end=transport.indexOf('    async submitSurveyFeedback',at);assert.ok(at>0&&end>at);const b:any={a:present?{submitFeedback:async(...args:any[])=>{calls.push(['native',...args]);return{feedbackId:'inert-reference',includedTranscript:false};}}:{},Wr:async(id:string)=>calls.push(['warm',id])};vm.runInNewContext('this.transport=({'+transport.slice(at,end)+'});',b);return b.transport;}
function actualSubmit(timeout=120000){const b:any={AbortController,setTimeout,clearTimeout,w:timeout,T:20000,e:(e:any)=>e,S:()=>{},x:()=>'',ge:()=>false,ne:()=>{throw Error('Unexpected clipboard/share');},C:{}};vm.runInNewContext(helper+modal.slice(modal.indexOf('async function Pe({'),modal.indexOf('function D(e) {'))+';this.submit=Pe;',b);return b.submit;}
test('actual submit+local transport sends only description, zero warm/share even if supplied old options true',async()=>{const calls:any[]=[],states:any[]=[],errors:any[]=[],tr=actualTransport(calls),submit=actualSubmit();await submit({hostTextFeedback:'native',sessionId:'local_owned',submitFn:tr.submitFeedback.bind(tr),checkRefusal:()=>undefined,description:'Self-authored feedback',grantSupportShare:true,createSupportShare:()=>{throw Error('Unexpected support share');},shouldWake:true,wakeSession:()=>{throw Error('Unexpected wake');},intl:{locale:'en-US',formatMessage:(m:any)=>m.defaultMessage},generationRef:{current:1},abortRef:{current:null},setStep:(s:any)=>states.push(s),setError:(e:any)=>errors.push(e),setFeedbackId:(id:string)=>calls.push(['id',id]),setCcshareUrl:(u:any)=>assert.equal(u,null),setLinkCopy:()=>{throw Error('Unexpected link');}});assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['native','local_owned',{claudexTextOnlyFeedback:true,description:'Self-authored feedback'}],['id','inert-reference']]);assert.deepEqual(states,['submitting','done']);assert.deepEqual(errors,[null]);});
test('default original transport still warms, aborted host does not dispatch, missing method never falls back',async()=>{const calls:any[]=[],tr=actualTransport(calls);await tr.submitFeedback('original','note');assert.equal(calls[0][0],'warm');calls.length=0;const signal=new AbortController();signal.abort();await tr.submitFeedback('host','note',signal.signal,{claudexTextOnlyFeedback:true});assert.equal(calls.length,0);const absent=await actualTransport(calls,false).submitFeedback('host','note',undefined,{claudexTextOnlyFeedback:true});assert.equal(absent.failureReason,'unavailable');assert.equal(absent.statusCode,501);assert.equal(absent.unavailableReason,undefined);assert.equal(calls.length,0);});
test('actual Pe keeps unknown delivery in its original inline error, no completion or retry',async()=>{let sends=0;const states:string[]=[],errors:any[]=[];await actualSubmit()({hostTextFeedback:'native',sessionId:'local_owned',description:'note',submitFn:async()=>{sends++;return{claudexProductFeedback:true,deliveryState:'unknown'};},intl:{locale:'zh-CN',formatMessage:(m:any)=>m.defaultMessage},generationRef:{current:1},abortRef:{current:null},setStep:(s:string)=>states.push(s),setError:(e:any)=>errors.push(e),setFeedbackId:()=>{throw Error('False success');}});assert.equal(sends,1);assert.deepEqual(states,['submitting','input']);assert.match(errors[1],/请勿重复提交/);});
test('form keeps original controls and explicit host memo slots; exact inputs reject tampering',()=>{assert.match(modal,/M = !__hostTextFeedback && !D/);assert.match(modal,/P = !__hostTextFeedback &&/);assert.match(modal,/\$\[155\] !== __hostTextFeedback/);assert.match(modal,/\$\[156\] !== __hostTextFeedback/);for(const text of ['Feedback description','Cancel','Send feedback','Reference ID'])assert.ok(modal.includes(text));for(const f of Object.keys(hashes))assert.throws(()=>derive(f,input(f)+'\n'),/input mismatch/);assert.equal(rules.filter((r:any)=>r.file===transportFile).length,1);});
test('both final transformed static ESM graphs link without evaluating modules',async()=>{assert.equal(typeof vm.SourceTextModule,'function','Run with --experimental-vm-modules');for(const entry of [modalFile,transportFile]){const cache=new Map<string,vm.SourceTextModule>();function load(file:string){file=path.resolve(file);assert.ok(file.startsWith(dir+path.sep));let m=cache.get(file);if(m)return m;const name=path.basename(file);const source=Object.hasOwn(hashes,name)?derive(name,input(name)):fs.readFileSync(file,'utf8');m=new vm.SourceTextModule(source,{identifier:file});cache.set(file,m);return m;}await load(path.join(dir,entry)).link((specifier,parent)=>{assert.ok(specifier.startsWith('./')||specifier.startsWith('../'));return load(path.resolve(path.dirname(parent.identifier),specifier));});assert.ok(cache.size>20);assert.equal(cache.get(path.join(dir,entry))!.status,'linked');}});

function submission(host=true,locale='en-US') {
 const steps:string[]=[],errors:any[]=[],ids:any[]=[],generation={current:1};
 return {steps,errors,ids,generation,args:{hostTextFeedback:host?'native':null,sessionId:'local_owned',description:'Synthetic',intl:{locale,formatMessage:(m:any)=>m.defaultMessage},generationRef:generation,abortRef:{current:null},setStep:(v:string)=>steps.push(v),setError:(v:any)=>errors.push(v),setFeedbackId:(v:any)=>ids.push(v),setCcshareUrl:()=>{},setLinkCopy:()=>{}}};
}
test('actual Pe host timeout and rejected dispatch report unknown in Chinese and English, once',async()=>{
 for(const locale of ['zh-CN','en-US']) for(const rejected of [false,true]) {
  const f=submission(true,locale);let sends=0;
  await actualSubmit(1)({...f.args,submitFn:()=>{sends++;return rejected?Promise.reject(Error('inert dispatch error')):new Promise(()=>{});}});
  assert.equal(sends,1);assert.deepEqual(f.steps,['submitting','input']);assert.equal(f.ids.length,0);
  assert.match(f.errors[1],locale==='zh-CN'?/无法确认.*请勿重复提交/:/confirm whether.*don’t submit it again/);
 }
});
test('actual Pe closed generation ignores late accepted or rejected response',async()=>{
 for(const reject of [false,true]) { const f=submission();let finish!:(v:any)=>void;const promise=new Promise((resolve,rejectFn)=>finish=reject?rejectFn:resolve);let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  const running=actualSubmit()({...f.args,submitFn:()=>{entered();return promise;}});await started;f.generation.current++;finish(reject?Error('late'):{feedbackId:'late'});await running;
  assert.deepEqual(f.steps,['submitting']);assert.deepEqual(f.errors,[null]);assert.equal(f.ids.length,0);
 }
});
test('preflight refusal never submits; nonhost catch retains original localized error contract',async()=>{
 const f=submission();let sends=0;await actualSubmit()({...f.args,checkRefusal:()=> 'Existing preflight refusal',submitFn:()=>{sends++;return {};}});assert.equal(sends,0);assert.equal(f.errors[1],'Existing preflight refusal');
 const g=submission(false);await actualSubmit()({...g.args,submitFn:()=>Promise.reject(Error('inert'))});assert.equal(g.errors[1],'Couldn’t send feedback. Try again.');assert.deepEqual(g.steps,['submitting','input']);
});
