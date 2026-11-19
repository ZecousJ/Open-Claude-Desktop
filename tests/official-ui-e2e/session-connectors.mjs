/** Official Code/Cowork connector selection, persistence and official account defaults. */
import assert from "node:assert/strict";
import { readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile } from "./harness.mjs";
import { cases, cleanup } from "./cases/connectors.mjs";

let client = await Client.launch();
let page = client.page(0);
const connector = {};
const sessions = [];
async function openConnector() {
  await page.eval("__e2e.closeMenus()");
  await page.eval(`(()=>{window.__connectorPointer=[];if(!window.__connectorPointerInstalled){window.__connectorPointerInstalled=true;document.addEventListener('click',e=>window.__connectorPointer.push({target:e.target.closest('button')?.getAttribute('aria-label'),trusted:e.isTrusted}),true)}})()`);
  const addSelector=`button[aria-label="${connector.mode === "cowork" ? "Add files, connectors, and more" : "Add"}"]`;
  for(let attempt=0;attempt<3;attempt++){
    await page.click(addSelector);
    try {await page.waitFor(`__e2e.all('[role=menu]').some(__e2e.visible)`,3000,100);break;}
    catch(error){console.log('Menu click evidence:',await page.eval(`({events:window.__connectorPointer,expanded:document.querySelector(${JSON.stringify(addSelector)})?.getAttribute('aria-expanded'),menus:__e2e.all('[role=menu]').filter(__e2e.visible).map(e=>e.innerText)})`));if(attempt===2)throw error;}
  }
  await page.waitFor(
    `(() => {document.querySelectorAll('[data-e2e-connectors-menu]').forEach(e=>e.removeAttribute('data-e2e-connectors-menu'));const e=__e2e.all('[role=menuitem]').find(e=>__e2e.visible(e)&&/connectors/i.test(e.innerText));if(!e)return false;e.dataset.e2eConnectorsMenu='1';return e.getAttribute('aria-disabled')!=='true'})()`,
    60000,
    250,
  );
  await page.click('[data-e2e-connectors-menu="1"]');
  try{await page.waitFor(`__e2e.all('[role=menuitemcheckbox]').some(e=>__e2e.visible(e)&&e.innerText.includes(${JSON.stringify(connector.name)}))`,3000,100);}
  catch{
    await page.eval(`document.querySelector('[data-e2e-connectors-menu="1"]').focus()`);
    const response=await fetch(client.origin+"/__debug/key?key=Right",{method:"POST",headers:{Cookie:client.cookie}});
    assert.equal(response.status,204,"Native submenu keyboard input must be accepted");
  }
  await page.waitFor(
    `(() => {document.querySelectorAll('[data-e2e-session-connector]').forEach(e=>e.removeAttribute('data-e2e-session-connector'));const row=__e2e.all('[role=menuitemcheckbox]').find(e=>__e2e.visible(e)&&e.innerText.includes(${JSON.stringify(connector.name)}));if(!row)return false;row.dataset.e2eSessionConnector='1';return true})()`,
    60000,
    500,
  );
  return page.eval(
    `document.querySelector('[data-e2e-session-connector="1"]').getAttribute('aria-checked')`,
  );
}
async function exerciseTool(mode, domain, id, route) {
  await page.eval("__e2e.closeMenus()");
  const deny = process.env.SESSION_CONNECTOR_DECISION === "deny";
  const marker = `${mode.toUpperCase()}_MCP_TOOL_${deny ? "DENIED" : "COMPLETE"}`;
  const prompt = `Use only the ${connector.name} connector read_wiki_structure tool with repoName microsoft/TypeScript. Do not run commands, search the web, or edit files. After receiving its result or a denial, reply ${marker}. Do not retry a denied tool.`;
  const priorRows=new Set((await page.eval(`window['claude.web'][${JSON.stringify(domain)}].getTranscript(${JSON.stringify(id)})`)).map(row=>row.uuid));
  await page.eval(`__e2e.type(${JSON.stringify(prompt)})`);
  await page.waitFor(
    `(()=>{const b=__e2e.all('button').find(b=>__e2e.visible(b)&&/^(Send|Send message)$/.test(b.getAttribute('aria-label')??'')&&!b.disabled);if(!b)return false;b.dataset.e2eSendConnector='1';return true})()`,
  );
  await page.click('[data-e2e-send-connector="1"]');
  const request = await page.waitFor(
    `window['claude.web'][${JSON.stringify(domain)}].getSession(${JSON.stringify(id)}).then(s=>s?.pendingToolPermissions?.[0])`,
    120000,
    500,
  );
  assert.equal(
    request.toolName,
    `mcp__${connector.name}__read_wiki_structure`,
    `${mode}: the requested tool must match the fixture`,
  );
  assert.deepEqual(request.input, { repoName: "microsoft/TypeScript" });
  await page.goto(route);
  await page.waitFor(
    `__e2e.mainText().includes('microsoft/TypeScript')&&/allow|approve/i.test(__e2e.mainText())`,
    30000,
    250,
  );
  await page.waitFor(
    `(()=>{const b=__e2e.all('button').find(b=>__e2e.visible(b)&&${deny ? "/^Deny$/" : "/^(Allow once|Allow|Approve)$/"}.test(b.innerText.trim().split(String.fromCharCode(10))[0]));if(!b)return false;b.dataset.e2eApproveConnector='1';return true})()`,
  );
  // Official permission controls ignore input during their first second.
  await page.eval("__e2e.sleep(1100)");
  await page.click('[data-e2e-approve-connector="1"]');
  await page.waitFor(
    `window['claude.web'][${JSON.stringify(domain)}].getSession(${JSON.stringify(id)}).then(s=>s&&!s.isRunning&&!s.turnRunning&&!s.pendingToolPermissions?.length)`,
    120000,
    1000,
  );
  const rows = await page.eval(
    `window['claude.web'][${JSON.stringify(domain)}].getTranscript(${JSON.stringify(id)})`,
  );
  const content = rows.filter(row=>!priorRows.has(row.uuid)).flatMap((row) =>
    Array.isArray(row.message?.content) ? row.message.content : [],
  );
  const calls = content.filter(
    (block) =>
      block.type === "tool_use" && block.name === "read_wiki_structure",
  );
  assert.equal(calls.length, 1, `${mode}: exactly one matching tool call`);
  const result = content.find(
    (block) =>
      block.type === "tool_result" && block.tool_use_id === calls[0].id,
  );
  assert.ok(
    result &&
      (deny ? result.is_error : !result.is_error) &&
      result.content?.length > 0,
    `${mode}: a real MCP success or denial must be preserved`,
  );
  assert.ok(
    content.some(
      (block) => block.type === "text" && block.text?.includes(marker),
    ),
    `${mode}: real model must finish after the tool result`,
  );
  await page.goto(route);
  await page.waitFor(
    `__e2e.mainText().includes(${JSON.stringify(marker)})`,
    30000,
    500,
  );
  console.log(
    `${mode}: real DeepWiki call, reopened approval, UI ${deny ? "deny" : "allow-once"}, tool result and final reply verified.`,
  );
}
try {
  connector.name = `e2e-deepwiki-${Date.now().toString(36)}`;
  const added = await page.api("/api/organizations/x/mcp/remote_servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: connector.name,
      url: "https://mcp.deepwiki.com/mcp",
    }),
  });
  assert.equal(
    added.status,
    200,
    "fixture connector must be configured before session testing",
  );
  connector.uuid = added.body.uuid;
  await cases[1].run(page, connector);
  const original = await page.api("/api/account");
  for (const mode of (
    process.env.SESSION_CONNECTOR_MODES ?? "code,cowork"
  ).split(",")) {
    assert.ok(["code", "cowork"].includes(mode));
    connector.mode = mode;
    console.log(`${mode}: creating the real conversation.`);
    const domain = mode === "code" ? "LocalSessions" : "LocalAgentModeSessions";
    const existing=process.env.SESSION_CONNECTOR_REUSE==="1" ? await page.eval(`window['claude.web'][${JSON.stringify(domain)}].getSessionList().then(r=>r.sessions.find(s=>!s.turnRunning&&!s.isRunning&&!s.isArchived)?.sessionId)`) : undefined;
    const id = existing ?? await page.eval(
      `window['claude.web'][${JSON.stringify(domain)}].start({cwd:'',message:'Only reply SESSION_CONNECTORS_READY. Do not use tools or edit files.',permissionMode:'default',thinkingSummariesWanted:false}).then(r=>r.sessionId)`,
    );
    const session = { id, domain, mode, reused:!!existing };
    sessions.push(session);
    session.workspace = await page.eval(
      `window['claude.web'][${JSON.stringify(domain)}].getSession(${JSON.stringify(id)}).then(s=>s?.cwd)`,
    );
    if(!existing)await page.waitFor(
      `window['claude.web'][${JSON.stringify(domain)}].getTranscript(${JSON.stringify(id)}).then(rows=>rows.some(r=>r.type==='assistant'&&JSON.stringify(r.message.content).includes('SESSION_CONNECTORS_READY')))`,
      120000,
      1000,
    );
    await page.waitFor(
      `window['claude.web'][${JSON.stringify(domain)}].getSession(${JSON.stringify(id)}).then(s=>s&&!s.isRunning)`,
      30000,
      500,
    );
    const route = `/${mode === "code" ? "epitaxy" : "cowork"}/${id}`;
    await page.goto(route);
    let mark = client.logMark();
    assert.equal(
      await openConnector(),
      "true",
      `${mode}: connector begins enabled`,
    );
    await page.click('[data-e2e-session-connector="1"]');
    let storeRoot;
    if(mode==="code"){
      const profileRoot=path.resolve(profile);
      for(let candidate=path.resolve(session.workspace);candidate===profileRoot||candidate.startsWith(profileRoot+path.sep);candidate=path.dirname(candidate)){
        const rows=await readFile(path.join(candidate,"conversations.json"),"utf8").then(JSON.parse).catch(()=>null);
        if(Array.isArray(rows)&&rows.some(c=>c.id===id.slice(6))){storeRoot=candidate;break;}
        if(candidate===profileRoot)break;
      }
      assert.ok(storeRoot,"Resolve the store that actually contains this test session");
    }
    if (storeRoot)
      assert.ok(
        storeRoot === path.resolve(profile) ||
          storeRoot.startsWith(path.resolve(profile) + path.sep),
      );
    const stored = async (value) => {
      const rows = JSON.parse(
        await readFile(path.join(storeRoot, "conversations.json"), "utf8"),
      );
      const c = rows.find((c) => c.id === id.slice(6));
      const settings=JSON.parse(await readFile(path.join(storeRoot,"settings.json"),"utf8"));
      const server=settings.mcpServers?.[connector.name];
      if(!c||!server)return false;
      // Official toggle PATCHes account defaults. A session need not duplicate
      // those defaults; only explicit local overrides add another restriction.
      return ["ask_wiki_question","read_wiki_contents","read_wiki_structure"].every(tool=>{
        const enabled=server.enabled!==false&&!(server.disabled_tools??[]).includes(tool)&&c.connectorOverrides?.[connector.name]!==false&&c.connectorToolOverrides?.[connector.name]?.[tool]!==false;
        return enabled===value;
      });
    };
    const waitStored = async (value) => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        if (await stored(value)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(`${mode}: disk configuration did not retain ${value}`);
    };
    const hydrated = (value) =>
      `window['claude.web'][${JSON.stringify(domain)}].getSession(${JSON.stringify(id)}).then(s=>{const tools=Object.entries(s?.enabledMcpTools??{}).filter(([key])=>key.startsWith(${JSON.stringify(connector.uuid + ":")})&&!/-[0-9a-f]{32}$/.test(key));return tools.length===3&&tools.every(([,enabled])=>enabled===${value})})`;
    if (mode === "code") await waitStored(false);
    console.log(`${mode}: disabled effective permissions saved on disk.`);
    await page.waitFor(hydrated(false), 60000, 500);
    await page.waitFor(
      `fetch('/api/account').then(r=>r.json()).then(a=>["ask_wiki_question","read_wiki_contents","read_wiki_structure"].every(k=>a.settings?.enabled_mcp_tools?.[${JSON.stringify(connector.uuid + ":")}+k]===false))`,
      60000,
      500,
    );
    await page.goto(route);
    console.log(`${mode}: checking menu after route remount.`);
    await openConnector();
    await page.waitFor(
      `document.querySelector('[data-e2e-session-connector="1"]')?.getAttribute('aria-checked') === 'false'`,
      15000,
      250,
    );
    assert.equal(
      await page.eval(
        `document.querySelector('[data-e2e-session-connector="1"]')?.getAttribute('aria-checked')`,
      ),
      "false",
      `${mode}: remount retains disabled connector`,
    );
    console.log(`Client evidence before ${mode} restart: ${client.logFile}`);
    const quitMs=await client.quit();
    client=await Client.launch();page=client.page(0);mark=0;
    await page.goto(route);await page.waitFor(hydrated(false),60000,500);
    assert.equal(await openConnector(),"false",`${mode}: full client restart retains disabled connector`);
    console.log(`${mode}: full normal quit (${quitMs} ms), restart and disabled menu state verified.`);
    await page.click('[data-e2e-session-connector="1"]');
    await page.waitFor(hydrated(true), 60000, 1000);
    await page.waitFor(
      `fetch('/api/account').then(r=>r.json()).then(a=>["ask_wiki_question","read_wiki_contents","read_wiki_structure"].every(k=>a.settings?.enabled_mcp_tools?.[${JSON.stringify(connector.uuid + ":")}+k]===true))`,
      60000,
      500,
    );
    if (mode === "code") await waitStored(true);
    const enabledSession = await page.eval(
      `window['claude.web'][${JSON.stringify(domain)}].getSession(${JSON.stringify(id)})`,
    );
    assert.ok(
      Object.entries(enabledSession.enabledMcpTools ?? {}).some(
        ([key, value]) => key.startsWith(connector.uuid) && value === true,
      ),
      `${mode}: getSession restores the enabled connector tools`,
    );
    const failures = client
      .logSince(mark)
      .filter((line) =>
        /Error.*(?:setMcpServers|replaceRemoteMcpServers|replaceEnabledMcpTools)|(?:setMcpServers|replaceRemoteMcpServers|replaceEnabledMcpTools).*Error/.test(
          line,
        ),
      );
    assert.deepEqual(failures, [], `${mode}: connector writes must not fail`);
    console.log(
      `${mode}: connector disabled in UI, remained disabled after reopen, and was enabled again.`,
    );
    if (process.env.SESSION_CONNECTOR_TOOL_CALL === "1")
      await exerciseTool(mode, domain, id, route);
  }
  const after = await page.api("/api/account");
  assert.deepEqual(
    after.body.settings?.enabled_mcp_tools,
    original.body.settings?.enabled_mcp_tools,
    "restoring the connector must restore its original account tool defaults",
  );
  console.log(JSON.stringify({result:"passed",completedAt:new Date().toISOString(),scope:"Code/Cowork connector UI disable, remount, normal quit/restart, persisted disabled state and re-enable; account defaults restored",toolCall:process.env.SESSION_CONNECTOR_TOOL_CALL==="1",decision:process.env.SESSION_CONNECTOR_DECISION??"allow"}));
} catch (error) {
  console.error("Session connector failure:", error.message);
  console.error(
    "Current official UI:",
    await page
      .eval(
        `({path:location.pathname,buttons:__e2e.all('button').filter(__e2e.visible).map(b=>({label:b.getAttribute('aria-label'),text:b.innerText})),text:__e2e.mainText().slice(-4000)})`,
      )
      .catch(() => null),
  );
  console.error(
    "Connector adapter diagnostics:",
    client
      .logSince(0)
      .filter((l) =>
        /SESSION_CONNECTOR_|Claudex stop (?:error|reconciliation)|native failed|request failed|Failed to sync|Failed to auto-add|Failed to update MCP/.test(
          l,
        ),
      )
      .slice(-30),
  );
  console.error(
    "Session connector verification:",
    JSON.stringify(
      await page
        .eval(
          `(async()=>{const s=await window['claude.web'][${JSON.stringify(sessions.at(-1)?.domain)}].getSession(${JSON.stringify(sessions.at(-1)?.id)}).catch(()=>null);const connectors=await fetch('/api/organizations/x/mcp/remote_servers_with_connection').then(r=>r.json()).catch(e=>String(e));return {path:location.pathname,menus:__e2e.all('[role=menu]').filter(__e2e.visible).map(e=>e.innerText),switches:__e2e.all('[role=menuitemcheckbox]').filter(__e2e.visible).map(e=>({text:e.innerText,checked:e.getAttribute('aria-checked')})),session:s&&{sessionId:s.sessionId,enabledMcpTools:s.enabledMcpTools},connectors}})()`,
        )
        .catch(() => null),
    ),
  );
  throw error;
} finally {
  await page.goto("/new").catch(() => {});
  for (const session of sessions) {
    if(session.reused)continue;
    await page
      .eval(
        `window['claude.web'][${JSON.stringify(session.domain)}].stop(${JSON.stringify(session.id)}).catch(()=>{})`,
      )
      .catch(() => {});
    try {
      await page.eval(
        `window['claude.web'][${JSON.stringify(session.domain)}].delete(${JSON.stringify(session.id)})`,
      );
      if (
        session.mode === "code" &&
        session.workspace &&
        path
          .resolve(session.workspace)
          .startsWith(path.resolve(profile) + path.sep) &&
        /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(session.workspace)
      )
        await rmdir(session.workspace).catch(() => {});
    } catch (error) {
      console.error(`Test session cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  try {
    await cleanup(page, connector);
  } finally {
    console.log(`Client evidence: ${client.logFile}`);
    await client.stop();
  }
}
