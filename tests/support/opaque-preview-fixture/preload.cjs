/** Trusted preload for the dedicated inert fixture only. No exported API/tokens. */
const {ipcRenderer}=require('electron');
let frame,expectedWindow,opening=false;
const status=value=>{const node=document.getElementById('status');if(node)node.textContent=String(value);};
ipcRenderer.on('inert-fixture-status',(_event,value)=>{if(typeof value==='string')status(value);});
ipcRenderer.on('inert-fixture-clear',(_event,url)=>{if(frame?.isConnected&&frame.src===url){frame.remove();expectedWindow=undefined;status('Revoked/expired preview removed; no live document or port.');}});
ipcRenderer.on('inert-fixture-bootstrap',(event,envelope)=>{
 const ports=event.ports,message=envelope?.bootstrap;
 if(!frame?.isConnected||frame.src!==envelope?.resourceURL||frame.contentWindow!==expectedWindow||ports.length!==1||message?.type!=='claudex-preview-bootstrap'||message.version!==1){for(const port of ports)port.close();return;}
 // Exact captured destination. '*' is required for its opaque sandbox origin.
 // Only the port and fixed envelope cross this boundary; NEVER proof or HTML.
 expectedWindow.postMessage({type:'claudex-preview-bootstrap',version:1},'*',[ports[0]]);
});
window.addEventListener('DOMContentLoaded',()=>{
 document.getElementById('open').addEventListener('click',async()=>{
  if(opening)return;opening=true;
  try{
   await ipcRenderer.invoke('inert-fixture-retire');frame?.remove();
   frame=document.createElement('iframe');frame.name='claudex-inert-shell';frame.title='Trusted opaque inert shell';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';document.getElementById('container').replaceChildren(frame);expectedWindow=frame.contentWindow;
   const createdFrame=frame,createdWindow=expectedWindow;
   createdFrame.addEventListener('load',()=>{if(frame!==createdFrame||expectedWindow!==createdWindow||!createdFrame.isConnected)return;ipcRenderer.send('inert-fixture-loaded',createdFrame.contentWindow===createdWindow);});
   const url=await ipcRenderer.invoke('inert-fixture-bind');if(frame!==createdFrame||expectedWindow!==createdWindow||!createdFrame.isConnected)return;if(!/^https:\/\/fixture\.invalid\/shell\/[a-f0-9-]+$/.test(url))throw Error('Unavailable');createdFrame.src=url;
  }catch{status('Fixture frame setup unavailable. No private shell accepted.');}finally{opening=false;}
 });
 document.getElementById('navigate').addEventListener('click',async()=>{const clickedFrame=frame;try{const url=await ipcRenderer.invoke('inert-fixture-retire','navigate');if(frame===clickedFrame&&clickedFrame?.isConnected&&url==='https://fixture.invalid/blank')clickedFrame.src=url;}catch{status('Navigation refused.');}});
 document.getElementById('revoke').addEventListener('click',()=>{void ipcRenderer.invoke('inert-fixture-retire').catch(()=>status('Revocation unavailable.'));});
 document.getElementById('probe').addEventListener('click',()=>{void ipcRenderer.invoke('inert-fixture-probe').catch(()=>status('Probe refused.'));});
});
