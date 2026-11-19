/** Actual loopback server request callback; HTTP listener replaced, never opens sockets. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { createOfficialActivationLease } from "../electron/official-ui/activation-lease";
import { authorizeRetiredTerminalResponse } from "../electron/official-ui/response-lease";
const callbacks: ((req:any,res:any)=>Promise<void>)[]=[];
let port=30000, closes=0;
(globalThis as any).__inertActivationHttp={createServer:(callback:any)=>{
  callbacks.push(callback);const server=Object.assign(new EventEmitter(),{
    listen(){queueMicrotask(()=>server.emit("listening"));},address:()=>({port:++port}),close:(done?:()=>void)=>{closes++;done?.();},
  });return server;
}};
registerHooks({resolve(specifier,context,next){
  if(specifier==="node:http" && context.parentURL?.endsWith("/electron/official-ui/server.ts"))return{shortCircuit:true,url:"data:text/javascript,export default globalThis.__inertActivationHttp;"};
  return next(specifier,context);
}});
const {startOfficialUiServer,cookieName}=await import("../electron/official-ui/server");
class Response extends EventEmitter {
  headersSent=false;destroyed=false;status=0;chunks:Buffer[]=[];
  headers=new Map<string,unknown>();
  setHeader(name:string,value:unknown){this.headers.set(name.toLowerCase(),value);}
  getHeaderNames(){return [...this.headers.keys()];} removeHeader(name:string){this.headers.delete(name.toLowerCase());}
  writeHead(status:number,headers?:Record<string,unknown>){this.status=status;for(const [name,value] of Object.entries(headers??{}))this.setHeader(name,value);this.headersSent=true;return this;}
  write(data:Uint8Array|string){this.headersSent=true;this.chunks.push(Buffer.from(data));return true;}
  end(data?:Uint8Array|string){if(data)this.chunks.push(Buffer.from(data));this.emit("finish");return this;}
  destroy(){this.destroyed=true;this.emit("close");return this;}
  get text(){return Buffer.concat(this.chunks).toString();}
}
function deferred(){let resolve!:()=>void;return{promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};}
async function fixture(t:any,api:(req:any,res:any)=>Promise<boolean>, extra: {forbiddenPorts?: Set<number>} = {}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"activation-http-"));fs.mkdirSync(path.join(root,"ui"));fs.writeFileSync(path.join(root,"ui/index.html"),"inert");t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let identity={owner:"a",store:{},generation:1,active:true};
  const lease=createOfficialActivationLease(identity,()=>identity);
  const server=await startOfficialUiServer({root,api,isCurrent:()=>lease.current(),responseLease:lease,reusePort:false,...extra});
  const callback=callbacks.at(-1)!;
  return{lease,server,change:()=>{identity={owner:"b",store:{},generation:2,active:true};},
    request(url="/api/fixture",extra:any={}){const res=new Response();const req={url,method:"POST",headers:{cookie:`${cookieName}=${server.token}`,...extra}};return{res,done:callback(req,res)};}};
}
test("immutable activation never revives on A to B to A regardless of storage reuse",()=>{
  const a={owner:"a",store:{},generation:1,active:true};let current=a;
  const lease=createOfficialActivationLease(a,()=>current);assert.equal(lease.current(),true);assert.equal("partition" in lease,false);
  current={owner:"b",store:{},generation:2,active:true};assert.equal(lease.current(),false);current=a;assert.equal(lease.current(),false);
  const next=createOfficialActivationLease(a,()=>current);assert.notEqual(lease,next);assert.equal(next.current(),true);
});
test("actual retired server rejects old authorized cookie on every path, including forged logout headers",async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return true;});f.lease.retire();
  for(const url of ["/api/fixture","/api/auth/logout","/new"]){const r=f.request(url,{"x-terminal-response":"true"});await r.done;assert.equal(r.res.status,410);}
  assert.equal(calls,0);
});
test("admitted pending response cannot emit body after account replacement",async t=>{
  const wait=deferred();const f=await fixture(t,async(_req,res)=>{await wait.promise;res.writeHead(200);res.end("new-account-data");return true;});
  const r=f.request();f.change();wait.resolve();await r.done;
  assert.equal(r.res.status,410);assert.equal(r.res.text.includes("new-account-data"),false);
});
test("started SSE is disconnected on retirement instead of appending another account event",async t=>{
  const wait=deferred();const f=await fixture(t,async(_req,res)=>{res.writeHead(200);res.write("owned-prefix");await wait.promise;res.write("foreign-event");res.end();return true;});
  const r=f.request();f.lease.retire();wait.resolve();await r.done;
  assert.equal(r.res.destroyed,true);assert.equal(r.res.text,"owned-prefix");
});
test("only the actual admitted host signout call authorizes its own success or failure terminal response",async t=>{
  const wait=deferred();let lease!:ReturnType<typeof createOfficialActivationLease>;
  const f=await fixture(t,async(_req,res)=>{const complete=authorizeRetiredTerminalResponse(lease,"logoutAccount");await wait.promise;complete?.(true);res.writeHead(204);res.end();return true;});lease=f.lease;
  const r=f.request("/api/auth/logout");lease.retire();wait.resolve();await r.done;assert.equal(r.res.status,204);
  const replay=f.request("/api/auth/logout");await replay.done;assert.equal(replay.res.status,410);
  assert.throws(()=>authorizeRetiredTerminalResponse(lease,"logoutAccount"),/no longer belongs/);
});
test("one request's logout authority cannot authorize a concurrent request or different activation",async t=>{
  let calls=0;const wait=deferred();let lease!:ReturnType<typeof createOfficialActivationLease>;
  const f=await fixture(t,async(_req,res)=>{const complete=++calls===1?authorizeRetiredTerminalResponse(lease,"logoutAccount"):undefined;await wait.promise;complete?.(false);res.writeHead(400);res.end("operation-result");return true;});lease=f.lease;
  const first=f.request(),second=f.request();lease.retire();wait.resolve();await Promise.all([first.done,second.done]);
  assert.equal(first.res.status,400);assert.equal(first.res.text.includes("operation-result"),false);assert.equal(second.res.status,410);assert.equal(second.res.text.includes("operation-result"),false);
});


test("all unsent retired responses discard accumulated headers, and terminal success emits only fixed empty204",async t=>{
  for(const terminal of [false,true]){
    const wait=deferred();let lease!:ReturnType<typeof createOfficialActivationLease>;
    const f=await fixture(t,async(_req,res)=>{
      const complete=terminal?authorizeRetiredTerminalResponse(lease,"logoutAccount"):undefined;
      res.setHeader("Set-Cookie","private-account-token");res.setHeader("X-Private","account-metadata");
      await wait.promise;complete?.(true);res.writeHead(200,{"X-Late":"private"});res.write("private-body");res.end("more-private-body");return true;
    });lease=f.lease;const r=f.request();lease.retire();wait.resolve();await r.done;
    assert.equal(r.res.status,terminal?204:410);assert.equal(r.res.headers.has("set-cookie"),false);assert.equal(r.res.headers.has("x-private"),false);assert.equal(r.res.headers.has("x-late"),false);
    assert.equal(r.res.text.includes("private-body"),false);if(terminal)assert.equal(r.res.text,"");
  }
});
test("terminal authorization without observed operation completion cannot bypass retirement",async t=>{
  const wait=deferred();let lease!:ReturnType<typeof createOfficialActivationLease>;
  const f=await fixture(t,async(_req,res)=>{authorizeRetiredTerminalResponse(lease,"logoutAccount");await wait.promise;res.writeHead(204);res.end();return true;});
  lease=f.lease;const r=f.request();lease.retire();wait.resolve();await r.done;assert.equal(r.res.status,410);
});


test("lease identity is shallow immutable and a throwing host identity source retires permanently",()=>{
  const store={mutable:1},input={owner:"a",store,generation:1,active:true};let fail=false;
  const lease=createOfficialActivationLease(input,()=>{if(fail)throw Error("host failure");return{owner:"a",store,generation:1,active:true};});
  input.owner="b";input.generation=2;assert.equal(lease.current(),true);
  assert.throws(()=>Object.assign(lease.identity,{owner:"b"}),TypeError);assert.equal(lease.identity.owner,"a");
  store.mutable=2;assert.equal(lease.current(),true);fail=true;assert.equal(lease.current(),false);fail=false;assert.equal(lease.current(),false);
});


test("actual server allocation refuses reused retired ports and retries only its own listener",async t=>{
  const forbidden=new Set([port+1]),before=closes;
  const f=await fixture(t,async()=>true,{forbiddenPorts:forbidden});
  assert.equal(forbidden.has(Number(new URL(f.server.origin).port)),false);assert.equal(closes,before+1);
});
test("repeated forbidden port allocation fails bounded instead of reusing an old origin",async t=>{
  const forbidden=new Set(Array.from({length:17},(_,i)=>port+i+1)),before=closes;
  await assert.rejects(fixture(t,async()=>true,{forbiddenPorts:forbidden}),/fresh interface origin/);
  assert.equal(closes,before+16);
});

test('activation retirement subscription is synchronous once-only and late subscribers observe retirement',()=>{
  const store={};const identity={owner:'A',store,generation:1,active:true};const lease=createOfficialActivationLease(identity,()=>identity);const calls:string[]=[];
  lease.onRetire(()=>{calls.push('first');assert.equal(lease.current(),false);});
  const off=lease.onRetire(()=>calls.push('removed'));off();
  lease.onRetire(()=>{calls.push('throws');throw Error('inert listener');});
  lease.onRetire(()=>calls.push('last'));
  assert.doesNotThrow(()=>lease.retire());lease.retire();
  lease.onRetire(()=>calls.push('late'));assert.deepEqual(calls,['first','throws','last','late']);assert.equal(lease.current(),false);
});
test('detected owner/store/generation changes and getter faults synchronously notify and never revive',()=>{
  for(const field of ['owner','store','generation','active','throw']){
    let next={owner:'A',store:{},generation:1,active:true};const original=next;let fail=false;
    const lease=createOfficialActivationLease(next,()=>{if(fail)throw Error('inert');return next;});let calls=0;lease.onRetire(()=>calls++);
    if(field==='owner')next={...next,owner:'B'};else if(field==='store')next={...next,store:{}};else if(field==='generation')next={...next,generation:2};else if(field==='active')next={...next,active:false};else fail=true;
    assert.equal(lease.current(),false);assert.equal(calls,1);next=original;fail=false;assert.equal(lease.current(),false);assert.equal(calls,1);
  }
});
test('reentrant retirement and unsubscribe do not invoke a removed pending consumer',()=>{
  const identity={owner:'A',store:{},generation:1,active:true};const lease=createOfficialActivationLease(identity,()=>identity);const calls:string[]=[];let off=()=>{};
  lease.onRetire(()=>{calls.push('first');off();lease.retire();lease.onRetire(()=>calls.push('late'));});off=lease.onRetire(()=>calls.push('removed'));
  lease.retire();assert.deepEqual(calls,['first','late']);
});
