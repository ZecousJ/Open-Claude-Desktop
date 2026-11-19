/** Real native runtime: stopping a short reply must tolerate completion races. */
import assert from "node:assert/strict";
import { Client } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
let id;
try {
  id = await page.eval(`window['claude.web'].LocalSessions.start({cwd:'',message:'Only reply CODE_STOP_RACE_OK. Do not run commands or edit files.',permissionMode:'default',thinkingSummariesWanted:false}).then(r=>r.sessionId)`);
  try {
    await page.eval(`window['claude.web'].LocalSessions.interrupt(${JSON.stringify(id)})`);
  } catch (error) {
    console.error(client.logSince(0).filter(line => /Claudex stop (?:error|reconciliation)/.test(line)).join("\n"));
    console.error("Stopped session:", await page.eval(`fetch('/__debug/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'snapshot',args:[]})}).then(r=>r.json()).then(r=>r.value?.conversations?.filter(c=>c.id===${JSON.stringify(id.slice(6))}).map(c=>({id:c.id,threadId:c.threadId,turns:c.turns.map(t=>({id:t.id,status:t.status}))})))`));
    throw error;
  }
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s&&!s.turnRunning)`,30000,250);
  const ended = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)})`);
  assert.equal(ended.turnRunning,false);
  console.log("PASS: stopping a real short reply resolves and leaves the session idle.");
} finally {
  if (id) await page.eval(`window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(()=>{})`).catch(()=>{});
  if (id) await page.eval(`window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`).catch(error=>{console.error(error);process.exitCode=1;});
  console.log(`Client evidence: ${client.logFile}`);
  await client.stop();
}
