import test from "node:test";
import assert from "node:assert/strict";
import {createNativeInvocationScope} from "../electron/official-ui/native/invocation-scope";
import {inAdapterScope,newAdapterScope} from "../electron/official-ui/api/scope";
test("native authority is not replaced by a preferences/foreign adapter persistence scope",async()=>{
  let current=true,release!:()=>void,calls=0;
  const scope=createNativeInvocationScope({call:async()=>{calls++;await new Promise<void>(r=>release=r);return"private";}} as any);
  const pending=scope.run({current:()=>current},()=>inAdapterScope(newAdapterScope("foreign"),()=>scope.context.call("read")));
  current=false;release();await assert.rejects(pending,/account window has retired/);assert.equal(calls,1);
});
test("native subscription reinstates caller lease under foreign emitter and detaches on retirement",()=>{
  let current=true,listener:(event:any)=>void=()=>{},offs=0,reads=0;
  const scope=createNativeInvocationScope({account:()=>{reads++;return{id:"a"};},onEvent:(cb:any)=>{listener=cb;return()=>offs++;}} as any);
  scope.run({current:()=>current},()=>scope.context.onEvent(()=>{scope.context.account();}));
  inAdapterScope(newAdapterScope("foreign"),()=>listener({type:"resync"}));assert.equal(reads,1);
  current=false;listener({type:"resync"});listener({type:"resync"});assert.equal(reads,1);assert.equal(offs,1);
});
test("synchronous subscription consumer error disposes the acquired listener once",()=>{
  let offs=0;
  const scope=createNativeInvocationScope({onEvent:(cb:any)=>{cb({type:"resync"});return()=>offs++;}} as any);
  assert.throws(()=>scope.run({current:()=>true},()=>scope.context.onEvent(()=>{throw Error("consumer");})),/consumer/);assert.equal(offs,1);
});
test('a function acquired by an old native invocation cannot borrow an unscoped or newer caller lease',async()=>{
 let oldCurrent=true,calls=0;const scope=createNativeInvocationScope({call:async()=>{calls++;return 'inert';}} as any);
 const method=scope.run({current:()=>oldCurrent},()=>scope.context.call);
 oldCurrent=false;
 await assert.rejects(Promise.resolve().then(()=>method('read')),/account window has retired/);
 await assert.rejects(Promise.resolve().then(()=>scope.run({current:()=>true},()=>method('read'))),/account window has retired/);
 assert.equal(calls,0);
});
test('a retired async invocation checks before a nonfunction accessor can read replacement state',async()=>{
 let current=true,reads=0,release!:()=>void;
 const original:any={};Object.defineProperty(original,'appVersion',{get(){reads++;return 'replacement';}});
 const scope=createNativeInvocationScope(original);const wait=new Promise<void>(r=>release=r);
 const pending=scope.run({current:()=>current},async()=>{await wait;return scope.context.appVersion;});
 current=false;release();await assert.rejects(pending,/account window has retired/);assert.equal(reads,0);
});

test('isCurrent remains a boolean query and bootstrap methods retain their existing unscoped behavior',()=>{
 let active=true,calls=0;const scope=createNativeInvocationScope({isCurrent:()=>true,account:()=>{calls++;return {id:'inert'};}} as any);
 assert.equal(scope.context.account()?.id,'inert');
 const query=scope.run({current:()=>active},()=>scope.context.isCurrent!);active=false;assert.equal(query(),false);assert.equal(calls,1);
});

test('an event lease identity lookup failure detaches without delivering the event',()=>{
 let broken=false,off=0,delivered=0,emit:()=>void=()=>{};
 const scope=createNativeInvocationScope({onEvent:(fn:()=>void)=>{emit=fn;return()=>off++;}} as any);
 scope.run({current:()=>{if(broken)throw Error('inert identity fault');return true;}},()=>scope.context.onEvent(()=>delivered++));
 broken=true;assert.doesNotThrow(()=>emit());emit();assert.equal(off,1);assert.equal(delivered,0);
});

test('retired isCurrent property access returns false without invoking an accessor',async()=>{
 let active=true,reads=0,release!:()=>void;const original:any={};Object.defineProperty(original,'isCurrent',{get(){reads++;return()=>true;}});
 const scope=createNativeInvocationScope(original),wait=new Promise<void>(r=>release=r);
 const result=scope.run({current:()=>active},async()=>{await wait;return scope.context.isCurrent?.();});
 active=false;release();assert.equal(await result,false);assert.equal(reads,0);
});
