/** Execute recovered consumers, not reimplementations. No network or model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { hostProjectMoveInputHashes, hostProjectMoveRules, deriveOfficialUiHostProjectMoveModule, applyOfficialUiHostProjectMove } from '../scripts/official-ui-host-project-move.mjs';
const assets = path.resolve(process.env.CLAUDEX_F029_INPUT_RESOURCES ?? 'build/official-ui/ui/assets/v1');
const names = Object.keys(hostProjectMoveInputHashes), [removeFile, moveFile] = names;
const originals = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(assets, name), 'utf8')]));
const candidates = Object.fromEntries(names.map(name => [name, deriveOfficialUiHostProjectMoveModule(name, originals[name])]));
const equal = (a,b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const sha = s => createHash('sha256').update(s).digest('hex');
const parse = source => ts.createSourceFile('original.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function definition(source, name) {
  const ast = parse(source);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}
const removeError = 'Couldn’t remove from project. Try again.';
const moveError = 'Couldn’t move. Try again.';
const intl = { locale: 'en', formatMessage: (descriptor, values) => ({ text: descriptor.defaultMessage, values }) };
async function remove(source, result, options = {}, thrown) {
  const success = [], errors = [], calls = [], callbacks = [], transitions = [];
  let pending = new Set(['other']);
  const env = {}; vm.createContext(env);
  vm.runInContext(definition(source, 'Gn'), env);
  let value, failure;
  try { value = await env.Gn(['a', 'b'], {showSuccess:true, showError:true, onSuccess:r=>callbacks.push(r), ...options}, {
    moveManyConversations: async input => {calls.push(input); if (thrown) throw thrown; return result;},
    addSuccess: (...args) => success.push(args), addError: (...args) => errors.push(args), intl,
    setRemovingConversations: update => {pending = update(pending); transitions.push([...pending]);},
  }); } catch (e) {failure = e;}
  return {success, errors, calls, callbacks, transitions, value, failure, pending};
}
async function move(source, ids, result, options = {}, thrown) {
  const success = [], errors = [], calls = [], callbacks = [], updates = [], refresh = [];
  const env = {J9:()=>[], J5:()=>true, J1:()=>true, K5:(_s,_n,...args)=>args.at(-1), K1:(_s,_n,_v,result)=>result,
    xd:()=>({moveToProject:async(...args)=>{calls.push(args);if(thrown)throw thrown;return result;}}),
    OZ:()=>({addSuccess:(...v)=>success.push(v),addError:(...v)=>errors.push(v)}),pT:()=>intl,
    Co:()=>({moveTargetGone:{defaultMessage:'This chat does not exist or was deleted'},moveFailedCount:{defaultMessage:'Failed to move chats. You can try again.'},movedToProjectCount:{defaultMessage:'Moved {count} chats to {projectName}'}}),
    JH:()=>true,b1:(...v)=>updates.push(v),Nu:v=>refresh.push(v),XM:v=>v,l_:v=>v,nl:v=>v,
  };
  vm.createContext(env);vm.runInContext(definition(source,'RQ'),env);
  let value,failure;
  try {value=await env.RQ().moveToProject(ids,'project','Alpha',{onSuccess:r=>callbacks.push(r),...options});}catch(e){failure=e;}
  return {success,errors,calls,callbacks,updates,refresh,value,failure};
}
test('original failure witnesses: remove silently resolves; move claims deletion',async()=>{
  const removed=await remove(originals[removeFile],{moved:[],failed:['a']});assert.equal(removed.errors.length,0);
  const moved=await move(originals[moveFile],['a'],{totalMoved:0,totalFailed:1,moved:[]});assert.equal(moved.errors[0][0].text,'This chat does not exist or was deleted');
});
test('remove reports single, multiple and partial failures; preserves original successes, arrays and cleanup',async()=>{
  for(const result of [{moved:[],failed:['a']},{moved:[],failed:['a','b']},{moved:['a'],failed:['b']},{moved:['a','b'],failed:[]},{moved:[],failed:[]}]){
    const before=await remove(originals[removeFile],result), after=await remove(candidates[removeFile],result);
    assert.equal(after.value,result);assert.equal(after.callbacks[0],result);assert.equal(after.calls.length,1);
    equal(after.calls,before.calls);equal(after.success,before.success);
    assert.equal(after.errors.length,result.failed.length?1:0);if(result.failed.length)assert.equal(after.errors[0][0].text,removeError);
    assert.deepEqual(after.transitions,before.transitions);assert.deepEqual([...after.pending],['other']);
  }
});
test('move reports failures using stock text and preserves partial successes',async()=>{
  for(const [ids,result] of [[['a'],{totalMoved:0,totalFailed:1,moved:[]}],[['a','b'],{totalMoved:0,totalFailed:2,moved:[]}],[['a','b'],{totalMoved:1,totalFailed:1,moved:['a']}],[['a'],{totalMoved:1,totalFailed:0,moved:['a']}],[[],{totalMoved:0,totalFailed:0,moved:[]}]]){
    const before=await move(originals[moveFile],ids,result),after=await move(candidates[moveFile],ids,result);
    assert.equal(after.value,result);assert.equal(after.callbacks[0],result);assert.equal(after.calls.length,1);
    equal(after.calls,before.calls);equal(after.success,before.success);equal(after.updates,before.updates);equal(after.refresh,before.refresh);
    assert.equal(after.errors.length,result.totalFailed?1:0);if(result.totalFailed)assert.equal(after.errors[0][0].text,'Failed to move chats. You can try again.');
  }
});
test('showError and showSuccess options remain independent',async()=>{
  for(const showError of [true,false])for(const showSuccess of [true,false]){
    const removed=await remove(candidates[removeFile],{moved:['a'],failed:['b']},{showError,showSuccess});
    const moved=await move(candidates[moveFile],['a','b'],{totalMoved:1,totalFailed:1,moved:['a']},{showError,showSuccess});
    for(const r of [removed,moved]){assert.equal(r.success.length,Number(showSuccess));assert.equal(r.errors.length,Number(showError));}
  }
});
test('thrown errors retain identity, earlier successes reconciliation, one attempt, cleanup and suppression',async()=>{
  const error=Object.assign(new Error('synthetic persistence failure'),{moved:['a']});
  for(const showError of [true,false]){
    const before=await move(originals[moveFile],['a','b'],null,{showError},error);
    const moved=await move(candidates[moveFile],['a','b'],null,{showError},error);
    const removed=await remove(candidates[removeFile],null,{showError},error);
    equal(moved.updates,before.updates);assert.deepEqual(moved.refresh,before.refresh);assert.deepEqual([...removed.pending],['other']);
    for(const r of [removed,moved]){assert.equal(r.failure,error);assert.equal(r.calls.length,1);assert.equal(r.callbacks.length,0);assert.equal(r.success.length,0);assert.equal(r.errors.length,Number(showError));if(showError)assert.equal(r.errors[0][0].text,r===removed?removeError:moveError);}
  }
});
test('project feedback leaves the transport and batch implementation unchanged',()=>{
  for(const fn of ['nQ','hC'])assert.equal(definition(candidates[removeFile],fn),definition(originals[removeFile],fn));
  for(const source of Object.values(candidates))assert.equal(parse(source).parseDiagnostics.length,0);
});
test('pinned anchors, unknown modules, mutation refusal and repeat-apply safety',()=>{
  assert.equal(deriveOfficialUiHostProjectMoveModule('unknown.js','untouched'),'untouched');
  for(const name of names){assert.equal(sha(originals[name]),hostProjectMoveInputHashes[name]);assert.throws(()=>deriveOfficialUiHostProjectMoveModule(name,originals[name]+'\n'),/Pinned/);assert.throws(()=>deriveOfficialUiHostProjectMoveModule(name,candidates[name]),/Pinned/);}
  for(const rule of hostProjectMoveRules)assert.equal(originals[rule.file].split(rule.before).length,2);
});
test('assembly validates all inputs before writes, records hashes, refuses links and repeated application',t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'f029-feedback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const valid=path.join(dir,'valid');fs.mkdirSync(valid);for(const n of names)fs.writeFileSync(path.join(valid,n),originals[n]);
  const manifest=applyOfficialUiHostProjectMove(valid);assert.equal(manifest.modules.length,2);
  for(const row of manifest.modules){assert.equal(row.inputSha256,sha(originals[row.file]));assert.equal(row.outputSha256,sha(candidates[row.file]));assert.equal(fs.readFileSync(path.join(valid,row.file),'utf8'),candidates[row.file]);}
  assert.throws(()=>applyOfficialUiHostProjectMove(valid),/Pinned/);for(const n of names)assert.equal(fs.readFileSync(path.join(valid,n),'utf8'),candidates[n]);
  const bad=path.join(dir,'bad');fs.mkdirSync(bad);for(const n of names)fs.writeFileSync(path.join(bad,n),originals[n]);fs.appendFileSync(path.join(bad,moveFile),'\n');assert.throws(()=>applyOfficialUiHostProjectMove(bad));assert.equal(fs.readFileSync(path.join(bad,removeFile),'utf8'),originals[removeFile]);
  const linked=path.join(dir,'linked');fs.symlinkSync(valid,linked);assert.throws(()=>applyOfficialUiHostProjectMove(linked),/unlinked/);
  fs.unlinkSync(path.join(bad,moveFile));fs.symlinkSync(path.join(valid,moveFile),path.join(bad,moveFile));assert.throws(()=>applyOfficialUiHostProjectMove(bad),/unlinked/);
});
async function batch(source, ids, answers) {
  const calls=[], rereads=[];let cursor=0;
  const env={J9:()=>[],J3:()=>true,J1:()=>true,K3:(_s,_n,...args)=>args.at(-1),K1:(_s,_n,_v,result)=>result,
    Gb:()=>({mutateAsync:async input=>{calls.push(input);const answer=answers[cursor++];if(answer instanceof Error)throw answer;return answer;}}),
    dm:()=>({}),TR:()=> 'org',_4:(...args)=>rereads.push(args),setTimeout:callback=>callback(),
  };vm.createContext(env);vm.runInContext(definition(source,'nQ'),env);
  let value,failure;try{value=await env.nQ().moveToProject(ids,'project');}catch(error){failure=error;}
  return {calls,rereads,value,failure};
}
test('original batches of 20 and mixed results remain intact without replay; thrown batch stops later work',async()=>{
  const ids=Array.from({length:45},(_,i)=>String(i));
  const answers=[{moved:ids.slice(0,19),failed:[ids[19]]},{moved:ids.slice(20,40),failed:[]},{moved:[],failed:ids.slice(40)}];
  const before=await batch(originals[removeFile],ids,answers),after=await batch(candidates[removeFile],ids,answers);
  equal(after,before);assert.equal(after.calls.length,3);assert.equal(after.value.totalMoved,39);assert.equal(after.value.totalFailed,6);assert.deepEqual(after.calls.map(c=>c.conversation_uuids.length),[20,20,5]);
  for(const source of [originals[removeFile],candidates[removeFile]]){
    const error=new Error('batch save unconfirmed'),r=await batch(source,ids,[answers[0],error]);assert.equal(r.failure,error);assert.equal(r.calls.length,2);equal(error.moved,ids.slice(0,19));
    const empty=await batch(source,[],[]);assert.equal(empty.calls.length,0);assert.equal(empty.value.totalFailed,0);
  }
});
