import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {createHash} from 'node:crypto';import {build,transform} from 'esbuild';
import {WorkspaceTrustStore} from '../electron/workspace/workspace-trust';
import {registerExperimentalCodeSessions} from '../electron/official-ui/native/code-sessions';
import {registerResources} from '../electron/official-ui/native/resources';
import type {NativeHandler} from '../electron/official-ui/native/host';
import {brandedModule} from '../scripts/official-web-assets.mjs';
import {deriveOfficialUiHostCapabilityModule} from '../scripts/official-ui-host-capabilities.mjs';
import {deriveOfficialUiHostInstalledPluginsModule} from '../scripts/official-ui-host-installed-plugins.mjs';
import {deriveOfficialUiHostWorkspaceTrustModule as derive,hostWorkspaceTrustOriginalHashes as original,hostWorkspaceTrustInputHashes as inputs,hostWorkspaceTrustMessages as messages} from '../scripts/official-ui-host-workspace-trust.mjs';
const archive='.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1';const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const raw=(f:string)=>fs.readFileSync(path.join(archive,f),'utf8');
function input(f:string){const s=raw(f);assert.equal(sha(s),original[f]);return deriveOfficialUiHostInstalledPluginsModule(f,deriveOfficialUiHostCapabilityModule(f,brandedModule(s)));}
function extract(s:string,a:string,b:string){const start=s.indexOf(a),end=s.indexOf(b,start);assert.ok(start>=0&&end>start,[a,b].join(' '));return s.slice(start,end)}
function memo(c:any,cache:any[]=[]){c.J9=()=>cache;for(let i=0;i<6;i++){c['J'+i]=()=>true;c['K'+i]=(...a:any[])=>a.at(-1);c['I'+i]=(_s:any,_n:any,v:any)=>v}return c}

test('actual native checkTrust carries true root for child/root/non-repository, never writes trust',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trust-scope-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 // The environment may have a .git ancestor; an injected read-only root check covers no-repo below separately.
 const repo=path.join(tmp,'repo'),child=path.join(repo,'child');fs.mkdirSync(path.join(repo,'.git'),{recursive:true});fs.mkdirSync(child);let writes=0;
 const store=new WorkspaceTrustStore(()=>({codexHome:path.join(tmp,'home'),writeCodexProjects:async()=>{writes++;return true}}));
 const handlers=new Map<string,Function>();let checked:string[]=[];let result:any;
 registerExperimentalCodeSessions({ctx:{account:()=>({id:'synthetic'}),sessionIdentity:()=>1,onEvent:()=>()=>{},localCall:async(name:string,folder:string)=>{assert.equal(name,'checkWorkspaceTrust');checked.push(folder);return result??store.check(folder)}},on:(n:string,f:Function)=>handlers.set(n,f),emit(){}} as any);
 for(const folder of[child,repo]){const found=await handlers.get('LocalSessions.checkTrust')!(folder);assert.equal(found.claudexTrustRoot,repo);assert.equal(found.trusted,false);assert.deepEqual(found.sources,[])}
 // Non-Git contract remains the original service's exact folder/root, not guessed by the adapter.
 const standalone=path.join(tmp,'standalone');fs.mkdirSync(standalone);const rootSource=fs.readFileSync('electron/workspace/workspace-trust.ts','utf8');const plain=await transform(extract(rootSource,'export function codexProjectRoot(', '/** A worktree'),{loader:'ts',format:'cjs'});const isolated:any={exports:{},module:{exports:{}},path,fs:{statSync:()=>{throw Error('ENOENT')}},worktreeMainRoot:()=>undefined};isolated.exports=isolated.module.exports;vm.runInNewContext(plain.code,isolated);const standaloneRoot=isolated.module.exports.codexProjectRoot(standalone);assert.equal(standaloneRoot,standalone);result={folder:standalone,root:standaloneRoot,trusted:false,sources:[]};assert.equal((await handlers.get('LocalSessions.checkTrust')!(standalone)).claudexTrustRoot,standalone);
 assert.deepEqual(checked,[child,repo,standalone]);assert.equal(writes,0);
});

test('pinned modules derive deterministically and remain valid JavaScript',async()=>{for(const f of Object.keys(inputs)){const s=input(f);assert.equal(sha(s),inputs[f]);const out=derive(f,s);assert.notEqual(out,s);await transform(out,{loader:'js'});assert.throws(()=>derive(f,s+' '),/input mismatch/)} });

test('actual original trust query/pending producer retains cwd, sources and additive root',async()=>{
 const f='ce2cf86ad-xBQnhcQf.js',source=derive(f,input(f));let state:any;const c:any=memo({a:{warn(){},__errorMarked(){}},i:{DESKTOP_API:'test'},e:()=>null,t:()=>undefined,E:{},L:()=>({checkTrust:async()=>({trusted:false,sources:['real-hook'],claudexTrustRoot:'/repo'})}),s:(init:Function)=>{state=init((patch:any)=>{state={...state,...(typeof patch==='function'?patch(state):patch)}},()=>state);return {getState:()=>state}}});vm.createContext(c);
 vm.runInContext(extract(source,'function v(e)','var C =')+extract(source,'var C =','var E ='),c);state.registerGate('synthetic');
 vm.runInContext(extract(source,'function z()','function B()'),c);const awaiting=c.z()('/repo/child');await new Promise(resolve=>setImmediate(resolve));assert.equal(state.pending.cwd,'/repo/child');assert.equal(state.pending.claudexTrustRoot,'/repo');assert.deepEqual(Array.from(state.pending.sources),['real-hook']);state.resolvePending(false);assert.equal(await awaiting,'declined');
 // Save remains original cwd, not the displayed repository root.
 const gate=derive('c516e93ca-D70RQPy8.js',input('c516e93ca-D70RQPy8.js'));assert.ok(gate.includes('await I(N.cwd, N.remote)'));assert.ok(!gate.includes('await I(N.claudexTrustRoot'));
});

test('prefetching a trusted SSH folder never skips folder selection for a different key', async t => {
 const file = 'ce2cf86ad-xBQnhcQf.js';
 const source = derive(file, input(file));
 const shared = raw('shared-m-4-CbJwwS_m.js');
 const {g: QueryClient} = await import(path.resolve(archive, 'vendor-query-CdfkcLg6.js'));
 const client = new QueryClient();
 t.after(() => client.clear());
 const folder = '/home/ubuntu';
 const endpoint = {kind: 'ssh', sshHost: 'ubuntu@localhost', sshPort: 2222};
 const first = {...endpoint, sshIdentityFile: '/keys/first'};
 const second = {...endpoint, sshIdentityFile: '/keys/second'};
 const hosts = new Map<unknown, string>([[first.sshIdentityFile, 'first'], [second.sshIdentityFile, 'second'], [undefined, 'default']]);
 const selected: unknown[][] = [];
 const handlers = new Map<string, NativeHandler>();
 registerResources({
  ctx: {
   account: () => ({id: 'synthetic'}),
   localCall: async (method: string, ...args: unknown[]) => {
    switch (method) {
     case 'officialSshTarget': {
      const target = args[0];
      assert.ok(target && typeof target === 'object' && 'sshIdentityFile' in target);
      const hostId = hosts.get(target.sshIdentityFile);
      assert.ok(hostId);
      return {kind: 'ssh', hostId};
     }
     case 'sshStatus': return {state: 'ready'};
     case 'checkWorkspaceTrust': return {trusted: true, sources: []};
     case 'sshChooseFolder': selected.push(args); return;
     default: throw Error(method);
    }
   },
  },
  on: (name: string, fn: NativeHandler) => handlers.set(name, fn),
 } as never);
 const c = vm.createContext(memo({o: () => client, r: {
  checkRemoteTrust: handlers.get('LocalSessions.checkRemoteTrust'),
 }}));
 vm.runInContext(extract(shared, 'function JN(e)', 'function $U(e)') + 'const d = JN;\n' +
  extract(source, 'function v(e)', 'function y(') +
  extract(source, 'var A = 3e5;', 'function R()'), c);
 const {checkTrust, prefetchTrust} = c.L();

 await prefetchTrust(folder, first);
 assert.equal((await checkTrust(folder, second)).trusted, true);
 assert.deepEqual(selected, [['first', folder], ['second', folder]]);
 c.F(client, folder, first);
 assert.equal(c.P(client, folder, first), false);
 assert.equal(c.P(client, folder, second), true);

 const defaultSsh = {kind: 'ssh', sshHost: 'ubuntu@localhost'};
 await prefetchTrust(folder, defaultSsh);
 assert.equal(c.P(client, folder, {...defaultSsh, sshPort: 22, sshIdentityFile: ''}), true);
 assert.deepEqual(selected.at(-1), ['default', folder]);
});

function renderDialog(root:any,cache:any[],locale='en-US'){
 const f='c165c93f1-d-JWv0qg.js',source=derive(f,input(f));const c:any=memo({d:()=>({locale,formatMessage:({defaultMessage}:any,values:any={})=>defaultMessage.replace('{root}',values.root??'')}),T:()=>null,r:(type:any,props:any)=>({type,props}),t:(type:any,props:any)=>({type,props}),P:'path',u:'intl',s:'badge',x:'details',o:'dialog',S:'title',C:'description',w:'accept',A:'path-style',M:'note-style',j:'box',O:80,N:(x:any)=>x,D:()=>null,I:()=>null,__claudexTrustMessages:messages},cache);
 c.J8=Symbol.for('react.memo_cache_sentinel');const frame=raw('shared-frame-DH1u5uQk.js');vm.createContext(c);vm.runInContext(extract(frame,'function J0(','function I3('),c);vm.runInContext(extract(source,'function F(e)','function I(e)'),c);return c.F({isOpen:true,workspace:'/repo/child',workspaceRoot:root,sources:[],onAccept:()=>{},onDecline:()=>{}});
}
test('actual compiled dialog memo displays root, removes stale notice, and leaves original cwd/source untouched',()=>{
 const cache=Array(30).fill(Symbol.for('react.memo_cache_sentinel'));
 let rendered=JSON.stringify(renderDialog('/repo',cache));assert.ok(rendered.includes('Trusting applies to the whole repository at /repo.'));assert.ok(rendered.includes('/repo/child'));
 rendered=JSON.stringify(renderDialog('/repo/child',cache));assert.ok(!rendered.includes('Trusting applies'));
 for(const invalid of[undefined,null,42,'','bad\nroot'])assert.ok(!JSON.stringify(renderDialog(invalid,cache)).includes('Trusting applies'));
 assert.ok(JSON.stringify(renderDialog('/new-root',cache)).includes('at /new-root.'));
 assert.ok(JSON.stringify(renderDialog('/repo',cache,'en-US')).includes('Trusting applies'));
 assert.ok(JSON.stringify(renderDialog('/repo',cache,'zh-CN')).includes('信任将应用于位于 /repo 的整个仓库。'));
});

test('scope translations are exact existing classic catalog entries, with English fallback',async()=>{for(const [locale,value] of Object.entries(messages)){const catalog=(await import('../shared/i18n/catalogs/'+locale+'.ts')).default;assert.equal(value,catalog['Trusting applies to the whole repository at {root}.'])}assert.equal(Object.keys(messages).length,11)});

test('bundled transform has identical canonical bytes and direct trust branches carry only display root',async()=>{
 const built=await build({entryPoints:['scripts/official-ui-host-workspace-trust.mjs'],bundle:true,platform:'node',format:'cjs',write:false,minify:true});const module={exports:{} as any};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:(id:string)=>id==='node:fs'?fs:id==='node:path'?path:{createHash}});
 for(const f of Object.keys(inputs))assert.equal(module.exports.deriveOfficialUiHostWorkspaceTrustModule(f,input(f)),derive(f,input(f)));
 const branch=derive('cc43287c9-BDrqHHqn.js',input('cc43287c9-BDrqHHqn.js'));assert.ok(branch.includes('claudexTrustRoot: r.claudexTrustRoot'));assert.ok(branch.includes('workspaceRoot: N.claudexTrustRoot'));assert.ok(branch.includes('let e = he.cwd;\n                  try {\n                    await ce(e);'));
 const customize=derive('c6a2a31c4-Ctc4FG8F.js',input('c6a2a31c4-Ctc4FG8F.js'));assert.ok(customize.includes('workspaceRoot: s.claudexTrustRoot'));assert.ok(customize.includes('await a(s.cwd)'));
});


test('actual picker Vbe effect preserves native root through requestTrust pending to original dialog; cancel never saves',async()=>{
 const fixed=derive('cc43287c9-BDrqHHqn.js',input('cc43287c9-BDrqHHqn.js'));
 const previous='let n = await x(e, t.sources, i);';
 const patched='let n = await x(e, t.sources, i, { claudexTrustRoot: t.claudexTrustRoot });';
 assert.equal(fixed.split(patched).length-1,1);
 const query=derive('ce2cf86ad-xBQnhcQf.js',input('ce2cf86ad-xBQnhcQf.js'));
 for(const [source,expectedRoot]of [[fixed.replace(patched,previous),undefined],[fixed,'/repo']] as const){
  let state:any,accepted=0,cancelled=0,checks=0;
  const c:any=memo({a:{warn(){},__errorMarked(){}},i:{DESKTOP_API:'inert'},s:(init:Function)=>{state=init((patch:any)=>state={...state,...(typeof patch==='function'?patch(state):patch)},()=>state);const select:any=(fn:Function)=>fn(state);select.getState=()=>state;return select;},t:()=>undefined,E:{}});
  vm.createContext(c);vm.runInContext(extract(query,'function v(e)','var C =')+extract(query,'var C =','var E =')+extract(query,'function D()','function k()'),c);state.registerGate('synthetic');
  const at=source.indexOf(expectedRoot?patched:previous),start=source.lastIndexOf('(async () => {',at),end=source.indexOf('})(),',at);assert.ok(start>0&&end>at);
  Object.assign(c,{e:'/repo/child',i:undefined,_:async(folder:string)=>{checks++;assert.equal(folder,'/repo/child');return{trusted:false,sources:['actual-source'],claudexTrustRoot:'/repo'}},a:false,s:{current:true},gN:{getState:()=>state},x:c.D(),N:()=>true,d:()=>accepted++,m:()=>cancelled++,c:()=>{},A:()=>{},u:{},cD:()=>{},iz:()=>{}});
  const pending=vm.runInContext(source.slice(start,end+2)+'()',c);await new Promise(r=>setImmediate(r));
  assert.equal(state.pending.cwd,'/repo/child');assert.equal(state.pending.claudexTrustRoot,expectedRoot);assert.deepEqual(Array.from(state.pending.sources),['actual-source']);assert.equal(state.pending.remote,undefined);
  const rendered=JSON.stringify(renderDialog(state.pending.claudexTrustRoot,Array(30).fill(Symbol.for('react.memo_cache_sentinel'))));
  assert.equal(rendered.includes('Trusting applies to the whole repository at /repo.'),expectedRoot!==undefined);
  state.resolvePending(false);await pending;assert.equal(accepted,0);assert.equal(cancelled,1);assert.equal(checks,1);assert.equal(state.pending,null);
 }
});
