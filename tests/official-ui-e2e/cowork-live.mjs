/** A text-only Cowork task, without external folders, in the test profile. */
import { rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
let id;
try {
  id = await page.eval(`window['claude.web'].LocalAgentModeSessions.start({message:'Only reply with COWORK_E2E_OK. Do not run commands or edit files.',permissionMode:'default'}).then(r => r.sessionId)`);
  await page.waitFor(`window['claude.web'].LocalAgentModeSessions.getTranscript(${JSON.stringify(id)}).then(rows => rows.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes('COWORK_E2E_OK')))`, 120000, 1000);
  await page.goto(`/cowork/${id}`);
  await page.waitFor("(document.body.innerText.match(/COWORK_E2E_OK/g) || []).length >= 2", 30000, 1000);
  await page.eval(`__e2e.type('Only reply with COWORK_E2E_UI. Do not run commands or edit files.')`);
  const mark = client.logMark();
  await page.eval(`(async()=>{const button=await __e2e.waitFor(()=>[...__e2e.byLabel('Send'),...__e2e.byLabel('Send message')].find(b=>!b.disabled));__e2e.press(button)})()`);
  let received = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const failure = client.logSince(mark).find((line) => line.includes("LocalAgentModeSessions_$_sendMessage") && line.includes("Error:"));
    if (failure) throw new Error(failure.slice(failure.indexOf("Error:")));
    try { received = await page.eval(`window['claude.web'].LocalAgentModeSessions.getTranscript(${JSON.stringify(id)}).then(rows => rows.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes('COWORK_E2E_UI')))`, 10000); } catch {}
    if (received) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!received) throw Error("The Cowork UI message did not receive a reply.");
  await page.waitFor("(document.body.innerText.match(/COWORK_E2E_UI/g) || []).length >= 2", 30000, 1000);
  await page.goto(`/cowork/${id}`);
  await page.waitFor("(document.body.innerText.match(/COWORK_E2E_UI/g) || []).length >= 2", 30000, 1000);
  console.log("The no-folder Cowork session and UI follow-up were sent, rendered and reopened.");
} finally {
  if (id) {
    await page.eval(`window['claude.web'].LocalAgentModeSessions.stop(${JSON.stringify(id)}).catch(() => {})`).catch(() => {});
    try { await page.eval(`window['claude.web'].LocalAgentModeSessions.delete(${JSON.stringify(id)})`); }
    catch (error) { console.error(`Test session cleanup failed: ${error.message}`); process.exitCode = 1; }
    // A cloud mirror, if one was created, is removed only after matching this
    // test's exact ID and prompt against a fresh snapshot.
    try {
      const cleaned = await page.eval(`(async()=>{const call=(name,args=[])=>fetch('/__debug/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json());const snap=await call('snapshot');if(snap.error)throw Error(snap.error);const raw=${JSON.stringify(id.slice(6))};const row=(snap.value.conversations||[]).find(c=>c.id===raw&&c.cloudHosted&&(c.turns||[]).some(t=>t.prompt==='Only reply with COWORK_E2E_OK. Do not run commands or edit files.'));if(!row)return 'absent';const result=await call('deleteConversation',[row.id]);if(result.error)throw Error(result.error);return 'deleted'})()`);
      if (cleaned !== "absent" && cleaned !== "deleted") throw Error("Unexpected cloud cleanup result");
    } catch (error) { console.error(`Test cloud cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  await client.stop();
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
