const {ipcRenderer}=require('electron');
if(process.isMainFrame&&location.protocol==='data:'){
 addEventListener('DOMContentLoaded',()=>{for(const command of ['open','retire','close'])document.getElementById(command)?.addEventListener('click',()=>ipcRenderer.send('static-smoke-control',command));},{once:true});
 ipcRenderer.on('static-smoke-status',(_event,status)=>{const node=document.getElementById('status');if(node&&typeof status==='string')node.textContent=status;});
}
