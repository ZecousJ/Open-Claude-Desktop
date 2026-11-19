/** Registered mutation handlers and real session persistence, inert transports/temp files only. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,next){if(s==='../account/google-sign-in'&&c.parentURL?.endsWith('/electron/ipc/remote-auth.ts'))return{shortCircuit:true,url:'data:text/javascript,export function authorizeWithGoogle(){throw Error("unused")};export function cancelGoogleAuthorization(){}'};return next(s,c);}});
const {registerRemoteAuthHandlers}=await import('../../electron/ipc/remote-auth');
const {registerSettingsAccountHandlers}=await import('../../electron/ipc/settings-account');
const {Store}=await import('../../electron/store/store');
const {registerConversationManageHandlers}=await import('../../electron/ipc/conversation-manage-handlers');
const {RemoteSession,SessionFile}=await import('../../electron/sub2api/session');
const {RemoteAccounts}=await import('../../electron/sub2api/identity');
const {Sub2ApiError}=await import('../../electron/sub2api/http');
function defer<T=void>(){let resolve!:(v:T)=>void,reject!:(e:Error)=>void;return{promise:new Promise<T>((a,b)=>{resolve=a;reject=b}),resolve,reject};}
function tmp(t:any){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mutation-lease-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const id='11111111-1111-4111-8111-111111111111';const changed=/account changed/i;
function remoteFixture(){const handlers=new Map<string,Function>(),calls:string[]=[];let session:any,owner='A',generation=1,retiring=false;const context:any={accounts:{hasAccounts:true,policy:async()=>({})},get activeAccount(){return{id:owner}},get session(){return session},get accountActivationIdentity(){return generation},get accountRetiring(){return retiring},deactivate:async()=>{calls.push(owner+'.deactivate')},activate:async()=>{throw Error('unused')}};registerRemoteAuthHandlers((n,h)=>handlers.set(n,h),context);return{calls,context,handlers,setSession:(s:any)=>session=s,rotate:(same=false)=>{owner=same?'A':'B';generation++;},retire:()=>{retiring=true}};}
test('logout cannot switch its session after leaveDevice awaits; same-ID activation also rejects',async()=>{for(const same of [false,true]){const f=remoteFixture(),wait=defer();f.setSession({logout:async()=>f.calls.push('A.logout')});f.context.leaveDevice=async()=>{f.calls.push('A.leave');await wait.promise};const p=f.handlers.get('logoutAccount')!();f.rotate(same);wait.resolve();await assert.rejects(p,changed);assert.deepEqual(f.calls,['A.leave']);}});
test('revoke-all cannot deactivate a replacement; current failure still propagates',async()=>{const f=remoteFixture(),wait=defer();f.setSession({revokeAll:async()=>{f.calls.push('A.revoke');await wait.promise}});const p=f.handlers.get('revokeAllSessions')!();f.rotate();wait.resolve();await assert.rejects(p,changed);assert.deepEqual(f.calls,['A.revoke']);const g=remoteFixture();g.setSession({revokeAll:async()=>{throw Error('inert offline')}});await assert.rejects(g.handlers.get('revokeAllSessions')!(),/inert offline/);assert.deepEqual(g.calls,[]);});
test('legitimate logout retains best-effort local deactivation and revoke succeeds once',async()=>{const f=remoteFixture();f.setSession({logout:async(current:any)=>{assert.equal(current(),true);f.calls.push('logout')}});await f.handlers.get('logoutAccount')!();assert.deepEqual(f.calls,['logout','A.deactivate']);const g=remoteFixture();g.setSession({revokeAll:async(current:any)=>{assert.equal(current(),true);g.calls.push('revoke')}});await g.handlers.get('revokeAllSessions')!();assert.deepEqual(g.calls,['revoke','A.deactivate']);});
function accountFixture(t:any){const calls:string[]=[],handlers=new Map<string,Function>();const root=tmp(t);const remote:any={backend:{client:{deleteAccount:async()=>{calls.push('remote-delete')}},session:{authorized:async(fn:any,current:any)=>{assert.equal(current(),true);return fn('inert')},end:()=>calls.push('end')},accounts:{removeDeleted:async(_id:any,current:any)=>{assert.equal(current(),true);calls.push('profile-remove')}}}};const ctx:any={activeAccount:{id},store:{},accountActivationIdentity:1,accountRetiring:false,remote,accounts:{hasAccounts:false,removeSignedIn:()=>calls.push('local-remove')},dataRoot:root,onAccountActivated:()=>()=>{},onAccountDeactivating:()=>()=>{},deactivate:async()=>{calls.push('deactivate');ctx.accountActivationIdentity++;ctx.activeAccount=undefined;ctx.store=undefined;ctx.remote=undefined;}};registerSettingsAccountHandlers((n,h)=>handlers.set(n,h),ctx);return{ctx,remote,root,calls,run:()=>handlers.get('deleteAccount')!(),rotate:()=>{ctx.accountActivationIdentity++;ctx.activeAccount={id};ctx.store={};}};}
test('deleteAccount after remote await never ends/deactivates a new same-ID activation',async t=>{const f=accountFixture(t),wait=defer();f.remote.backend.client.deleteAccount=async()=>{f.calls.push('remote-delete');await wait.promise};const p=f.run();f.rotate();wait.resolve();await assert.rejects(p,changed);assert.deepEqual(f.calls,['remote-delete']);});
test('deleteAccount cannot remove a new session file after local cleanup await or deactivation reentry',async t=>{for(const phase of ['cleanup','deactivate']){const f=accountFixture(t),wait=defer();if(phase==='cleanup')f.remote.backend.accounts.removeDeleted=async()=>{f.calls.push('profile-remove');await wait.promise};else f.ctx.deactivate=async()=>{f.ctx.accountActivationIdentity++;f.ctx.activeAccount=undefined;await wait.promise};const p=f.run();await new Promise(r=>setImmediate(r));f.rotate();fs.writeFileSync(path.join(f.root,'account-session.enc'),'new-session');wait.resolve();await assert.rejects(p,changed);assert.equal(fs.readFileSync(path.join(f.root,'account-session.enc'),'utf8'),'new-session');if(phase==='deactivate')assert.equal(f.calls.includes('profile-remove'),false);}});
test('legitimate account deletion preserves captured remote/local cleanup and current remote errors',async t=>{const f=accountFixture(t);assert.deepEqual(await f.run(),{hasAccounts:false});assert.deepEqual(f.calls,['remote-delete','end','deactivate','profile-remove']);const g=accountFixture(t);g.ctx.remote=undefined;await g.run();assert.deepEqual(g.calls,['deactivate','local-remove']);const h=accountFixture(t);h.remote.backend.client.deleteAccount=async()=>{throw Error('inert remote refusal')};await assert.rejects(h.run(),/inert remote refusal/);assert.deepEqual(h.calls,[]);});
function conversationFixture(t:any){const root=tmp(t),calls:string[]=[],handlers=new Map<string,Function>();const c:any={id:'same',turns:[],threadId:'thread'};const store:any=new Store(root);store.conversations=[c];store.conversation=()=>c;store.flush=()=>calls.push('flush');const write=store.write.bind(store);store.write=(name:any,value:any)=>{write(name,value);calls.push('write');};let actual=store,generation=1;const context:any={get store(){return actual},replyFeedback:{deleteConversation:()=>calls.push('feedback')},accountGeneration:()=>generation,closeTerminals:async()=>{}};let engine:any;registerConversationManageHandlers({context,handle:(n,h)=>handlers.set(n,h),engineOf:()=>engine});return{calls,c,store,context,run:()=>handlers.get('deleteConversation')!('same'),setEngine:(x:any)=>engine=x,rotate:(same=false)=>{generation++;if(!same)actual={...store,conversations:[{...c}]};return actual}};}
test('deleteConversation rejects account/store switch or same-store activation after terminal closure',async t=>{for(const same of [false,true]){const f=conversationFixture(t),wait=defer();f.context.closeTerminals=async()=>wait.promise;const p=f.run();const replacement=f.rotate(same);wait.resolve();await assert.rejects(p,changed);assert.equal(replacement.conversations.length,1);assert.deepEqual(f.calls,[]);}});
test('deleteConversation stops after archival await and rejects same-ID object replacement',async t=>{for(const replace of [false,true]){const f=conversationFixture(t),wait=defer();let archived=0;f.c.savedBranches=[{threadId:'later'}];f.setEngine({rpc:{call:async()=>{archived++;await wait.promise}}});const p=f.run();await new Promise(r=>setImmediate(r));if(replace)f.store.conversations=[{...f.c}];else f.rotate();wait.resolve();await assert.rejects(p,changed);assert.equal(archived,1);assert.deepEqual(f.calls,[]);}});
test('legitimate conversation delete keeps archived-thread failure tolerance',async t=>{const f=conversationFixture(t);f.setEngine({rpc:{call:async()=>{throw Error('inert archive unavailable')}}});await f.run();assert.equal(f.store.conversations.length,0);assert.deepEqual(f.calls,['flush','feedback']);});
const cipher={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()};
const record={version:1 as const,baseUrl:'https://fixture.invalid',accountId:id,userId:1,email:'fixture@example.invalid',refreshToken:'inert-old'};
function sessionFixture(t:any){const root=tmp(t),file=new SessionFile(root,cipher);file.save(record);const client:any={logout:async()=>{},revokeAllSessions:async()=>{},refresh:async()=>({accessToken:'inert-access',refreshToken:'inert-next',expiresIn:3600})};const session=new RemoteSession(client,file,record,{accessToken:'inert-access',refreshToken:'inert-old',expiresIn:3600});let live=true;return{file,client,session,current:()=>live,retire:()=>{live=false;file.save({...record,refreshToken:'new-owner-file'})}};}
test('real RemoteSession late logout/revoke cannot clear replacement session persistence',async t=>{for(const method of ['logout','revokeAll'] as const){const f=sessionFixture(t),wait=defer();f.client[method==='logout'?'logout':'revokeAllSessions']=async()=>wait.promise;const p=f.session[method](f.current);await new Promise(r=>setImmediate(r));f.retire();wait.resolve();await assert.rejects(p,changed);assert.equal(f.file.load()?.refreshToken,'new-owner-file');}});
test('guarded refresh cannot save over a replacement file or emit revoked callbacks',async t=>{for(const failure of [false,true]){const f=sessionFixture(t),wait=defer<any>();f.client.refresh=async()=>wait.promise;let revoked=0;f.session.onSignedOut=()=>revoked++;const p=f.session.refresh(f.current);await new Promise(r=>setImmediate(r));f.retire();if(failure)wait.reject(new Sub2ApiError(401,'SESSION_REVOKED','inert'));else wait.resolve({accessToken:'late',refreshToken:'late',expiresIn:3600});await assert.rejects(p,changed);assert.equal(f.file.load()?.refreshToken,'new-owner-file');assert.equal(revoked,0);}});
test('joining an in-flight refresh installs the guarded caller fence before persistence',async t=>{const f=sessionFixture(t),wait=defer<any>();f.client.refresh=async()=>wait.promise;const p=f.session.refresh();const guarded=f.session.refresh(f.current);assert.equal(p,guarded);await new Promise(r=>setImmediate(r));f.retire();wait.resolve({accessToken:'late',refreshToken:'late',expiresIn:3600});await assert.rejects(p,changed);assert.equal(f.file.load()?.refreshToken,'new-owner-file');});
test('legacy session methods without guard and current guarded refresh retain original success',async t=>{const f=sessionFixture(t);await f.session.refresh(f.current);assert.equal(f.file.load()?.refreshToken,'inert-next');await f.session.logout();assert.equal(f.file.load(),undefined);});
test('real removeDeleted guards both parked-session awaits and final profile removal',async t=>{for(const parked of [false,true]){const root=tmp(t),accounts=new RemoteAccounts(root,'https://fixture.invalid',cipher,async()=>{throw Error('Unexpected external request')});const profile=path.join(root,'profiles',id);fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'owned'),'new-profile');let live=true;const wait=defer<'legacy'>();if(parked){accounts.parked.save(record);accounts.serviceKind=async()=>wait.promise;}const p=accounts.removeDeleted(id,()=>live);live=false;wait.resolve('legacy');await assert.rejects(p,changed);assert.equal(fs.readFileSync(path.join(profile,'owned'),'utf8'),'new-profile');if(parked)assert.equal(accounts.parked.load(id)?.refreshToken,'inert-old');}});

test('authorized 401 retry refresh is fenced before saving and before a second remote revoke',async t=>{
 const f=sessionFixture(t),wait=defer<any>();let calls=0,refreshes=0;
 f.client.revokeAllSessions=async()=>{calls++;throw new Sub2ApiError(401,'TOKEN_EXPIRED','inert expiry')};
 f.client.refresh=async()=>{refreshes++;return wait.promise};
 const p=f.session.revokeAll(f.current);await new Promise(r=>setImmediate(r));assert.equal(refreshes,1);
 f.retire();wait.resolve({accessToken:'late',refreshToken:'late',expiresIn:3600});await assert.rejects(p,changed);
 assert.equal(calls,1);assert.equal(f.file.load()?.refreshToken,'new-owner-file');
});
test('current authorized 401 refresh/retry succeeds while genuine current failures retain original error',async t=>{
 const f=sessionFixture(t);let calls=0;f.client.revokeAllSessions=async()=>{if(++calls===1)throw new Sub2ApiError(401,'TOKEN_EXPIRED','inert expiry')};
 await f.session.revokeAll(f.current);assert.equal(calls,2);assert.equal(f.file.load(),undefined);
 const g=sessionFixture(t),failure=Error('inert original service failure');g.client.revokeAllSessions=async()=>{throw failure};
 await assert.rejects(g.session.revokeAll(g.current),e=>e===failure);assert.equal(g.file.load()?.refreshToken,'inert-old');
});
test('already retired session guard performs no dispatch and unknown guard identity fails closed',async t=>{
 const f=sessionFixture(t);let calls=0;f.client.logout=async()=>{calls++};f.client.revokeAllSessions=async()=>{calls++};f.client.refresh=async()=>{calls++;throw Error('unexpected')};
 for(const method of ['logout','revokeAll','refresh'] as const)await assert.rejects(async()=>f.session[method](()=>false),changed);
 await assert.rejects(async()=>f.session.logout(()=>{throw Error('sensitive identity failure')}),changed);assert.equal(calls,0);assert.equal(f.file.load()?.refreshToken,'inert-old');
});
test('legacy remote auth caller without new identity fields keeps its captured session path',async()=>{
 const handlers=new Map<string,Function>(),calls:string[]=[];const session:any={logout:async(current:any)=>{assert.equal(current(),true);calls.push('logout')},revokeAll:async(current:any)=>{assert.equal(current(),true);calls.push('revoke')}};
 registerRemoteAuthHandlers((n,h)=>handlers.set(n,h),{accounts:{hasAccounts:false,policy:async()=>({})},session,activate:async()=>{throw Error('unused')},deactivate:async()=>{calls.push('deactivate')}} as any);
 await handlers.get('logoutAccount')!();await handlers.get('revokeAllSessions')!();assert.deepEqual(calls,['logout','deactivate','revoke','deactivate']);
});

test('refresh retired before deferred dispatch never calls transport and does not retain a rejected shared run',async t=>{
 const f=sessionFixture(t);let live=true,calls=0;f.client.refresh=async()=>{calls++;return{accessToken:'fresh',refreshToken:'fresh',expiresIn:3600}};
 const p=f.session.refresh(()=>live);live=false;await assert.rejects(p,changed);assert.equal(calls,0);
 await f.session.refresh(()=>true);assert.equal(calls,1);assert.equal(f.file.load()?.refreshToken,'fresh');
});

test('actual Chat bulk route plus registered deletion handler abort on store or same-account activation retirement',async t=>{
 const {conversationsRoute}=await import('../../electron/official-ui/api/conversations');
 const {organizationUuid}=await import('../../electron/official-ui/api/context');
 const {Readable}=await import('node:stream');
 for(const same of [false,true]){
  const f=conversationFixture(t),wait=defer();f.c.mode='chat';f.context.closeTerminals=async()=>wait.promise;
  const captured=f.context.accountGeneration(),calls:string[]=[];
  const ctx:any={account:()=>({id:'A'}),sessionIdentity:()=>f.context.accountGeneration(),isCurrent:()=>f.context.accountGeneration()===captured,readOnly:false,
   loadConversation:async(id:string)=>id==='same'?f.c:{id,mode:'chat'},
   call:async(name:string,id:string)=>{assert.equal(name,'deleteConversation');calls.push(id);assert.equal(id,'same');return f.run();}};
  const p=`/api/organizations/${organizationUuid('A')}/chat_conversations/delete_many`;
  const req:any=Readable.from([Buffer.from(JSON.stringify({conversation_uuids:['same','second']}))]);req.method='POST';req.headers={'content-type':'application/json'};
  let code=0;const res:any={writeHead:(n:number)=>{code=n},end:()=>{}};
  const pending=conversationsRoute(req,res,p,new URL(p,'http://inert.invalid'),ctx);
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['same']);const replacement=f.rotate(same);wait.resolve();await pending;
  assert.equal(code,409);assert.equal(replacement.conversations.length,1);assert.deepEqual(calls,['same']);assert.deepEqual(f.calls,[]);
 }
});

test("successful Chat deletion publishes resync after the row is removed", async (t) => {
  const f = conversationFixture(t);
  f.c.mode = "chat";
  f.context.push = (event: unknown) => {
    assert.equal(f.store.conversations.length, 0);
    assert.deepEqual(event, { type: "resync" });
    f.calls.push("resync");
  };
  await f.run();
  assert.deepEqual(f.calls, ["write", "feedback", "resync"]);
  assert.equal(new Store(f.store.root).conversations.length, 0);
});
