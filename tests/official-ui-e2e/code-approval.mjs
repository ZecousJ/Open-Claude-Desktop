/** Exercises one explicit, read-only command approval in the test profile. */
import { rm, rmdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
let id, workspace;
let deleted = false;
const deny = process.env.CODE_APPROVAL_DECISION === "deny";
const target = path.join(os.tmpdir(), `claudex-approval-${randomUUID()}`);
const command = deny ? `printf test > '${target.replaceAll("'", "'\\''")}'` : "printf CODE_APPROVAL_E2E";
try {
  await page.eval(`(() => { window.__approvalRequests=[]; window['claude.web'].LocalSessions.onOnEvent(e => { if (e.type === 'tool_permission_request') window.__approvalRequests.push(e.request); }); })()`);
  const prompt = `To test manual approval, run exactly this command using escalated permissions so it requests approval: ${command}. Do not run any other command.`;
  id = await page.eval(`window['claude.web'].LocalSessions.start({cwd:'',message:${JSON.stringify(prompt)},permissionMode:'default',thinkingSummariesWanted:false}).then(r => r.sessionId)`);
  workspace = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.cwd)`);
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.pendingToolPermissions?.length > 0)`, 90000, 1000);
  const request = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s.pendingToolPermissions[0])`);
  if (deny ? !request.input?.command?.includes(target) : request.input?.command !== command)
    throw Error(`The model requested a different command; no approval was given. Requested: ${String(request.input?.command).slice(0, 300)}`);
  await page.waitFor("/allow|approve/i.test(document.body.innerText)", 30000);
  await page.eval(`(async () => {
    const button = await __e2e.waitFor(() => [...document.querySelectorAll('button')].find(b => __e2e.visible(b) && ${deny ? "/^Deny$/" : "/^(Allow once|Allow|Approve)$/"}.test(b.innerText.trim().split('\\n')[0])));
    __e2e.press(button);
  })()`);
  if (deny) {
    await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.pendingToolPermissions?.length)`, 30000, 1000);
    await page.eval(`window['claude.web'].LocalSessions.stop(${JSON.stringify(id)})`);
    await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 30000, 1000);
    const exists = await access(target).then(() => true, () => false);
    if (exists) throw Error("The denied command created its target file.");
    console.log("The official interface denied the command; its target file was not created.");
  } else {
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 90000, 1000);
  const rows = await page.eval(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages)`);
  const results = rows.flatMap((row) => Array.isArray(row.message?.content) ? row.message.content.filter((block) => block.type === "tool_result") : []);
  if (!results.some((block) => block.content?.includes("CODE_APPROVAL_E2E") && !block.is_error))
    throw Error("The approved command result was not preserved in the transcript.");
  console.log("An explicit read-only command approval was accepted through the official interface and its result preserved.");
  }
} finally {
  if (id) {
    await page.eval(`window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(() => {})`).catch(() => {});
    try { await page.eval(`window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`); deleted = true; }
    catch (error) { console.error(`Test session cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  await client.stop();
  if (deleted && workspace && path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) && /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace))
    await rmdir(workspace).catch(() => {});
  await rm(target, { force: true });
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
