/** Creates one disposable text-only Code session on the test profile. */
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
let id;
let workspace;
let deleted = false;
try {
  id = await page.eval(`window['claude.web'].LocalSessions.start({cwd:'',message:'Only reply with CODE_E2E_OK. Do not run commands or edit files.',permissionMode:'default',thinkingSummariesWanted:false}).then(r => r.sessionId)`);
  workspace = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.cwd)`);
  try {
    await page.waitFor(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes('CODE_E2E_OK')))`, 60000, 1000);
  } catch (error) {
    const detail = await page.eval(`(async () => { const api=window['claude.web'].LocalSessions; const s=await api.getSession(${JSON.stringify(id)}); let rows; try { rows=(await api.getTranscriptTail(${JSON.stringify(id)},50)).messages.map(r => ({type:r.type, contentType:typeof r.message?.content, blocks:Array.isArray(r.message?.content)?r.message.content.map(b=>b.type):[]})); } catch(e) { rows=String(e); } return { running:s?.turnRunning, rows }; })()`);
    throw new Error(`Initial reply was not available: ${JSON.stringify(detail)}; ${error.message}`);
  }
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 120000, 1000);
  const transcript = await page.eval(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50)`);
  if (!transcript.messages.some((row) => row.type === "assistant")) throw Error("The completed session has no assistant response");
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor("(document.body.innerText.match(/CODE_E2E_OK/g) || []).length >= 2", 30000);
  await page.eval(`(() => { window.__codeEvents = []; window['claude.web'].LocalSessions.onOnEvent(e => { if (e.sessionId === ${JSON.stringify(id)}) window.__codeEvents.push(e.type); }); })()`);
  await page.eval(`window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(id)},'Only reply with CODE_E2E_FOLLOWUP. Do not run commands or edit files.')`);
  await page.waitFor(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes('CODE_E2E_FOLLOWUP')))`, 120000, 1000);
  try {
    await page.waitFor("(document.body.innerText.match(/CODE_E2E_FOLLOWUP/g) || []).length >= 2", 30000, 1000);
  } catch (error) {
    const diagnostic = await page.eval(`({ occurrences: (document.body.innerText.match(/CODE_E2E_FOLLOWUP/g) || []).length, events: window.__codeEvents, labels: [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(s => /^(Message \\d+|Claude responded:)/.test(s)).map(s => s.startsWith('Claude responded:') ? 'Claude responded' : s) })`);
    throw new Error(`The follow-up reply did not appear in the visible session: ${JSON.stringify(diagnostic)}; ${error.message}`);
  }
  // A visible response can arrive before its turn is marked complete. This
  // case exercises ordinary sending; queueing during a running turn is a
  // separate, still-unsupported Code feature.
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 120000, 1000);
  await page.eval(`__e2e.type('Only reply with CODE_E2E_UI. Do not run commands or edit files.')`);
  const sendMark = client.logMark();
  await page.eval(`(async () => { const button = await __e2e.waitFor(() => __e2e.byLabel('Send').find(b => !b.disabled)); __e2e.press(button); })()`);
  let received = false;
  for (let i = 0; i < 120; i++) {
    const failure = client.logSince(sendMark).find((line) => line.includes("Code message option") && line.includes("not supported yet"));
    if (failure) throw new Error(failure.slice(failure.indexOf("Error: Code message option")));
    try { received = await page.eval(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes('CODE_E2E_UI')))`); } catch {}
    if (received) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!received) throw new Error("The UI-sent message did not receive a reply within 120 seconds.");
  await page.waitFor("(document.body.innerText.match(/CODE_E2E_UI/g) || []).length >= 2", 30000, 1000);
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor("(document.body.innerText.match(/CODE_E2E_UI/g) || []).length >= 2", 30000, 1000);
  await page.eval(`window['claude.web'].LocalSessions.updateSession(${JSON.stringify(id)},{title:'CODE_E2E_RENAMED',titleSource:'user',isStarred:true})`);
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.title === 'CODE_E2E_RENAMED' && s.isStarred)`, 20000);
  await page.waitFor("document.body.innerText.includes('CODE_E2E_RENAMED')", 20000);
  await page.eval(`window['claude.web'].LocalSessions.archive(${JSON.stringify(id)})`);
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.isArchived)`, 20000);
  await page.eval(`window['claude.web'].LocalSessions.unarchive(${JSON.stringify(id)})`);
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.isArchived)`, 20000);
  console.log("A Code session was sent, rendered, reloaded, renamed, pinned, archived and restored.");
} finally {
  if (id) {
    await page.eval(`window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(() => {})`).catch(() => {});
    try { await page.eval(`window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`); deleted = true; }
    catch (error) { console.error(`Test session cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  await client.stop();
  if (deleted && workspace && path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) && /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)) {
    try { await rmdir(workspace); }
    catch (error) { if (error.code !== "ENOENT") console.error(`The test workspace was retained: ${workspace}`); }
  }
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
