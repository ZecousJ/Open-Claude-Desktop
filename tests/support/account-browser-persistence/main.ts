/** Independent synthetic Electron app. No product profile, accounts, SDK, or external resources. */
import {app,BrowserWindow,session} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {accountBrowserStorage} from '../../../electron/official-ui/account-browser-storage';
import {startOfficialUiServer,cookieName} from '../../../electron/official-ui/server';
const [root,mode]=process.argv.slice(2);
if(!root?.startsWith('/tmp/claudex-browser-persistence-')||!['write','read','other'].includes(mode))throw Error('Synthetic fixture arguments required');
fs.mkdirSync(path.join(root,'electron-profile'),{recursive:true});
app.setName('Claudex Synthetic Storage Test');
app.setPath('userData',path.join(root,'electron-profile'));
void app.whenReady().then(async()=>{
 const owner=mode==='other'?'fixture-b':'fixture-a';
 const storage=accountBrowserStorage(owner,path.join(root,'accounts',owner),app.getPath('userData'));
 const bundle=path.join(root,'bundle');fs.mkdirSync(path.join(bundle,'ui'),{recursive:true});
 fs.writeFileSync(path.join(bundle,'ui/index.html'),'<!doctype html><meta charset="utf-8"><title>Synthetic storage check</title><p>Self-authored storage fixture. No account data.</p>');
 const server=await startOfficialUiServer({root:bundle,portFile:storage.portFile,requireStablePort:true,api:()=>false});
 const ses=session.fromPartition(storage.partition);
 ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 ses.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(server.origin+'/')}));
 await ses.cookies.set({url:server.origin,name:cookieName,value:server.token,httpOnly:true,sameSite:'strict'});
 const win=new BrowserWindow({show:true,width:520,height:240,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try {
  await win.loadURL(server.origin+'/');
  const value=await win.webContents.executeJavaScript(`(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('synthetic-draft',1);request.onupgradeneeded=()=>request.result.createObjectStore('draft');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('fixture database failed'));});
    ${mode==='write'?`localStorage.setItem('draft','fixed-synthetic-draft');await new Promise((resolve,reject)=>{const tx=db.transaction('draft','readwrite');tx.objectStore('draft').put('fixed-synthetic-draft','value');tx.oncomplete=resolve;tx.onerror=reject;});`:''}
    const stored=await new Promise((resolve,reject)=>{const r=db.transaction('draft').objectStore('draft').get('value');r.onsuccess=()=>resolve(r.result??null);r.onerror=reject;});db.close();return {local:localStorage.getItem('draft'),indexed:stored};})()`);
  const expected=mode==='other'?null:'fixed-synthetic-draft';
  if(value.local!==expected||value.indexed!==expected)throw Error('Synthetic storage assertion failed');
  ses.flushStorageData();await ses.cookies.flushStore();
  console.log('SYNTHETIC_STORAGE_'+mode.toUpperCase()+'_PASS');
 } finally {win.destroy();await server.close();}
 app.quit();
}).catch(()=>{console.error('SYNTHETIC_STORAGE_FAIL');app.exit(1);});
