import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {bindOfficialFrame,normalizeOfficialFrameRequest} from '../src-web/official/frame-lifecycle';
import {negotiatedAppearanceSettings} from '../src-web/official/negotiated-appearance-action';
import {createAppearanceAuthority} from '../runner/src/official-ui-appearance-authority';
const base={method:'PATCH' as const,path:'/api/account/settings',contentType:'application/json'};
const answer=(body:unknown)=>({status:200,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(body))});
test('real foreign Uint8Array crosses frame binding and negotiates exact appearance capability',async()=>{
 const foreign=vm.runInNewContext('new Uint8Array('+JSON.stringify([...Buffer.from('{"chat_font":"serif"}')])+')');assert.equal(foreign instanceof Uint8Array,false);
 let reads=0,saves=0;const identity={};const authority=createAppearanceAuthority({accountId:()=> 'owner',identity:()=>identity,root:()=>'/inert',current:()=>true,enabled:()=>true});
 const action=negotiatedAppearanceSettings({enabled:true,accountId:'owner',current:()=>true,read:async()=>{reads++;return answer(authority.describe())},action:async request=>{saves++;assert(request.body instanceof Uint8Array);assert.notEqual(request.body,foreign);assert(authority.accepts(request.capabilityLease));return answer({chat_font:'serif'})}});
 const frame=bindOfficialFrame({read:async()=>answer({}),action,events:()=>()=>{}},()=>true,'/new',()=>{});
 assert.equal((await frame.bindings.action({...base,body:foreign})).status,200);assert.equal(reads,1);assert.equal(saves,1);
});
test('normalization rejects spoofed tags, non-byte views, proxy, shared bytes and oversized body',()=>{
 const spoof={0:1,length:1,byteLength:1,[Symbol.toStringTag]:'Uint8Array'};
 for(const body of [spoof,new DataView(new ArrayBuffer(2)),new Uint16Array(1),new Int8Array(1),new Uint8ClampedArray(1),new Proxy(new Uint8Array(1),{}),new Uint8Array(new SharedArrayBuffer(1)),new Uint8Array(65537)])assert.throws(()=>normalizeOfficialFrameRequest({...base,body:body as any}));
 const disguised=new Uint16Array(1);Object.defineProperty(disguised,Symbol.toStringTag,{value:'Uint8Array'});assert.throws(()=>normalizeOfficialFrameRequest({...base,body:disguised as any}));
});
test('copies the exact byte view without invoking renderer iterator or property overrides',()=>{
 const foreign=vm.runInNewContext('(()=>{const x=new Uint8Array([9,1,2,8]).subarray(1,3);Object.defineProperty(x,"byteLength",{get(){throw Error("own getter")}});x[Symbol.iterator]=()=>{throw Error("iterator")};return x})()');
 const result=normalizeOfficialFrameRequest({...base,body:foreign});assert.deepEqual([...result.body!],[1,2]);foreign[0]=7;assert.deepEqual([...result.body!],[1,2]);
});
test('realm normalization never enables read-only appearance or retires frame bypass',async()=>{
 const foreign=vm.runInNewContext('new Uint8Array([123,125])');let calls=0;
 const action=negotiatedAppearanceSettings({enabled:false,accountId:'owner',current:()=>true,read:async()=>{calls++;return answer({})},action:async()=>{calls++;return answer({})}});
 const frame=bindOfficialFrame({read:async()=>answer({}),action,events:()=>()=>{}},()=>true,'/new',()=>{});
 assert.equal((await frame.bindings.action({...base,body:foreign})).status,501);assert.equal(calls,0);frame.dispose();await assert.rejects(frame.bindings.action({...base,body:foreign}),/account changed/);assert.equal(calls,0);
});
