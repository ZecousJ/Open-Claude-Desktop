/** Standalone inert runtime smoke: actual production opener, no application/account bootstrap. */
import {app,BrowserWindow,ipcMain} from 'electron';
import http from 'node:http';import path from 'node:path';import fs from 'node:fs';
import {openStaticArtifactPreview} from '../../../electron/official-ui/preview/static-session';
import {staticArtifactDocument} from '../../../electron/official-ui/preview/static-content';
const root=path.resolve(process.argv[2]??'');
if(!root.endsWith('/.restore/static-preview-smoke'))throw Error('Dedicated smoke workspace required.');
const profile=fs.mkdtempSync(path.join(root,'profile-'));app.setPath('userData',profile);
void app.whenReady().then(async () => {
let requests=0,active=true,opening=false,retireListeners=new Set<()=>void>();
const probe=http.createServer((_req,res)=>{requests++;res.writeHead(204);res.end();report('Unexpected local probe request');});
await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
const addr=probe.address();if(!addr||typeof addr==='string')throw Error('Probe unavailable.');
const probeURL=`http://127.0.0.1:${addr.port}/probe`;
const owner=new BrowserWindow({width:860,height:520,title:'Production static preview — inert smoke',webPreferences:{preload:path.join(root,'control-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false}});
const shell='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';script-src \'none\';style-src \'unsafe-inline\';connect-src \'none\';form-action \'none\'"><style>body{font:20px sans-serif;padding:28px}button{font:inherit;margin:8px;padding:12px}</style><h1>Production static preview</h1><p>Self-authored content only. No account or provider.</p><button id="open">Open HTML/CSS fixture</button><button id="retire">Retire fixture activation</button><button id="close">Close smoke app</button><pre id="status">Ready; local probe requests: 0</pre>';
const ownerURL='data:text/html;charset=utf-8,'+encodeURIComponent(shell);
function report(status:string){if(!owner.isDestroyed())owner.webContents.send('static-smoke-status',`${status}\nLocal probe requests: ${requests}`);console.log(JSON.stringify({status,localProbeRequests:requests}));}
const document=staticArtifactDocument(`<style>body{font:20px sans-serif;background:#f0f7ff;color:#102040;margin:24px}h1{background:#176045;color:white;padding:18px;border-radius:12px}.card{border:4px solid #176045;padding:20px}</style><h1>Static HTML + CSS verified visually</h1><div class="card">Self-authored green heading and bordered card.<p id="script-status">Script has not executed.</p><a href="${probeURL}/link">Blocked navigation link</a><form action="${probeURL}/form"><button>Blocked form submit</button></form><img src="${probeURL}/image" alt="External image intentionally blocked"><iframe src="${probeURL}/frame"></iframe></div><script>document.getElementById('script-status').textContent='SCRIPT EXECUTED';fetch('${probeURL}/script')</script>`,'text/html');
ipcMain.on('static-smoke-control',async(event,command)=>{
 if(event.sender!==owner.webContents||event.senderFrame!==owner.webContents.mainFrame||event.senderFrame?.url!==ownerURL)return;
 if(command==='close'){app.quit();return;}
 if(command==='retire'){active=false;for(const fn of [...retireListeners])fn();retireListeners.clear();report('Fixture activation retired');return;}
 if(command!=='open'||opening||!active)return;
 opening=true;report('Opening real production preview');
 try{await openStaticArtifactPreview({document,current:()=>active,ownerWindow:owner,preloadPath:path.join(root,'static-preload.cjs'),onRetire:fn=>{retireListeners.add(fn);return()=>retireListeners.delete(fn);},log:report});report('Production opener acknowledged; inspect actual preview pixels');}catch{report('Production opener unavailable');}finally{opening=false;}
});
owner.webContents.setWindowOpenHandler(()=>({action:'deny'}));
owner.on('closed',()=>{active=false;for(const fn of [...retireListeners])fn();probe.close();probe.closeAllConnections();app.quit();});
await owner.loadURL(ownerURL);
app.on('window-all-closed',()=>app.quit());

}).catch(()=>{console.error("Inert static preview smoke startup failed.");app.quit();});
