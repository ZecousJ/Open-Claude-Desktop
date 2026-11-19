/** Official Stop control must terminate a real command and retain the draft. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client, profile, sleep } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
const pidName = `claudex-stop-proof-${Date.now()}.pid`;
const command = `python3 -c 'import os,time;open("${pidName}","w").write(str(os.getpid()));print("CLAUDEX_STOP_RUNNING",flush=True);time.sleep(120)'`;
const prompt = `Run exactly this one command in the current working directory: ${command}. Wait for it to finish; do not put it in the background, do not add a timeout, and do not run other commands. After it ends, reply CODE_STOP_ENDED.`;
const draft = "Claudex QA draft retained while stopping a real command.";
const withDraft = process.env.CLAUDEX_STOP_WITH_DRAFT !== "0";
let id, workspace, pid;
let reused=false;
let deleted = false;
const alive = () => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
try {
  if(process.env.CLAUDEX_STOP_REUSE==="1"){
    id=await page.eval(`window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.find(s=>!s.turnRunning&&!s.isArchived)?.sessionId)`);
    assert.ok(id,"An existing idle test session is required");reused=true;
  }
  await page.goto(id?`/epitaxy/${id}`:"/epitaxy");
  await page.eval(`__e2e.type(${JSON.stringify(prompt)})`);
  await page.waitFor(`__e2e.byLabel('Send').some(b=>!b.disabled)`);
  await page.click('button[aria-label="Send"]');
  id = await page.waitFor(`(/^\\/epitaxy\\/(local_[^/]+)$/.exec(location.pathname)||[])[1]`,30000,250);
  workspace = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s?.cwd)`);
  assert.ok(workspace && path.resolve(workspace).startsWith(path.resolve(profile)+path.sep));
  const until = Date.now()+90000;
  while (Date.now()<until) {
    const value = await fs.readFile(path.join(workspace,pidName),"utf8").catch(()=>"");
    if (/^\d+$/.test(value)) { pid=Number(value); break; }
    const request = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s?.pendingToolPermissions?.[0])`);
    if (request) {
      assert.ok(request.input?.command?.includes(pidName),"Refuse approval for an unexpected command");
      await page.waitFor(`__e2e.all('button').some(b=>__e2e.visible(b)&&/^Allow once$/.test(b.innerText.trim().split(String.fromCharCode(10))[0]))`,15000,250);
      await page.eval(`(() => {const b=__e2e.all('button').find(b=>__e2e.visible(b)&&/^Allow once$/.test(b.innerText.trim().split(String.fromCharCode(10))[0]));b.dataset.e2eStopProofAllow='1'})()`);
      await sleep(1100); // Official shared-1 guards the first second of an approval.
      await page.click('[data-e2e-stop-proof-allow="1"]');
    }
    await sleep(250);
  }
  assert.ok(pid,"The real model must start the proof command");
  assert.ok(alive(),"The proof process must still be running before Stop");
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s?.turnRunning)`,15000,250);
  await page.waitFor(`__e2e.all('button').some(b=>__e2e.visible(b)&&/^Stop(?: response| generating| task)?$/i.test(b.getAttribute('aria-label')||b.textContent.trim()))`,10000,250);
  // Official c1958b152 swaps Stop to Send on a nonempty draft. Its Escape
  // handler still stops the turn; do not demand a button the source hides.
  if (withDraft) await page.eval(`__e2e.type(${JSON.stringify(draft)})`);
  const before = Date.now();
  if (withDraft) {
    await page.eval(`__e2e.all('[contenteditable=true]').find(__e2e.visible).focus()`);
    const response=await fetch(client.origin+"/__debug/key?key=Escape",{method:"POST",headers:{Cookie:client.cookie}});
    assert.equal(response.status,204,"Native Escape input must be delivered");
  } else {
    await page.click('button[aria-label="Stop"]');
  }
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s&&!s.turnRunning)`,15000,250);
  for (let i=0;i<40&&alive();i++) await sleep(250);
  if (alive()) {
    const native = await page.eval(`(async()=>{const s=await window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)});const snap=await fetch('/__debug/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'snapshot',args:[]})}).then(r=>r.json());const c=snap.value?.conversations?.find(c=>c.id===${JSON.stringify(id.slice(6))});return {session:s&&{sessionId:s.sessionId,threadId:s.threadId,isRunning:s.isRunning},conversation:c&&{threadId:c.threadId,turns:c.turns?.slice(-1).map(t=>({id:t.id,status:t.status,items:t.items?.filter(i=>i.type==='commandExecution')}))}}})()`);
    const background = native?.conversation?.threadId
      ? await page.eval(`window['claude.web'].LocalSessions.listBackgroundTerminals?.(${JSON.stringify(id)}).catch(e=>({error:String(e)}))`).catch(e=>({error:String(e)}))
      : null;
    console.error("Stop process diagnostics:",JSON.stringify({native,background}));
  }
  assert.equal(alive(),false,"Stop must terminate the actual command process");
  const stopMs=Date.now()-before;
  const expectedDraft = withDraft ? draft : "";
  assert.equal(await page.eval(`__e2e.all('[contenteditable=true]').find(__e2e.visible)?.textContent`),expectedDraft);
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(`__e2e.all('[contenteditable=true]').some(e=>__e2e.visible(e)&&e.textContent===${JSON.stringify(expectedDraft)})`,15000,250);
  await page.eval(`__e2e.type('Only reply CODE_STOP_FOLLOWUP_OK. Do not run commands or edit files.')`);
  await page.waitFor(`__e2e.byLabel('Send').some(b=>!b.disabled)`);
  await page.click('button[aria-label="Send"]');
  await page.waitFor(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t=>t.messages.some(r=>r.type==='assistant'&&JSON.stringify(r.message?.content).includes('CODE_STOP_FOLLOWUP_OK')))`,120000,500);
  await page.waitFor(`document.body.innerText.includes('CODE_STOP_FOLLOWUP_OK')`,20000,250);
  console.log(`PASS: official ${withDraft ? 'Escape with draft' : 'Stop button'} terminated PID ${pid}, retained and restored the editor, and received a real follow-up; stop-to-idle ${stopMs} ms.`);
  console.log(JSON.stringify({result:"passed",completedAt:new Date().toISOString(),scope:withDraft?"native Escape, real command PID exit, draft reopen and real follow-up":"native Stop button, real command PID exit, editor reopen and real follow-up",stopMs}));
} catch(error) {
  console.error("Stop proof failed:",String(error));
  console.error("Stop errors:",client.logSince(0).filter(line=>/Claudex stop|LocalSessions_\$_(?:stop|interrupt)/.test(line)));
  console.error("Visible controls:",await page.eval(`__e2e.all('main button').filter(__e2e.visible).map(b=>({label:b.getAttribute('aria-label'),text:b.innerText.slice(0,100)}))`).catch(()=>null));
  throw error;
} finally {
  if (id) await page.eval(`window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(()=>{})`).catch(()=>{});
  if (alive()) {
    // Clean up only this test's verified command; never use cleanup as proof.
    const text=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});
    if(text.includes(pidName))process.kill(pid,'SIGTERM');
  }
  if (workspace) await fs.rm(path.join(workspace,pidName),{force:true});
  if (id&&!reused) await page.eval(`window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`).then(()=>{deleted=true}).catch(error=>{console.error(error);process.exitCode=1;});
  console.log(`Client evidence: ${client.logFile}`);
  await client.stop();
  if(deleted && workspace && path.resolve(workspace).startsWith(path.resolve(profile)+path.sep)&&/[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace))await fs.rmdir(workspace).catch(()=>{});
}
