import test from "node:test";
import assert from "node:assert/strict";
import {createRetirementCoordinator} from "../electron/official-ui/retirement-coordinator";
import {createOfficialActivationLease} from "../electron/official-ui/activation-lease";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;return{promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};}
test("recovery requires host deactivation, exact operation settlement and real response handoff",async()=>{
 let pending=1,active=false,recoveries=0;const key={};const response=deferred();
 const c=createRetirementCoordinator({pendingOperations:()=>pending,hasActiveAccount:()=>active,recover:async current=>{assert.equal(current(),true);recoveries++;},diagnostic:()=>{throw Error("unexpected");}});
 c.retire(key,response.promise);c.deactivated(key);c.settled(key);await tick();assert.equal(recoveries,0);
 pending=0;c.poke();await tick();assert.equal(recoveries,0);response.resolve();await tick();assert.equal(recoveries,1);
 c.settled(key);c.signedOut(key);await tick();assert.equal(recoveries,1);
});
test("late old settlement and forced notification cannot authorize newer retirement or replace active candidate",async()=>{
 let active=false,recoveries=0;const old={},newer={};const c=createRetirementCoordinator({pendingOperations:()=>0,hasActiveAccount:()=>active,recover:async()=>{recoveries++;},diagnostic:()=>{}});
 c.retire(old,Promise.resolve());c.retire(newer,Promise.resolve());c.deactivated(newer);c.settled(old);c.signedOut(old);await tick();assert.equal(recoveries,0);
 active=true;c.signedOut(newer);await tick();assert.equal(recoveries,0);active=false;c.poke();await tick();assert.equal(recoveries,1);
});
test("recovery in flight loses authority when a new retirement takes ownership",async()=>{
 const wait=deferred();let captured:()=>boolean=()=>false;const old={},newer={};
 const c=createRetirementCoordinator({pendingOperations:()=>0,hasActiveAccount:()=>false,recover:async current=>{captured=current;await wait.promise;},diagnostic:()=>{}});
 c.retire(old,Promise.resolve());c.deactivated(old);c.settled(old);await tick();assert.equal(captured(),true);
 c.retire(newer,Promise.resolve());assert.equal(captured(),false);wait.resolve();await tick();
});
test("retired responses have a bounded own-resource abort outcome, including stalled streams and failed abort",async()=>{
 const identity={owner:"a",store:{},generation:1,active:true};const lease=createOfficialActivationLease(identity,()=>identity);
 const finish=deferred();let aborts=0;lease.trackResponse({finished:finish.promise,abort:()=>{aborts++;finish.resolve();}});lease.retire();
 assert.deepEqual(await lease.settleResponses(5),{timedOut:true,unconfirmed:0});assert.equal(aborts,1);
 const other=createOfficialActivationLease(identity,()=>identity);other.trackResponse({finished:new Promise(()=>{}),abort:()=>{throw Error("inert");}});other.retire();
 assert.deepEqual(await other.settleResponses(5),{timedOut:true,unconfirmed:1});
});
test("close-before-finish completes handoff without aborting unrelated response resources",async()=>{
 const identity={owner:"a",store:{},generation:1,active:true},lease=createOfficialActivationLease(identity,()=>identity);let aborts=0;
 lease.trackResponse({finished:Promise.resolve(),abort:()=>{aborts++;}});lease.retire();assert.deepEqual(await lease.settleResponses(10),{timedOut:false,unconfirmed:0});assert.equal(aborts,0);
});

test("stalled transition reports once without pretending completion; late real settlement can recover",async()=>{
 let pending=1,reports=0,recoveries=0;const key={};const c=createRetirementCoordinator({pendingOperations:()=>pending,hasActiveAccount:()=>false,recover:async()=>{recoveries++;},diagnostic:()=>{},stalled:current=>{assert.equal(current(),true);reports++;},timeoutMs:5});
 c.retire(key,Promise.resolve());await new Promise(r=>setTimeout(r,12));assert.equal(reports,1);assert.equal(recoveries,0);
 pending=0;c.deactivated(key);c.settled(key);await tick();assert.equal(recoveries,1);
 await new Promise(r=>setTimeout(r,8));assert.equal(reports,1);
});
