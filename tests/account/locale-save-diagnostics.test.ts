import test from 'node:test';import assert from 'node:assert/strict';
import {localeSaveStage,withLocaleSaveDiagnostics} from '../../electron/official-ui/api/locale-save-diagnostics';
test('locale-only scope emits fixed data, preserves original error and never invokes getters/Proxy traps',async()=>{
 const logs:unknown[][]=[];let getter=0,traps=0;const error=new Error('SECRET_URL_PATH_ID');Object.defineProperty(error,'name',{get(){getter++;return 'SECRET'}});
 for(const thrown of [error,new Proxy(error,{get(){traps++;throw error},getPrototypeOf(){traps++;throw error},getOwnPropertyDescriptor(){traps++;throw error}}),'SECRET']){
  let caught:unknown;try{await withLocaleSaveDiagnostics((...x)=>logs.push(x),async()=>{localeSaveStage('native-schema');throw thrown});}catch(e){caught=e;}assert.equal(caught,thrown);
 }
 assert.equal(getter,0);assert.equal(traps,0);assert.doesNotMatch(JSON.stringify(logs),/SECRET|https:|file:/);assert.ok(logs.every(row=>row.length===2&&row.every(x=>typeof x==='string')));
 localeSaveStage('native-schema');assert.equal(logs.length,9);
 await withLocaleSaveDiagnostics(()=>{throw Error('logger failure')},async()=>localeSaveStage('complete'));
});
test('concurrent requests remain separate; detached notify/device work after completion cannot retain logging scope',async()=>{
 const a:unknown[][]=[],b:unknown[][]=[];let later!:()=>void,release!:()=>void;const wait=new Promise<void>(r=>release=r);
 await Promise.all([withLocaleSaveDiagnostics((...x)=>a.push(x),async()=>{localeSaveStage('native-notify');later=await new Promise<()=>void>(resolve=>setImmediate(()=>resolve(()=>localeSaveStage('device-refresh-after'))));await wait;localeSaveStage('complete');}),withLocaleSaveDiagnostics((...x)=>b.push(x),async()=>{localeSaveStage('native-schema');release();})]);
 const before=a.length;later();assert.equal(a.length,before);assert.equal(b.length,2);assert.match(String(a[1]),/native-notify/);assert.match(String(b[1]),/native-schema/);
 // Callback created inside the async scope and invoked by its timer after completion.
 let finish!:()=>void;const done=new Promise<void>(r=>finish=r);await withLocaleSaveDiagnostics((...x)=>a.push(x),async()=>{setTimeout(()=>{localeSaveStage('device-refresh-after');finish()},10)});const after=a.length;await done;assert.equal(a.length,after);
});
