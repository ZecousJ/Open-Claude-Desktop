/** Standalone inert fixture only, not a product entry or arbitrary preview host. */
import {app,BrowserWindow,session,ipcMain,MessageChannelMain} from 'electron';
import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
import {probeMode,createProbeFailureLatch,type ProbeMode} from './cases';
import {hostHtml,baseCsp,shellDocument} from './documents';import {createHandshake,readyForMount} from './handshake';
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'claudex-trusted-inert-')));
function listen(server:Server){return new Promise<number>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')reject(Error('No loopback listener'));else resolve(a.port);});});}
void app.whenReady().then(async()=>{
 let parentOrigin='',shellOrigin='',mount='',alive=true,epoch=0,tree:number|undefined,initialRequested=false,initialNavigationSeen=false;
 let mode:ProbeMode='plain',attempt=0;let onProbe=()=>{};const failure=createProbeFailureLatch(()=>onProbe());
 let mainRequested=false,mainNavigationSeen=false,nestedNavigationSeen=false,nestedTree:number|undefined;
 let handshake:ReturnType<typeof createHandshake>|undefined,channel:MessageChannelMain|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const serve=(role:'parent'|'shell')=>(req:IncomingMessage,res:ServerResponse)=>{
  const origin=role==='parent'?parentOrigin:shellOrigin;
  if(req.url==='/probe'){failure.listenerReached();fs.appendFileSync(path.join(__dirname,'diagnostics.jsonl'),JSON.stringify({kind:'listener-probe-reached',role,activeMode:mode,activeAttempt:attempt})+'\n');}
  const reject=(status:number)=>{res.writeHead(status,{'Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8','Content-Security-Policy':baseCsp+"script-src 'none'; frame-src 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end('Unavailable');};
  if(!alive||!origin)return reject(410);
  if(req.headers.host!==new URL(origin).host||req.headers.cookie||req.headers.authorization||!['GET','HEAD'].includes(req.method??'')||req.url!=='/')return reject(403);
  const doc=role==='parent'?{html:hostHtml,csp:baseCsp+"script-src 'none'; frame-src "+shellOrigin+"; frame-ancestors 'none'"}:shellDocument(parentOrigin,shellOrigin);
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':doc.csp,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()'});res.end(req.method==='HEAD'?undefined:doc.html);
 };
 const parentServer=createServer(serve('parent')),shellServer=createServer(serve('shell'));
 const parentPort=await listen(parentServer),shellPort=await listen(shellServer);
 parentOrigin='http://127.0.0.1:'+parentPort;shellOrigin='http://localhost:'+shellPort;
 const isolated=session.fromPartition('trusted-inert-'+randomUUID());
 isolated.setPermissionRequestHandler((_w,_p,cb)=>cb(false));isolated.setPermissionCheckHandler(()=>false);
 const win=new BrowserWindow({width:900,height:650,title:'Trusted-origin inert preview fixture',webPreferences:{session:isolated,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webSecurity:true,navigateOnDragDrop:false}});
 const diagnostic=(record:Record<string,unknown>)=>fs.appendFileSync(path.join(__dirname,'diagnostics.jsonl'),JSON.stringify({activeMode:mode,activeAttempt:attempt,...record})+'\n');
 win.webContents.on('console-message',details=>{failure.consoleMessage(details.message);if(/Content Security Policy|Refused|Blocked|violat|FIXED_INERT_SCRIPT_EXECUTED/i.test(details.message))diagnostic({kind:'console',message:details.message.replace(/[a-f0-9]{64}/gi,'[redacted-nonce]').replace(/https?:\/\/[^\s"']+/g,'[local-url]').slice(0,1000)});});
 const status=(s:string)=>{if(alive&&!win.isDestroyed())win.webContents.send('trusted-inert-status',s);};
 const nativeFrame=()=>win.webContents.mainFrame.frames.find(f=>f.frameTreeNodeId===tree);
 const trusted=(e:Electron.IpcMainEvent|Electron.IpcMainInvokeEvent)=>alive&&e.sender===win.webContents&&e.senderFrame===win.webContents.mainFrame&&e.senderFrame.url===parentOrigin+'/';
 const retire=(reason:string,clear=true)=>{epoch++;clearTimeout(timer);handshake?.retire();try{channel?.port1.close();channel?.port2.close();}catch{}channel=undefined;status(reason);if(alive&&clear)win.webContents.send('trusted-inert-clear',mount);};
 onProbe=()=>retire('FAIL: forbidden probe activity detected. Do not accept this run.');
 isolated.webRequest.onBeforeRequest((d,cb)=>{
  let allow=false;
  if(alive&&d.method==='GET'&&d.webContentsId===win.webContents.id){
   if(d.resourceType==='mainFrame'&&d.url===parentOrigin+'/'&&d.frame===win.webContents.mainFrame&&!mainRequested){mainRequested=true;allow=true;}
   else if(d.resourceType==='subFrame'&&d.url===shellOrigin+'/'&&d.frame?.frameTreeNodeId===tree&&!initialRequested){initialRequested=true;allow=true;}
  }
  if(!allow&&(d.resourceType==='mainFrame'||d.frame?.frameTreeNodeId===tree||d.frame?.frameTreeNodeId===nestedTree))retire('Unexpected document request retired the channel.');
  if(!allow)diagnostic({kind:'request-denied',resourceType:d.resourceType,ownContents:d.webContentsId===win.webContents.id,destination:d.url===parentOrigin+'/'?'parent':d.url===shellOrigin+'/'?'shell':d.url==='about:srcdoc'?'srcdoc':'other',outer:d.frame?.frameTreeNodeId===tree,nested:d.frame?.frameTreeNodeId===nestedTree});
  cb({cancel:!allow});
 });
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',e=>{e.preventDefault();retire('Top-level navigation denied.');});
 win.webContents.on('will-frame-navigate',e=>{
  if(e.isMainFrame){if(e.url===parentOrigin+'/'&&!mainNavigationSeen){mainNavigationSeen=true;return;}diagnostic({kind:'navigation-denied',frame:'parent'});e.preventDefault();retire('Parent document replacement denied.');return;}
  if(e.frame?.frameTreeNodeId===tree&&e.url===shellOrigin+'/'&&!initialNavigationSeen){initialNavigationSeen=true;return;}
  if(e.frame&&e.frame.parent===nativeFrame()&&e.url==='about:srcdoc'&&handshake?.state==='ready'&&!nestedNavigationSeen){nestedNavigationSeen=true;nestedTree=e.frame.frameTreeNodeId;return;}
  // Only the initial fixed inert srcdoc is allowed; remote/custom nested navigation is denied.
  diagnostic({kind:'navigation-denied',frame:e.frame?.frameTreeNodeId===tree?'outer':'nested',destination:e.url==='about:srcdoc'?'srcdoc':e.url===shellOrigin+'/'?'shell':'other'});e.preventDefault();retire('Frame navigation denied and channel retired.');
 });
 win.webContents.on('did-navigate-in-page',()=>retire('Same-document navigation is unsupported and retired.'));
 ipcMain.handle('trusted-inert-bind',(e,newMount,newMode)=>{
  if(!trusted(e)||!probeMode(newMode)||typeof newMount!=='string'||! /^[a-f0-9]{64}$/.test(newMount))throw Error('Unavailable');retire('Binding a fresh fixed shell.',false);mount=newMount;mode=newMode;attempt++;handshake=undefined;
  const frames=win.webContents.mainFrame.frames.filter(f=>f.name==='trusted-inert-shell');if(frames.length!==1)throw Error('Missing fixed frame');tree=frames[0].frameTreeNodeId;initialRequested=false;initialNavigationSeen=false;nestedNavigationSeen=false;nestedTree=undefined;
  return {shellOrigin,parentOrigin};
 });
 ipcMain.handle('trusted-inert-retire',e=>{if(!trusted(e))throw Error('Unavailable');retire('Explicitly retired. No live channel.');});
 ipcMain.on('trusted-inert-ready',(e,envelope)=>{
  if(!trusted(e))return;const message=readyForMount(envelope,mount);if(message===undefined)return;const frame=nativeFrame();
  if(handshake||!frame||frame.isDestroyed()||frame.url!==shellOrigin+'/'){retire('Repeated ready or uncommitted shell refused.');return;}
  const activation=epoch,captured=frame;channel=new MessageChannelMain();const ownChannel=channel;
  const current=()=>!failure.failed&&alive&&epoch===activation&&nativeFrame()===captured&&!captured.isDestroyed()&&captured.url===shellOrigin+'/';
  handshake=createHandshake({mode,hostNonce:randomBytes(32).toString('hex'),current,send:data=>ownChannel.port1.postMessage(data),close:()=>{ownChannel.port1.close();ownChannel.port2.close();}});
  const bound=handshake,bootstrap=bound.ready(message);if(!bootstrap)return;
  ownChannel.port1.on('message',event=>{if(epoch!==activation){bound.retire();return;}if(bound.receive(event.data))status(event.data.type==='loaded'?'Nested load reported. Inspect the fixed text; no live/account acceptance.':'Document nonce acknowledged; fixed inert render requested.');else status('Invalid/stale private-port message refused.');});ownChannel.port1.start();
  timer=setTimeout(()=>{if(epoch===activation)retire('Fixture lease expired.');},30000);
  if(current())win.webContents.postMessage('trusted-inert-bootstrap',{origin:shellOrigin,mount,bootstrap},[ownChannel.port2]);else retire('Native frame retired before transfer.');
 });
 win.on('close',()=>{retire('Closing.');alive=false;});
 win.on('closed',()=>{for(const n of ['trusted-inert-bind','trusted-inert-retire'])ipcMain.removeHandler(n);ipcMain.removeAllListeners('trusted-inert-ready');parentServer.close();shellServer.close();app.quit();});
 await win.loadURL(parentOrigin+'/');
}).catch(()=>{console.error('Independent inert fixture unavailable.');app.quit();});
