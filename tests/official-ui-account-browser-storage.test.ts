import test from 'node:test';
import assert from 'node:assert/strict';
import {accountBrowserStorage,prepareAccountBrowserStorage} from '../electron/official-ui/account-browser-storage';
test('same account and root use stable persistent storage and origin record; accounts remain separate',()=>{
 const a=accountBrowserStorage('a','/inert/accounts/a','/inert/profile');
 assert.deepEqual(accountBrowserStorage('a','/inert/accounts/a','/inert/profile'),a);
 assert.ok(a.partition.startsWith('persist:'));assert.notEqual(a.partition,'persist:official-ui');
 assert.notEqual(accountBrowserStorage('b','/inert/accounts/b','/inert/profile').partition,a.partition);
 assert.notEqual(accountBrowserStorage('a','/inert/other/a','/inert/profile').partition,a.partition);
 assert.throws(()=>accountBrowserStorage('','/inert','/inert'));
 assert.throws(()=>accountBrowserStorage('a','relative','/inert'));
});
test('storage reuse waits for response and startup, destroys old documents then closes old server',async()=>{
 const order:string[]=[];let alive=true;
 await prepareAccountBrowserStorage([{settle:async()=>{order.push('settle')},closePending:async()=>{order.push('pending')},destroy(){order.push('destroy');alive=false},hasDocuments:()=>alive,closeServer:async()=>{order.push('close')}}],()=>true);
 assert.deepEqual(order,['settle','destroy','pending','close']);
});
test('destroy failure or surviving document prevents reuse; retirement during await also rejects',async()=>{
 for(const throws of [false,true]){
 let closed=0;
 await assert.rejects(prepareAccountBrowserStorage([{settle:async()=>{},closePending:async()=>{},destroy(){if(throws)throw Error('destroy')},hasDocuments:()=>true,closeServer:async()=>{closed++}}],()=>true));assert.equal(closed,0);
 }
 let current=true, destroyed=0;
 await assert.rejects(prepareAccountBrowserStorage([{settle:async()=>{current=false},closePending:async()=>{},destroy(){destroyed++},hasDocuments:()=>false,closeServer:async()=>{}}],()=>current));assert.equal(destroyed,0);
});
