import { stagedDocumentCurrent } from "../electron/app/staged-document-lease";
/** Actual classic createWindow with inert direct dependencies; no Electron or auth. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {EventEmitter} from "node:events";
import {registerHooks} from "node:module";
const source=fs.readFileSync(new URL("../electron/app/main-window.ts",import.meta.url),"utf8");
const mocks:Record<string,Record<string,unknown>>={};
for(const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)){
 const[,names,specifier]=match;if(specifier==="../official-ui/staged-window"||specifier==="./staged-document-lease")continue;
 mocks[specifier]=Object.fromEntries(names.split(",").map(n=>n.trim()).filter(n=>n&&!n.startsWith("type ")).map(n=>[n,()=>{throw Error(`Unexpected inert dependency ${specifier}:${n}`);} ]));
}
const noop=()=>{},roles=new Map(),made:FakeWindow[]=[];
let load:Promise<void>|undefined,query:unknown;
let officialDelivery: (take: () => boolean) => Promise<boolean> = async () => false;
const state:any={store:{},accountRetirement:{accountActivationIdentity:1},window:undefined,activeAccount:undefined,zoomLevel:0,signInShape:false,started:true};
class FakeWindow extends EventEmitter{
 destroyed=false;visible=false;maxCalls=0;fullCalls=0;failDestroy=false;
 webContents={session:{setPermissionRequestHandler:noop,setPermissionCheckHandler:noop}};
 constructor(options:any={}){super();this.visible=options.show!==false;made.push(this);}
 isDestroyed(){return this.destroyed;}isMaximized(){return false;}isFullScreen(){return false;}getBounds(){return{x:0,y:0,width:800,height:600};}setBounds(){}getTitle(){return"Claudex";}setTitle(){}
 maximize(){this.maxCalls++;this.visible=true;}setFullScreen(){this.fullCalls++;this.visible=true;}show(){this.visible=true;}showInactive(){this.visible=true;}hide(){this.visible=false;}
 destroy(){if(this.failDestroy)throw Error("inert destroy failure");this.destroyed=true;this.emit("closed");}minimize(){}
}
Object.assign(mocks.electron,{app:{getPath:()=>"/not-read"},BrowserWindow:FakeWindow,nativeTheme:{shouldUseDarkColors:false},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1200,height:900}}),getAllDisplays:()=>[],getDisplayMatching:()=>({workArea:{x:0,y:0,width:1200,height:900}})}});
Object.assign(mocks["./main-state"],{mainState:state});
Object.assign(mocks["../official-ui/window"],{openOfficialDeepLink: (_win: unknown,_link: unknown,take: () => boolean) => officialDelivery(take)});
Object.assign(mocks["../main"],{appWindowRoles:roles,mainWindowFile:()=>"/not-read",appWindows:{webPreferences:()=>({}),closeConversationWindows:noop},artifactPopouts:{closeAll:noop},artifactPreviews:{clear:noop},integration:{hasTray:()=>true},ctx:{},appWindowOf:()=>undefined});
Object.assign(mocks["./main-window-state"],{mainWindowPlacement:()=>({}),minMainWindowSize:{width:1,height:1},readMainWindowState:()=>({maximized:true,fullScreen:true}),trackMainWindow:noop,signInWindowSize:{width:600,height:600}});
Object.assign(mocks["./main-window-chrome"],{mainWindowChrome:()=>({})});
Object.assign(mocks["./app-window-registry"],{registerAppWindow:(win:FakeWindow)=>{roles.set(win,{kind:"main"});win.once("closed",()=>roles.delete(win));},loadRenderer:async(_win:any,value:any)=>{query=value;await load;}});
Object.assign(mocks["../updates/stealth-window"],{takeStealthWindow:()=>undefined});
(globalThis as any).__classicRecoveryMocks=mocks;
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith("/electron/app/main-window.ts")&&mocks[specifier])return{shortCircuit:true,url:"data:text/javascript,"+encodeURIComponent(`const m=globalThis.__classicRecoveryMocks[${JSON.stringify(specifier)}];`+Object.keys(mocks[specifier]).map(n=>`export const ${n}=m.${n};`).join(""))};return next(specifier,context);}});
const{createWindow,deliverPendingDeepLink}=await import("../electron/app/main-window");
function deferred(){let resolve!:()=>void,reject!:(e:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function reset(){roles.clear();load=undefined;query=undefined;state.activeAccount=undefined;state.signInShape=false;state.pendingConnectorLink=undefined;state.pendingDeepLink=undefined;state.pendingEmailLink=undefined;state.window=new FakeWindow();return state.window;}
test("staged classic stays hidden including maximize/fullscreen until successful load and exact main commit",async()=>{
 const old=reset(),wait=deferred();load=wait.promise;const pending=createWindow({stage:{current:()=>true}});const candidate=made.at(-1)!;
 assert.equal(state.window,old);assert.equal(candidate.visible,false);assert.equal(candidate.maxCalls,0);assert.equal(candidate.fullCalls,0);
 wait.resolve();assert.equal(await pending,candidate);assert.equal(state.window,candidate);assert.equal(candidate.visible,true);assert.equal(candidate.maxCalls,1);assert.equal(candidate.fullCalls,1);
});
test("stale classic candidate does not clear links or replace new main; own bridge role revoked even if destroy fails",async()=>{
 const old=reset(),wait=deferred();load=wait.promise;state.pendingEmailLink="old-link";let current=true;
 const pending=createWindow({stage:{current:()=>current}}),candidate=made.at(-1)!;candidate.failDestroy=true;
 assert.deepEqual(query,{"email-link":"old-link"});assert.equal(state.pendingEmailLink,"old-link");
 current=false;const replacement=new FakeWindow();state.window=replacement;state.pendingEmailLink="new-link";wait.resolve();
 await assert.rejects(pending,/destroy failure/);assert.equal(roles.has(candidate),false);assert.equal(state.window,replacement);assert.equal(state.pendingEmailLink,"new-link");assert.equal(old.destroyed,false);
 candidate.failDestroy=false;candidate.destroy();
});
test("load failure preserves pending deep links; successful commit clears only the link actually consumed",async()=>{
 reset();const wait=deferred();load=wait.promise;state.pendingEmailLink="email";state.pendingConnectorLink="connector";state.pendingDeepLink="conversation";
 const failed=createWindow({stage:{current:()=>true}});wait.reject(Error("load failure"));await assert.rejects(failed,/load failure/);
 assert.equal(state.pendingEmailLink,"email");assert.equal(state.pendingConnectorLink,"connector");assert.equal(state.pendingDeepLink,"conversation");
 load=undefined;await createWindow({stage:{current:()=>true}});assert.equal(state.pendingEmailLink,undefined);assert.equal(state.pendingConnectorLink,"connector");assert.equal(state.pendingDeepLink,"conversation");
});
test("a signed-out launch link stays queued until a window for the first activation can receive it", async () => {
  reset();
  const link = { href: "claudex://new?q=draft", link: { kind: "new", mode: "chat", prompt: "draft" } };
  state.pendingDeepLink = link;
  await createWindow();
  assert.equal(query, undefined);
  await deliverPendingDeepLink();
  assert.equal(state.pendingDeepLink, link);

  state.activeAccount = { id: "first" };
  const deliveries: boolean[] = [];
  officialDelivery = async take => { deliveries.push(take()); return true; };
  try {
    state.accountRetirement.accountRetiring = true;
    await deliverPendingDeepLink();
    assert.deepEqual(deliveries, []);
    assert.equal(state.pendingDeepLink, link);
    state.accountRetirement.accountRetiring = false;
    await deliverPendingDeepLink();
    await deliverPendingDeepLink();
    assert.deepEqual(deliveries, [true]);
    assert.equal(state.pendingDeepLink, undefined);
  } finally {
    state.accountRetirement.accountRetiring = false;
    officialDelivery = async () => false;
  }
});
test("the signed-in classic replacement receives the link in its boot URL", async () => {
  reset();
  const href = "claudex://new?q=draft";
  state.pendingDeepLink = { href, link: { kind: "new", mode: "chat", prompt: "draft" } };
  const signIn = await createWindow();
  assert.equal(query, undefined);
  state.activeAccount = { id: "first" };
  const wait = deferred();
  load = wait.promise;
  const opening = createWindow({ stage: { current: () => true } });
  assert.equal(state.window, signIn);
  assert.deepEqual(query, { deeplink: href });
  assert.equal(state.pendingDeepLink?.href, href);
  wait.resolve();
  const signedIn = await opening;
  assert.equal(state.window, signedIn);
  assert.equal(state.pendingDeepLink, undefined);
});
test("account changes supersede a desktop link still resolving on the old activation", async () => {
  reset();
  state.activeAccount = { id: "first" };
  state.pendingDeepLink = { href: "claudex://conversation/old", link: { kind: "conversation", id: "old" } };
  const wait = deferred();
  const deliveries: boolean[] = [];
  officialDelivery = async take => { await wait.promise; deliveries.push(take()); return true; };
  try {
    const opening = deliverPendingDeepLink();
    state.activeAccount = { id: "second" };
    state.accountRetirement.accountActivationIdentity++;
    state.window = new FakeWindow();
    await deliverPendingDeepLink();
    wait.resolve();
    await opening;
    assert.deepEqual(deliveries, [false]);
    assert.equal(state.pendingDeepLink, undefined);
  } finally {
    officialDelivery = async () => false;
  }
});

test("actual staged document denies IPC admission during pending load and after committed activation replacement",async()=>{
 reset();const wait=deferred();load=wait.promise;
 const pending=createWindow({stage:{current:()=>true}}),candidate=made.at(-1)!;
 assert.equal(stagedDocumentCurrent(candidate),true);
 state.accountRetirement.accountActivationIdentity++;
 assert.equal(stagedDocumentCurrent(candidate),false);
 state.accountRetirement.accountActivationIdentity--;
 assert.equal(stagedDocumentCurrent(candidate),false);
 state.accountRetirement.accountActivationIdentity++;
 wait.resolve();await assert.rejects(pending,/retired|cancel|activation/i);
 assert.equal(stagedDocumentCurrent(candidate),false);
 reset();load=undefined;const committed=await createWindow({stage:{current:()=>true}});
 assert.equal(stagedDocumentCurrent(committed),true);
 state.store={};assert.equal(stagedDocumentCurrent(committed),false);
 assert.equal(stagedDocumentCurrent(new FakeWindow()),true);
});

test("pending staged document immediately retires when transaction is cancelled without identity change",async()=>{
 reset();const wait=deferred();load=wait.promise;let current=true;
 const pending=createWindow({stage:{current:()=>current}}),candidate=made.at(-1)!;
 assert.equal(stagedDocumentCurrent(candidate),true);current=false;
 assert.equal(stagedDocumentCurrent(candidate),false);current=true;
 assert.equal(stagedDocumentCurrent(candidate),false);wait.resolve();
 await assert.rejects(pending,/retired|cancel|activation/i);
});
