import test from "node:test";
import assert from "node:assert/strict";
import {observeAccountTransition,pendingAccountTransitions,onAccountTransition,accountDeactivated,signingOut} from "../electron/app/account-transition-events";
test("only six actual transition methods are counted; sync and async validation failures settle their own token",async()=>{
 const events:any[]=[];const off=onAccountTransition(e=>events.push(e));const identity={store:{},generation:1};
 assert.equal(observeAccountTransition("saveSettings",identity,()=>7),7);assert.equal(events.length,0);
 await assert.rejects(Promise.resolve(observeAccountTransition("switchAccount",identity,()=>{throw Error("invalid args");})),/invalid args/);
 await assert.rejects(Promise.resolve(observeAccountTransition("addAccount",identity,()=>Promise.reject(Error("invalid async")))),/invalid async/);
 assert.equal(pendingAccountTransitions(),0);assert.deepEqual(events.map(e=>e.type),["begin","settled","begin","settled"]);assert.equal(events[0].token,events[1].token);assert.notEqual(events[0].token,events[2].token);off();
});
test("late old operation cannot settle another operation, and listener failure never changes the original result",async t=>{
 const log=t.mock.method(console,"error",()=>{});const off=onAccountTransition(()=>{throw Error("private observer");});
 let oldDone!:(value:number)=>void,newDone!:(value:number)=>void;
 const old=observeAccountTransition("logoutAccount",{store:{},generation:1},()=>new Promise<number>(r=>oldDone=r));
 const newer=observeAccountTransition("switchAccount",{store:{},generation:2},()=>new Promise<number>(r=>newDone=r));
 assert.equal(signingOut(),true);
 assert.equal(pendingAccountTransitions(),2);oldDone(1);assert.equal(await old,1);assert.equal(pendingAccountTransitions(),1);
 assert.equal(signingOut(),false);
 newDone(2);assert.equal(await newer,2);assert.equal(pendingAccountTransitions(),0);assert.ok(log.mock.callCount()>0);
 assert.doesNotThrow(()=>accountDeactivated({},3));off();
});
