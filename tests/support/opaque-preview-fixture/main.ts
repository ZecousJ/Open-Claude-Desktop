/** Dedicated inert fixture executable. NEVER imported by the product entry.
 * Launch only in an explicitly coordinated new cloud native window/session. */
import {app,BrowserWindow,session,ipcMain,MessageChannelMain,type MessagePortMain,type WebFrameMain} from 'electron';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createOpaquePreviewSession,type PreviewPort} from '../../../electron/official-ui/opaque-preview-session';
import {createFixtureRequestGate,fixtureOrigin,tagHeader} from './request-gate';
import {hostHtml,hostCsp,blankHtml,blankCsp,shellDocument,inertArtifact} from './documents';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-inert-preview-'));
app.setPath('userData',profile);
const hostURL=fixtureOrigin+'/host',blankURL=fixtureOrigin+'/blank';
void app.whenReady().then(async()=>{
 const isolated=session.fromPartition('inert-preview-'+randomUUID());
 isolated.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));isolated.setPermissionCheckHandler(()=>false);
 const window=new BrowserWindow({width:860,height:620,title:'Claudex inert preview fixture',webPreferences:{session:isolated,preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,navigateOnDragDrop:false}});
 let epoch:unknown={},alive=true,tree:number|undefined,shellURL='',initialNavigation=false,rendered=false;
 let preview:ReturnType<typeof createOpaquePreviewSession>|undefined,gate:ReturnType<typeof createFixtureRequestGate>|undefined;
 const status=(value:string)=>{if(alive&&!window.isDestroyed())window.webContents.send('inert-fixture-status',value);};
 let keepReplacement=false;
 const diagnostics={beforeRequest:0,beforeHeaders:0,protocol:0,owner:false,subFrame:false,nativeFrame:false,tree:false,parent:false,initial:false};
 const retire=(keep=false)=>{keepReplacement=keep;gate?.retire();preview?.revoke();keepReplacement=false;};
 const frameNow=()=>window.webContents.mainFrame.frames.find(frame=>frame.frameTreeNodeId===tree);
 const trustedSender=(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent)=>alive&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame;
 const port=(raw:MessagePortMain,after?:()=>void,onClose?:()=>void):PreviewPort&{raw:MessagePortMain}=>{
  const wrapper:PreviewPort&{raw:MessagePortMain}={raw,onmessage:null,postMessage:value=>raw.postMessage(value),close:()=>{try{raw.close();}finally{onClose?.();}},start:()=>raw.start()};
  raw.on('message',event=>{wrapper.onmessage?.({data:event.data});after?.();});return wrapper;
 };
 const prepare=(frame:WebFrameMain)=>{
  const activation=epoch,preparedURL=shellURL,channel=new MessageChannelMain();rendered=false;
  const closed=()=>{if(alive&&epoch===activation&&!keepReplacement)window.webContents.send("inert-fixture-clear",preparedURL);};
  const hostPort=port(channel.port1,()=>{if(preview?.state==='ready'&&!rendered){rendered=true;const sent=preview.renderInertHtml(inertArtifact);status(sent?'Private channel proved. Fixed text sent to the trusted shell for nested inert rendering.':'Frame retired before content transfer; no accepted render.');}},closed);
  const shellPort=port(channel.port2);
  preview=createOpaquePreviewSession({lease:{account:'explicit-inert-fixture',activation,window:window.webContents},currentLease:()=>alive?{account:'explicit-inert-fixture',activation:epoch,window:window.webContents}:undefined,
   frame:{currentWindow:()=>frameNow(),isConnected:()=>alive&&!window.isDestroyed()&&!frame.isDestroyed(),bootstrap(target,message,transfer){if(target!==frame||frameNow()!==frame||transfer!==shellPort)throw Error('Retired fixture frame');window.webContents.postMessage('inert-fixture-bootstrap',{resourceURL:preparedURL,bootstrap:message},[shellPort.raw]);}},ports:{host:hostPort,shell:shellPort},lifetimeMs:30000,onSize:()=>status('Nested frame load/size notification received. Inspect the fixed text visually; no tool/network capability.')});
  gate=createFixtureRequestGate({webContentsId:window.webContents.id,frame,url:shellURL,epoch:activation,currentEpoch:()=>epoch,current:()=>alive&&frameNow()===frame&&!frame.isDestroyed()&&preview?.state!=='revoked'});
 };
 // All URL schemes reachable from the documents are blocked except these fixed
 // in-memory HTTPS responses. There is no net.fetch or external fallback.
 isolated.protocol.handle('https',request=>{
  if(request.url===shellURL)diagnostics.protocol++;
  const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
  if(request.method!=='GET')return new Response('Unavailable',{status:405});
  if(request.url===hostURL)return new Response(hostHtml,{headers:{...headers,'Content-Security-Policy':hostCsp}});
  if(request.url===blankURL)return new Response(blankHtml,{headers:{...headers,'Content-Security-Policy':blankCsp}});
  if(request.url!==shellURL||!preview||!gate?.consume(request.method,request.url,request.headers))return new Response('Unavailable',{status:403});
  const document=shellDocument(preview.shellProof);
  return new Response(document.html,{headers:{...headers,'Content-Security-Policy':document.csp}});
 });
 isolated.webRequest.onBeforeRequest((details,callback)=>{
  if(details.url===shellURL)diagnostics.beforeRequest++;
  const sameOwner=alive&&details.webContentsId===window.webContents.id;
  const fixed=sameOwner&&details.method==='GET'&&((details.url===hostURL&&details.resourceType==='mainFrame')||((details.url===shellURL||details.url===blankURL)&&details.resourceType==='subFrame'&&details.frame?.frameTreeNodeId===tree));
  callback({cancel:!fixed});
 });
 isolated.webRequest.onBeforeSendHeaders((details,callback)=>{
  const clean=Object.fromEntries(Object.entries(details.requestHeaders).filter(([name])=>name.toLowerCase()!==tagHeader));
  if(details.url!==shellURL){callback({requestHeaders:clean});return;}
  const frame=details.frame;
  diagnostics.beforeHeaders++;Object.assign(diagnostics,{owner:details.webContentsId===window.webContents.id,subFrame:details.resourceType==='subFrame',nativeFrame:!!frame&&!frame.isDestroyed(),tree:frame?.frameTreeNodeId===tree,parent:frame?.parent===window.webContents.mainFrame,initial:initialNavigation});
  if(!alive||!initialNavigation||details.webContentsId!==window.webContents.id||details.resourceType!=='subFrame'||!frame||frame.isDestroyed()||frame.frameTreeNodeId!==tree||frame.parent!==window.webContents.mainFrame){callback({cancel:true,requestHeaders:clean});return;}
  // The capability is minted from Electron metadata, not a renderer header.
  // If this callback is absent for intercepted HTTPS, protocol.consume refuses.
  if(!preview)prepare(frame);
  callback(gate!.authorize({...details,frame,requestHeaders:clean}));
 });
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',event=>{event.preventDefault();retire();});
 window.webContents.on('will-frame-navigate',event=>{
  if(event.isMainFrame){if(event.url!==hostURL)event.preventDefault();return;}
  if(event.frame?.frameTreeNodeId!==tree)return;
  if(!initialNavigation&&event.url===shellURL){initialNavigation=true;return;}
  retire();status('Document navigation revoked the old channel before replacement.');
  if(event.url!==blankURL)event.preventDefault();
 });
 ipcMain.handle('inert-fixture-bind',event=>{
  if(!trustedSender(event))throw Error('Unavailable');retire();epoch={};preview=undefined;gate=undefined;initialNavigation=false;
  const frames=window.webContents.mainFrame.frames.filter(frame=>frame.name==='claudex-inert-shell');
  if(frames.length!==1)throw Error('Fixture frame not ready; retry opening.');
  tree=frames[0].frameTreeNodeId;shellURL=fixtureOrigin+'/shell/'+randomUUID();status('Fixed shell bound; waiting for trusted native request metadata.');return shellURL;
 });
 ipcMain.handle('inert-fixture-retire',(event,mode)=>{if(!trustedSender(event))throw Error('Unavailable');retire(mode==='navigate');status('Channel revoked. Previously loaded content has no live port.');return blankURL;});
 ipcMain.handle('inert-fixture-probe',async event=>{
  if(!trustedSender(event))throw Error('Unavailable');
  // This is a fixed local protocol request, never a network fallback. Missing
  // native subFrame identity must deny even when an arbitrary tag is supplied.
  try{const answer=await isolated.fetch(shellURL||fixtureOrigin+'/shell/unbound',{headers:{[tagHeader]:'0'.repeat(64)}});status(answer.status===403?'Main-process read denied (403).':'Unexpected probe result; fixture not accepted.');}catch{status('Main-process read blocked before private response.');}
 });
 ipcMain.on('inert-fixture-loaded',(event,proxyUnchanged)=>{
  if(!trustedSender(event))return;
  if(preview?.state==='created'){
   // Renderer load is only a wake-up; native committed URL and consumed private
   // request gate, not its boolean, decide whether the shell can receive a port.
   if(frameNow()?.url!==shellURL||gate?.consumed!==true)return;
   if(!preview.bootstrap())status('Native frame identity changed; refused bootstrap.');
  }
  else if(preview?.state==='revoked'&&frameNow()?.url===blankURL)status('Replacement loaded; same WindowProxy = '+(proxyUnchanged===true)+'. Old channel remains revoked.');
  else if(!preview)status('No authenticated request tag. Shell not accepted. Diagnostics (counts/booleans only): '+JSON.stringify(diagnostics));
 });
 window.on('close',()=>{alive=false;epoch={};retire();});
 window.on('closed',()=>{for(const name of ['inert-fixture-bind','inert-fixture-retire','inert-fixture-probe'])ipcMain.removeHandler(name);ipcMain.removeAllListeners('inert-fixture-loaded');app.quit();});
 await window.loadURL(hostURL);
}).catch(()=>{console.error('Inert preview fixture could not initialize. No account or preview opened.');app.quit();});
