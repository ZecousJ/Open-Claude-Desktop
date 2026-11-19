/** Only top-frame trusted preload. Never expose Electron APIs to page or subframes. */
const {ipcRenderer}=require('electron');
if(process.isMainFrame){
 let frame,proxy,mount='',origin='',opening=false,ready=false;
 const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
 const status=s=>{const el=document.getElementById('status');if(el)el.textContent=s;};
 const remove=()=>{frame?.remove();frame=undefined;proxy=undefined;origin='';ready=false;};
 ipcRenderer.on('trusted-inert-status',(_e,s)=>{if(typeof s==='string')status(s);});
 ipcRenderer.on('trusted-inert-clear',(_e,id)=>{if(id===mount)remove();});
 ipcRenderer.on('trusted-inert-bootstrap',(event,envelope)=>{
  if(!frame?.isConnected||frame.contentWindow!==proxy||envelope?.mount!==mount||envelope.origin!==origin||!ready||event.ports.length!==1){for(const p of event.ports)p.close();return;}
  proxy.postMessage(envelope.bootstrap,origin,[event.ports[0]]);
 });
 window.addEventListener('message',event=>{
  const d=event.data;if(!frame?.isConnected||event.source!==proxy||event.origin!==origin)return;
  if(ready||!d||Object.keys(d).length!==2||d.type!=='ready'||typeof d.docNonce!=='string'||!/^[a-f0-9]{64}$/.test(d.docNonce)||event.ports.length){for(const p of event.ports)p.close();void ipcRenderer.invoke('trusted-inert-retire');return;}
  ready=true;ipcRenderer.send('trusted-inert-ready',{mount,message:{type:'ready',docNonce:d.docNonce}});
 });
 window.addEventListener('pagehide',()=>{remove();void ipcRenderer.invoke('trusted-inert-retire').catch(()=>{});});
 window.addEventListener('DOMContentLoaded',()=>{
  if(location.protocol!=='http:'||location.hostname!=='127.0.0.1'||location.pathname!=='/'||location.search||location.hash)return;
  document.getElementById('open').addEventListener('click',async()=>{
   if(opening)return;opening=true;try{await ipcRenderer.invoke('trusted-inert-retire');remove();mount=random();frame=document.createElement('iframe');frame.name='trusted-inert-shell';frame.title='Fixed cross-origin trusted shell';frame.width='730';frame.height='320';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.referrerPolicy='no-referrer';document.getElementById('container').replaceChildren(frame);proxy=frame.contentWindow;
    const node=frame,windowProxy=proxy,id=mount,config=await ipcRenderer.invoke('trusted-inert-bind',id,document.getElementById('case').value);
    if(frame!==node||mount!==id||!node.isConnected||proxy!==windowProxy)return;
    const url=new URL(config.shellOrigin);if(config.parentOrigin!==location.origin||url.protocol!=='http:'||url.hostname!=='localhost'||url.origin!==config.shellOrigin)throw Error('Invalid fixed origin');origin=url.origin;node.src=origin+'/';
   }catch{remove();status('Fixed shell setup unavailable.');}finally{opening=false;}
  });
  document.getElementById('navigate').addEventListener('click',()=>{if(frame?.isConnected)frame.src=origin+'/';});
  document.getElementById('revoke').addEventListener('click',()=>{void ipcRenderer.invoke('trusted-inert-retire').catch(()=>status('Revoke unavailable.'));});
 });
}
