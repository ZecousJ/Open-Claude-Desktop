/** Exact original Stop state/notice callbacks, no DOM, real stop, model or network. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {createHash} from 'node:crypto';
import {stopFeedbackInputs,stopFeedbackRules,stopFeedbackMain,stopFeedbackHub,stopFeedbackRevision,deriveOfficialStopFeedbackModule,applyOfficialStopFeedback,verifyOfficialStopFeedbackManifest} from '../scripts/official-ui-stop-feedback.mjs';
import {verifyOfficialWebAssets} from '../scripts/official-web-assets.mjs';

const sha = source => createHash('sha256').update(source).digest('hex');
const sources = {}, candidates = {}, outputs = {};
const resources = process.env.CLAUDEX_F014_ORIGINAL_RESOURCES;
if (resources) {
  for (const name of Object.keys(stopFeedbackInputs))
    sources[name] = fs.readFileSync(path.join(resources, name), 'utf8');
} else {
  verifyOfficialWebAssets(process.cwd(), {
    onStopFeedbackInput(name, source) { sources[name] = source; },
  });
}
for (const [name, expected] of Object.entries(stopFeedbackInputs)) {
  assert.equal(sha(sources[name]), expected);
  candidates[name] = deriveOfficialStopFeedbackModule(name, sources[name]);
  outputs[name] = sha(candidates[name]);
}
function parse(code){return ts.createSourceFile('pinned.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);}
function state(code,verdict,{current=true,pending=true,phase='none'}={}){
 const ast=parse(code);const bae=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Bae');let qe,je,we;
 function visit(n){if(ts.isBinaryExpression(n)&&n.left.getText(ast)==='Qe'&&ts.isArrowFunction(n.right))qe=n.right;if(ts.isVariableDeclaration(n)&&['Je','We'].includes(n.name.getText(ast))){const callback=n.initializer.whenTrue.arguments.at(-1);if(n.name.getText(ast)==='Je')je=callback;else we=callback;}ts.forEachChild(n,visit);}visit(bae);assert.ok(qe&&je&&we);
 let cb,B=true,W=true,H=false;const timers=[],notifications=[],ref=current=>({current});let rereads=0;
 const env={U:v=>H=v,V:v=>B=v,G:v=>W=v,y:f=>{cb=f;return()=>{}},_e:ref(false),le:ref(pending),oe:ref(phase),Y:ref(undefined),ue:ref(undefined),pe:ref(false),Ve:ref(false),Ae:ref(false),ie:ref(true),Pe:ref(true),Oe:ref(current?1:2),q:ref(1),Le:ref((...a)=>notifications.push(a)),fe:ref(0),me:ref('stop'),se:ref(undefined),ze:ref(undefined),be:ref(undefined),Te:()=>{rereads++;},Rae:3000,Date:{now:()=>4000},clearTimeout(){},setTimeout:f=>{timers.push(f);return timers.length}};
 vm.createContext(env);env.We=vm.runInContext(`(${we.getText(ast)})`,env);env.Je=vm.runInContext(`(${je.getText(ast)})`,env);vm.runInContext(`(${qe.getText(ast)})`,env)();cb(verdict);for(const f of timers)f();return {B,W,H,rereads,notifications};
}
function notice(code,o,pending=1n){
 const ast=parse(code),tz=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TZ');let block;
 function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast).includes('o.failure.action === "stop_generation"')&&n.thenStatement.getText(ast).includes('R.actionRefusedCbs'))block=n;ts.forEachChild(n,visit);}visit(ast);
 const callbacks=[],verdicts=[],R={pendingStop:{current:pending},actionRefusedCbs:new Set([v=>callbacks.push(v)]),stopVerdictCbs:new Set([v=>verdicts.push(v)])};const env={R,o};vm.createContext(env);vm.runInContext(tz.getText(ast),env);
 const receive=()=>{if(block)vm.runInContext(block.getText(ast),env);vm.runInContext('o.version !== void 0 && TZ(R, o.version, "refused");',env);};receive();receive();return {callbacks,verdicts,pending:R.pendingStop.current};
}
const own=()=>({version:1n,foreign:false,local:false,superseded:false,failure:{action:'stop_generation',messageId:'',error:{type:'api_error',displayMessage:'Synthetic stop was not confirmed.',retryable:false}}});
test('original refused Stop leaves both control states pending; candidate settles only refused without changing telemetry',()=>{
 const before=state(sources[stopFeedbackMain],'refused'),after=state(candidates[stopFeedbackMain],'refused');assert.equal(before.B,true);assert.equal(before.W,true);assert.equal(after.B,false);assert.equal(after.W,false);assert.deepEqual(after.notifications,before.notifications);assert.equal(after.rereads,0);
});
test('nothing_running, accepted-like values, stale activation, absent pending and existing phase keep original behavior',()=>{
 for(const verdict of ['nothing_running','unclassified','turn_canceled','gave_up'])assert.deepEqual(state(candidates[stopFeedbackMain],verdict),state(sources[stopFeedbackMain],verdict));
 for(const options of [{current:false},{pending:false},{phase:'awaiting_turn'}])assert.deepEqual(state(candidates[stopFeedbackMain],'refused',options),state(sources[stopFeedbackMain],'refused',options));
});
test('own Stop error reports its existing error body exactly once and retains TZ settlement',()=>{
 const base=notice(sources[stopFeedbackHub],own()),result=notice(candidates[stopFeedbackHub],own());assert.equal(base.callbacks.length,0);assert.equal(result.callbacks.length,1);assert.deepEqual(JSON.parse(JSON.stringify(result.callbacks[0])),{action:'stop_generation',displayMessage:'Synthetic stop was not confirmed.',retryable:false});assert.deepEqual(result.verdicts,['refused']);assert.equal(result.pending,undefined);
});
test('foreign, local, superseded, unrelated action, missing error and mismatched version never report a Stop toast',()=>{
 for(const change of [{foreign:true},{local:true},{superseded:true},{version:undefined},{version:2n},{failure:{...own().failure,action:'send_message'}},{failure:{...own().failure,error:undefined}}])assert.equal(notice(candidates[stopFeedbackHub],{...own(),...change}).callbacks.length,0);
});
test('original hK chooses existing safe server text for stop without inventing localized fallback copy',()=>{
 const ast=parse(candidates[stopFeedbackMain]);const names=['hK','lK','IK'];const defs=names.map(name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast)).join('\n');
 // The existing text sanitizer is exercised separately by the original UI; this pure boundary receives already-safe self-authored text.
 const env={O_:s=>s.trim(),mK:()=>undefined,D:(component,props)=>({component,props}),hl:'existing-multiline'};vm.createContext(env);vm.runInContext(defs,env);assert.equal(env.hK(own().failure.error&&{action:'stop_generation',displayMessage:own().failure.error.displayMessage}),'Synthetic stop was not confirmed.');assert.equal(env.hK({action:'stop_generation'}),undefined);
});
test('strict input, exactly one anchor, unknown modules unchanged and candidate JavaScript parses',()=>{
 for(const name of Object.keys(stopFeedbackInputs)){assert.throws(()=>deriveOfficialStopFeedbackModule(name,sources[name]+'\n'),/pinned/);assert.throws(()=>deriveOfficialStopFeedbackModule(name,candidates[name]),/pinned/);assert.equal(sources[name].split(stopFeedbackRules[name].before).length,2);assert.equal(parse(candidates[name]).parseDiagnostics.length,0);}assert.equal(deriveOfficialStopFeedbackModule('other.js','untouched'),'untouched');
});
test('unlinked assembly validates both modules before writing and exact manifest rejects mismatch',t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'f014-stop-build-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));for(const name of Object.keys(sources))fs.writeFileSync(path.join(dir,name),sources[name]);const manifest=applyOfficialStopFeedback(dir);assert.equal(manifest.revision,stopFeedbackRevision);const files=Object.keys(outputs).map(name=>({path:'assets/v1/'+name,sha256:outputs[name]}));verifyOfficialStopFeedbackManifest(manifest,files,outputs);assert.throws(()=>verifyOfficialStopFeedbackManifest({...manifest,revision:'bad'},files,outputs));assert.throws(()=>verifyOfficialStopFeedbackManifest(manifest,files.slice(1),outputs));assert.throws(()=>applyOfficialStopFeedback(dir));
 const bad=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'f014-stop-bad-'));t.after(()=>fs.rmSync(bad,{recursive:true,force:true}));fs.writeFileSync(path.join(bad,stopFeedbackMain),sources[stopFeedbackMain]);fs.writeFileSync(path.join(bad,stopFeedbackHub),'wrong');assert.throws(()=>applyOfficialStopFeedback(bad));assert.equal(fs.readFileSync(path.join(bad,stopFeedbackMain),'utf8'),sources[stopFeedbackMain]);
 const link=path.join(bad,'alias');fs.symlinkSync(dir,link);assert.throws(()=>applyOfficialStopFeedback(link),/unlinked/);
});
test('formal assembly follows regeneration and verifies both predecessor hashes plus final bytes and owned cache',()=>{
 const root=path.resolve(import.meta.dirname,'..');const build=fs.readFileSync(path.join(root,'scripts/build-official-ui.mjs'),'utf8'),verify=fs.readFileSync(path.join(root,'scripts/official-web-assets.mjs'),'utf8');assert.ok(build.indexOf('applyOfficialStopFeedback(modulesDir)')>build.indexOf('applyOfficialRegenerationError(modulesDir)'));assert.match(build,/hostStopFeedback,/);assert.match(verify,/meta.hostStopFeedback != null/);assert.match(verify,/hostStopFeedback && !meta.hostRegenerationError/);assert.match(verify,/deriveOfficialChatSearchReadinessModule\(name, stopAware\)/);assert.match(verify,/deriveOfficialModelPreferenceFeedbackModule\(name, chatSearchReady\)/);assert.match(verify,/deriveOfficialUiHostIncognitoLifecycleModule\(name, modelPreferenceAware\)/);assert.match(verify,/deriveOfficialModelCatalogStateModule\(name, listsAware\)/);assert.match(verify,/deriveOfficialLegacyQuoteIdentityModule\(name, replyFeedbackAware\)/);assert.match(verify,/verifyOfficialStopFeedbackManifest\(meta.hostStopFeedback, preModelCatalogFiles,/);assert.match(verify,/verifyOfficialRegenerationErrorManifest\(meta.hostRegenerationError, preStopFiles,/);assert.match(verify,/verifyOfficialEditRetryManifest\(meta.hostEditRetry, priorElicitationFiles,/);assert.match(verify,/hostStopFeedback: meta.hostStopFeedback \?\? null/);
});
