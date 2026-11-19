/** The normal Code landing page must create its own workspace and send without experimental flags. */
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile, sleep } from "./harness.mjs";
import { cases, cleanup } from "./cases/connectors.mjs";

const first =
  "Only reply with CODE_LANDING_OK. Do not run commands or edit files.";
const followup =
  "Only reply with CODE_LANDING_FOLLOWUP. Do not run commands or edit files.";
const client = await Client.launch();
const page = client.page(0);
let id;
let workspace;
let deleted = false;
let originalSelection;
let organization;
const connector = {};
try {
  if (process.env.CODE_START_CONNECTOR === "1") {
    connector.name = `e2e-deepwiki-codehome-${Date.now().toString(36)}`;
    const added=await page.api('/api/organizations/x/mcp/remote_servers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:connector.name,url:'https://mcp.deepwiki.com/mcp'})});
    if(added.status!==200)throw Error('Code fixture connector could not be created');
    connector.uuid=added.body.uuid;
    await cases[1].run(page,connector);
  }
  ({ selection: originalSelection, organization } = await page.eval(`fetch('/api/bootstrap').then(r => r.json()).then(b => ({selection:b.model_selector_state.find(s=>s.id==='code'),organization:b.featureFlagsOrgUuid}))`));
  await page.goto("/epitaxy");
  await page.eval(`__e2e.type(${JSON.stringify(first)})`);
  await page.eval(
    `(async () => { const b = await __e2e.waitFor(() => __e2e.byLabel('Send').find(b => !b.disabled)); __e2e.press(b); })()`,
  );
  id = await page.waitFor(
    `(/^\\/epitaxy\\/(local_[^/]+)$/.exec(location.pathname) || [])[1]`,
    30000,
  );
  workspace = await page.eval(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.cwd)`,
  );
  if (
    !workspace ||
    !path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) ||
    !/[\\/]workspace[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)
  )
    throw Error(
      "The Code landing page did not create an isolated workspace in its test profile.",
    );
  const replied = (marker) =>
    `window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes(${JSON.stringify(marker)})))`;
  await page.waitFor(replied("CODE_LANDING_OK"), 120000, 1000);
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`,
    120000,
    1000,
  );
  await page.waitFor(
    "(document.body.innerText.match(/CODE_LANDING_OK/g) || []).length >= 2",
    30000,
  );
  await page.eval(`__e2e.type(${JSON.stringify(followup)})`);
  await page.eval(
    `(async () => { const b = await __e2e.waitFor(() => __e2e.byLabel('Send').find(b => !b.disabled)); __e2e.press(b); })()`,
  );
  await page.waitFor(replied("CODE_LANDING_FOLLOWUP"), 120000, 1000);
  await page.waitFor(
    "(document.body.innerText.match(/CODE_LANDING_FOLLOWUP/g) || []).length >= 2",
    30000,
  );
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`,
    120000,
    1000,
  );
  await page.eval(`(async()=>{
    await __e2e.openMenu(()=>[...document.querySelectorAll('button[aria-label^="Model:"]')].find(__e2e.visible));
    const effort=await __e2e.waitFor(()=>__e2e.all('[role=menuitem]').find(e=>__e2e.visible(e)&&e.innerText.includes('Effort')));
    __e2e.press(effort);
    const low=await __e2e.waitFor(()=>__e2e.all('[role=menuitemradio], [role=menuitem]').find(e=>__e2e.visible(e)&&e.textContent.replace(/[\\uE000-\\uF8FF]/g,'').trim()==='Low'));
    __e2e.press(low);await __e2e.closeMenus();
  })()`);
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s?.effort==='low')`);
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(
    "(document.body.innerText.match(/CODE_LANDING_FOLLOWUP/g) || []).length >= 2",
    30000,
  );
  await page.waitFor(`document.querySelector('button[aria-label^="Model:"]')?.getAttribute('aria-label')?.endsWith(' Low')`);
  await page.eval(
    `(() => { window.__terminalOutput = ''; window.__terminalUnsubscribe = window['claude.web'].LocalSessions.onOnEvent(e => { if(e.type === 'shell_pty_data' && e.sessionId === ${JSON.stringify(id)}) window.__terminalOutput += e.data; }); })()`,
  );
  const terminal = await page.eval(
    `window['claude.web'].LocalSessions.startShellPty(${JSON.stringify(id)},80,24,'test')`,
  );
  if (!terminal?.ok)
    throw Error(`The session terminal could not start: ${terminal?.error}`);
  await page.eval(
    `window['claude.web'].LocalSessions.writeShellPty(${JSON.stringify(id)},${JSON.stringify("printf '%s%s\\n' CLAUDEX_TERMINAL_ OK\n")})`,
  );
  await page.waitFor(
    "window.__terminalOutput.includes('CLAUDEX_TERMINAL_OK')",
    20000,
  );
  await page.eval(
    `window['claude.web'].LocalSessions.stopShellPty(${JSON.stringify(id)})`,
  );
  await page.eval("window.__terminalUnsubscribe()");
  const gaps = client
    .gapsSince(0)
    .filter((line) =>
      /LocalSessions_\$_(?:createScratchWorkspace|start|sendMessage|getSession|getTranscript)(?:'|\b)/.test(
        line,
      ),
    );
  if (gaps.length)
    throw Error(
      `Code calls were not connected: ${gaps.map((line) => line.slice(0, 200)).join("; ")}`,
    );
  console.log(
    "PASS: Code landing page created a workspace, received a real reply and follow-up, saved effort through the UI, reopened both messages and effort, and ran its terminal without experimental flags.",
  );
} catch (error) {
  console.error(
    "Code native errors:",
    client
      .logSince(0)
      .filter((line) => /Error occurred in handler.*LocalSessions/.test(line))
      .map((line) => line.slice(0, 350))
      .slice(-15),
  );
  throw error;
} finally {
  if (originalSelection && organization) {
    await page.eval(`fetch('/api/organizations/'+${JSON.stringify(organization)}+'/model_selector_state/code',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ model: originalSelection.model, thinking: originalSelection.thinking })})}).then(r=>{if(!r.ok)throw Error('Could not restore the test model default')})`).catch(error => { console.error(error.message); process.exitCode=1; });
    await sleep(700); // Allow the restored test preference's deferred write before stopping Electron.
  }
  if (id) {
    await page
      .eval(
        `window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(() => {})`,
      )
      .catch(() => {});
    try {
      await page.eval(
        `window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`,
      );
      deleted = true;
    } catch (error) {
      console.error(`Test session cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  await cleanup(page, connector).catch(error=>{console.error(error.message);process.exitCode=1;});
  console.log(`Client evidence: ${client.logFile}`);
  await client.stop();
  if (
    deleted &&
    workspace &&
    path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) &&
    /[\\/]workspace[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)
  )
    await rmdir(workspace).catch((error) => {
      if (error.code !== "ENOENT")
        console.error(`Test workspace retained: ${workspace}`);
    });
}
