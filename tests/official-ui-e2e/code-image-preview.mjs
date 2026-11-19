import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client,profile} from './harness.mjs';
const client=await Client.launch(),page=client.page(0);let file;
try{
 const sessions=await page.eval('window["claude.web"].LocalSessions.getSessionList().then(r=>r.sessions)');
 const c=sessions.find(s=>s.cwd?.startsWith(profile+path.sep)&&!s.turnRunning&&!s.isArchived);assert.ok(c);
 const name='image-preview-'+randomUUID().slice(0,8)+'.png';file=path.join(c.cwd,name);
 const bytes=await page.eval('(async()=>{const b=await __e2e.pngOf("#00ff00",120,90);return btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer())));})()');
 await fs.writeFile(file,Buffer.from(bytes,'base64'));
 const pasted=await page.eval('window["claude.web"].FileSystem.savePastedFile('+JSON.stringify(Buffer.from('CLIPBOARD_FILE_BYTES').toString('base64'))+',"text/plain","clipboard-proof.txt")');
 assert.ok(pasted.path.startsWith(profile+path.sep));assert.equal(await fs.readFile(pasted.path,'utf8'),'CLIPBOARD_FILE_BYTES');
 const base='window["claude.web"].LocalSessions.';
 assert.equal(await page.eval(base+'readSessionImageAsDataUrl('+JSON.stringify(c.sessionId)+','+JSON.stringify(file)+')'),'data:image/png;base64,'+bytes);
 await page.goto('/epitaxy/'+c.sessionId);await page.waitFor('!!document.querySelector("button[aria-label=Files]")');
 if(await page.eval('document.querySelector("button[aria-label=Files]").getAttribute("aria-pressed")')!=='true')await page.click('button[aria-label=Files]');
 const toggle=await page.eval('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Show file tree");if(b){b.setAttribute("data-image-tree","");return true;}return false;})()');if(toggle)await page.click('[data-image-tree]');
 await page.waitFor('document.body.innerText.includes('+JSON.stringify(name)+')');
 await page.eval('(()=>{const row=Array.from(document.querySelectorAll("[role=treeitem],button")).filter(e=>e.textContent.includes('+JSON.stringify(name)+')).sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!row)throw Error("Missing file");row.setAttribute("data-image-open","");})()');
 await page.click('[data-image-open]');
 await page.waitFor('Array.from(document.querySelectorAll("img")).some(i=>i.complete&&i.naturalWidth===120&&i.naturalHeight===90)',20000);
 assert.equal(await page.eval('document.body.innerText.includes("Inline preview isn’t available for this file")'),false);
 console.log(JSON.stringify({result:'passed',completedAt:new Date().toISOString(),scope:'official Files PNG preview paints original 120x90 image; native image read equals bytes; clipboard FileSystem.savePastedFile stores original text inside account; no model send'}));
}finally{if(file)await fs.rm(file,{force:true});await client.stop();}
