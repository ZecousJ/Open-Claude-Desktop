/** Start from the unmodified official Cowork homepage, including its prompts
 * and a real configured connector. Follow-up and reopen use the visible UI.
 */
import assert from "node:assert/strict";
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile } from "./harness.mjs";
import { cases, cleanup } from "./cases/connectors.mjs";

let client = await Client.launch(),
  page = client.page(0);
const connector = { name: `e2e-deepwiki-home-${Date.now().toString(36)}` };
const api = "window['claude.web'].LocalAgentModeSessions";
let id, workspace;
const mark = client.logMark();
async function send(text) {
  await page.eval(`__e2e.type(${JSON.stringify(text)})`);
  await page.waitFor(
    `(()=>{const b=__e2e.all('button').find(b=>__e2e.visible(b)&&!b.disabled&&/^(Send|Send message|Start task)$/.test(b.getAttribute('aria-label')??''));if(!b)return false;b.dataset.e2eCoworkSend='1';return true})()`,
    30000,
    250,
  );
  await page.click('[data-e2e-cowork-send="1"]');
}
try {
  const added = await page.api("/api/organizations/x/mcp/remote_servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: connector.name,
      url: "https://mcp.deepwiki.com/mcp",
    }),
  });
  assert.equal(added.status, 200);
  connector.uuid = added.body.uuid;
  await cases[1].run(page, connector);
  await page.goto("/task/new");
  if (
    await page.eval(
      `__e2e.all('button[aria-label="Dismiss"]').some(__e2e.visible)`,
    )
  )
    await page.click('button[aria-label="Dismiss"]');
  const prompt =
    "Only reply COWORK_HOME_READY. Do not use tools, run commands, or edit files.";
  await send(prompt);
  id = await page.waitFor(
    `${api}.getSessionList().then(r=>r.sessions.find(s=>s.initialMessage===${JSON.stringify(prompt)})?.sessionId)`,
    90000,
    1000,
  );
  const session = await page.eval(`${api}.getSession(${JSON.stringify(id)})`);
  workspace = session.cwd;
  await page.waitFor(
    `location.pathname.includes(${JSON.stringify(id)})`,
    30000,
    500,
  );
  await page.waitFor(
    `${api}.getTranscript(${JSON.stringify(id)}).then(rows=>rows.some(r=>r.type==='assistant'&&JSON.stringify(r.message.content).includes('COWORK_HOME_READY')))`,
    120000,
    1000,
  );
  await page.waitFor(
    `${api}.getSession(${JSON.stringify(id)}).then(s=>s&&!s.isRunning)`,
    30000,
    500,
  );
  await send(
    "Only reply COWORK_HOME_FOLLOWUP. Do not use tools, run commands, or edit files.",
  );
  await page.waitFor(
    `${api}.getTranscript(${JSON.stringify(id)}).then(rows=>rows.some(r=>r.type==='assistant'&&JSON.stringify(r.message.content).includes('COWORK_HOME_FOLLOWUP')))`,
    120000,
    1000,
  );
  await page.waitFor(
    `${api}.getSession(${JSON.stringify(id)}).then(s=>s&&!s.isRunning)`,
    30000,
    500,
  );
  await page.goto(`/cowork/${id}`);
  await page.waitFor(
    "(document.querySelector('main')?.innerText.match(/COWORK_HOME_FOLLOWUP/g)||[]).length>=2",
    30000,
    500,
  );
  const failures = client
    .logSince(mark)
    .filter((l) =>
      /LocalAgentModeSessions_\$_(?:start|sendMessage).*Error:|Cowork start does not support/.test(
        l,
      ),
    );
  assert.deepEqual(failures, []);
  console.log(
    "Official Cowork homepage first send, configured connector snapshot, model reply, UI follow-up and reopen passed.",
  );
  console.log(`Client evidence before full restart: ${client.logFile}`);
  const quitMs=await client.quit();client=await Client.launch();page=client.page(0);
  await page.goto(`/cowork/${id}`);
  await page.waitFor("(document.querySelector('main')?.innerText.match(/COWORK_HOME_FOLLOWUP/g)||[]).length>=2",30000,500);
  console.log(JSON.stringify({result:"passed",completedAt:new Date().toISOString(),quitMs,scope:"official Cowork homepage first send with configured connector, two real replies, remount and normal quit/restart history persistence"}));
} catch (error) {
  console.error("Cowork homepage failure:", error.message);
  console.error(
    await page
      .eval(
        "({path:location.pathname,text:document.querySelector('main')?.innerText?.slice(-4000),buttons:__e2e.all('button').filter(__e2e.visible).map(b=>({label:b.getAttribute('aria-label'),text:b.innerText,disabled:b.disabled}))})",
      )
      .catch(() => null),
  );
  console.error(
    client
      .logSince(mark)
      .filter((l) =>
        /not supported|native failed|request failed|Error:/.test(l),
      )
      .slice(-10),
  );
  throw error;
} finally {
  if (id) {
    await page
      .eval(`${api}.stop(${JSON.stringify(id)}).catch(()=>{})`)
      .catch(() => {});
    await page.eval(`${api}.delete(${JSON.stringify(id)})`).catch((error) => {
      console.error("Cowork test cleanup:", error.message);
      process.exitCode = 1;
    });
  }
  try {
    await cleanup(page, connector);
  } finally {
    console.log(`Client evidence: ${client.logFile}`);
    await client.stop();
    if (
      workspace &&
      path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) &&
      /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)
    )
      await rmdir(workspace).catch(() => {});
  }
}
