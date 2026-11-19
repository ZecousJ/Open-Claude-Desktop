import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from './harness.mjs';
let client=await Client.launch(),page=client.page(0),id;
const marker='ATTACHMENT_FIRST_'+randomUUID().slice(0,8);
try{
 const picture=await page.eval('(async()=>{const blob=await __e2e.pngOf("#0000ff",80,60);return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));})()');
 const workspace=await page.eval('window["claude.web"].LocalSessions.createScratchWorkspace()');
 const started=await page.eval('window["claude.web"].LocalSessions.start('+JSON.stringify({cwd:workspace.cwd,message:'Read the attached text and image. Reply with the exact token in the text file and dominant color. No tools or commands.',images:[{base64:picture,mimeType:'image/png'}],attachments:[{name:'first.txt',base64:Buffer.from(marker).toString('base64')}],permissionMode:'default'})+')');id=started.sessionId;
 const read='window["claude.web"].LocalSessions.getTranscript('+JSON.stringify(id)+')';
 await page.waitFor(read+'.then(rows=>rows.some(r=>r.type==="assistant"&&JSON.stringify(r.message.content).includes('+JSON.stringify(marker)+')))',180000,1200);
 await page.waitFor('window["claude.web"].LocalSessions.getSession('+JSON.stringify(id)+').then(s=>!s.turnRunning)',120000);
 const rows=await page.eval(read);assert.match(JSON.stringify(rows.filter(r=>r.type==='assistant')),/blue|蓝/i);
 await page.goto('/epitaxy/'+id);await page.waitFor('document.body.innerText.includes("first.txt")',30000);
 assert.ok(await page.eval('Array.from(document.querySelectorAll("img")).some(i=>i.src.startsWith("data:image/")&&i.naturalWidth>0)'));
 await client.quit();client=await Client.launch();page=client.page(0);await page.goto('/epitaxy/'+id);
 await page.waitFor('document.body.innerText.includes('+JSON.stringify(marker)+')&&document.body.innerText.includes("first.txt")',30000);
 console.log(JSON.stringify({result:'passed',completedAt:new Date().toISOString(),sessionId:id,scope:'first Code send with inline text+PNG actual model token and blue recognition; official transcript file badge+image; full restart; no commands'}));
}finally{await client.stop();}
