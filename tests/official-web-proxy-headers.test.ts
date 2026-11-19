/** Pure emitter contract; no sockets, accounts, or environment mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {devApiOrigin,devRequestCookies,devResponseCookie} from '../vite.web.config';
// @ts-expect-error Local ESM helper.
import {earlyApiHeaders} from '../scripts/official-web-proxy.mjs';
const target='https://service.invalid';
function setup(){const p=new EventEmitter();earlyApiHeaders(target,{devApiOrigin,devRequestCookies,devResponseCookie})(p);return p;}
const headers=()=>({host:'127.0.0.1:5174',origin:'http://127.0.0.1:5174',cookie:'claudex_dev_web_rt=fixture; other=value'});
test('HTTP headers normalized before construction, never on late socket event; response scope retained',()=>{
 const p=setup(), req={headers:headers()};p.emit('start',req);
 assert.equal(req.headers.origin,target);assert.equal(req.headers.cookie,'__Secure-claudex_web_rt=fixture; other=value');
 p.emit('proxyReq',{headersSent:true,setHeader(){throw Error('late write');}},req);
 const res={headers:{'set-cookie':['__Secure-claudex_web_rt_1=fixture; Secure; HttpOnly; SameSite=Lax','other=a; Secure']}};
 p.emit('proxyRes',res,req);assert.deepEqual(res.headers['set-cookie'],['claudex_dev_web_rt_1=fixture; HttpOnly; SameSite=Lax','other=a; Secure']);
});
test('foreign, absent, mismatched, and upstream origins never gain dev cookie alias or response lowering',()=>{
 for(const patch of [{origin:'https://evil.invalid'},{host:'evil.invalid:5174'},{host:'localhost:5174'},{origin:undefined},{origin:target}]){
  const p=setup(),req={headers:{...headers(),...patch}},before={...req.headers};p.emit('start',req);assert.deepEqual(req.headers,before);
  const res={headers:{'set-cookie':['__Secure-claudex_web_rt=x; Secure']}};p.emit('proxyRes',res,req);assert.equal(res.headers['set-cookie'][0],'__Secure-claudex_web_rt=x; Secure');
 }
});
test('existing same-origin fetch without Origin remains supported, only on exact loopback port',()=>{
 const p=setup(),req={headers:{host:'localhost:5174','sec-fetch-site':'same-origin',cookie:'claudex_dev_web_rt=x'}};p.emit('start',req);assert.equal((req.headers as any).origin,target);
 const wrong={headers:{host:'localhost:5175','sec-fetch-site':'same-origin'}};p.emit('start',wrong);assert.equal((wrong.headers as any).origin,undefined);
});
test('WebSocket keeps exact policy and fails closed if header window is already closed',()=>{
 const p=setup(),out:Record<string,string>={};let destroyed=false;
 p.emit('proxyReqWs',{setHeader(k:string,v:string){out[k]=v;}},{headers:headers()});assert.equal(out.Origin,target);assert.match(out.Cookie,/^__Secure-/);
 p.emit('proxyReqWs',{headersSent:true,setHeader(){throw Error('late');},destroy(){destroyed=true;}},{headers:headers()});assert.equal(destroyed,true);
});
