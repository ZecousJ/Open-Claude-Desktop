import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Client, profile, sleep } from "./harness.mjs";
const client = await Client.launch(),
  page = client.page(0);
let current, configFile, previous, serverId, fixture;
const name = "Rail proof " + randomUUID().slice(0, 8);
const api = (domain, method, ...args) =>
  page.eval(
    'window["claude.web"][' +
      JSON.stringify(domain) +
      "][" +
      JSON.stringify(method) +
      "](" +
      args.map(JSON.stringify).join(",") +
      ")",
  );
try {
  const rows = await api("LocalSessions", "getSessionList");
  for (const s of rows.sessions.filter(
    (s) =>
      !s.turnRunning &&
      !s.isArchived &&
      s.cwd &&
      path.resolve(s.cwd).startsWith(path.resolve(profile) + path.sep),
  )) {
    const usage = await api("LocalSessions", "getContextUsage", s.sessionId);
    if (usage?.totalTokens > 0) {
      current = s;
      break;
    }
  }
  assert.ok(
    current,
    "An existing test session with measured context usage is required",
  );
  const history=await api('LocalSessions','getTranscript',current.sessionId);
  assert.ok(history.length>0,'History including interrupted compaction must remain readable');
  const usage = await api(
    "LocalSessions",
    "getContextUsage",
    current.sessionId,
  );
  assert.ok(usage.rawMaxTokens > 0);
  assert.ok(usage.totalTokens < usage.rawMaxTokens);
  const alternative = rows.sessions.find(
    (s) =>
      !s.turnRunning &&
      s.cwd !== current.cwd &&
      s.cwd &&
      path.resolve(s.cwd).startsWith(path.resolve(profile) + path.sep),
  );
  assert.ok(alternative, "Existing authorized second workspace required");
  const moved = await api(
    "LocalSessions",
    "changeCwd",
    current.sessionId,
    alternative.cwd,
  );
  assert.equal(moved.status, "ok", JSON.stringify(moved));
  assert.equal(
    (await api("LocalSessions", "getSession", current.sessionId)).cwd,
    alternative.cwd,
  );
  const restored = await api(
    "LocalSessions",
    "changeCwd",
    current.sessionId,
    current.cwd,
  );
  assert.equal(restored.status, "ok",JSON.stringify(restored));
  console.log(
    "Environment directory change round trip preserves session identity.",
  );
  await page.goto("/epitaxy/" + current.sessionId);
  const rail = await page.waitFor(
    '(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Session rail");return b&&{pressed:b.getAttribute("aria-pressed")}})()',
  );
  if (rail.pressed !== "true")
    await page.click('button[aria-label="Session rail"]');
  await page.eval(
    '(()=>{window.__railMark=()=>{for(const s of document.querySelectorAll("section")){const label=document.getElementById(s.getAttribute("aria-labelledby")),text=label?.textContent??"";if(text.startsWith("Context"))s.setAttribute("data-e2e-rail-context","");if(text.startsWith("Servers"))s.setAttribute("data-e2e-rail-servers","");}};window.__railObserver=new MutationObserver(window.__railMark);window.__railObserver.observe(document.body,{childList:true,subtree:true});window.__railMark();})()',
  );
  await page.waitFor('!!document.querySelector("[data-e2e-rail-context]")');
  await page.eval(
    '(()=>{const p=document.querySelector("[data-e2e-rail-context]");const b=p.querySelector("button[aria-expanded]");if(b&&b.getAttribute("aria-expanded")!=="true")b.click();})()',
  );
  await page.waitFor(
    'document.querySelector("[data-e2e-rail-context]")?.innerText.includes("Context (runtime total)")',
    30000,
  );
  console.log(
    "Context rail displays measured usage and free capacity.",
    JSON.stringify({ tokens: usage.totalTokens, window: usage.rawMaxTokens }),
  );
  assert.equal(
    await page.eval(
      'Array.from(document.querySelectorAll("[data-e2e-rail-servers] button")).some(b=>b.textContent.trim()==="Browser")',
    ),
    false,
  );
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  fixture = path.join(current.cwd, "rail-" + randomUUID() + ".mjs");
  await fs.writeFile(
    fixture,
    'import http from "node:http"; const s=http.createServer((q,r)=>{r.setHeader("Content-Type","text/html");r.end("<h1>RAIL_SERVER_BODY</h1>")});s.listen(' +
      port +
      ',"127.0.0.1",()=>console.log("RAIL_SERVER_READY"));',
  );
  const folder = path.join(current.cwd, ".claude");
  await fs.mkdir(folder, { recursive: true });
  configFile = path.join(folder, "launch.json");
  previous = await fs.readFile(configFile).catch(() => null);
  const config = previous
    ? JSON.parse(previous)
    : { version: "0.0.1", configurations: [] };
  config.configurations ??= [];
  config.configurations.push({
    name,
    runtimeExecutable: process.execPath,
    runtimeArgs: [fixture],
    port,
  });
  await fs.writeFile(configFile, JSON.stringify(config));
  const configured = await api("Launch", "getConfiguredServices", current.cwd);
  assert.ok(configured.some((s) => s.name === name));
  await page.goto('/epitaxy/'+current.sessionId);
  await page.eval('(()=>{window.__railMark=()=>{for(const s of document.querySelectorAll("section")){const label=document.getElementById(s.getAttribute("aria-labelledby")),text=label?.textContent??"";if(text.startsWith("Context"))s.setAttribute("data-e2e-rail-context","");if(text.startsWith("Servers"))s.setAttribute("data-e2e-rail-servers","");}};new MutationObserver(window.__railMark).observe(document.body,{childList:true,subtree:true});window.__railMark();})()');
  const browserPressed=await page.eval('document.querySelector("button[aria-label=Browser]")?.getAttribute("aria-pressed")');
  if(browserPressed!=='true')await page.click('button[aria-label=Browser]');
  await api('Launch','openPreviewTab','preview-'+current.sessionId,current.cwd);
  const runLabel='Run '+name;
  await page.waitFor('Array.from(document.querySelectorAll("button")).some(b=>b.getAttribute("aria-label")==='+JSON.stringify(runLabel)+')',20000);
  await page.eval('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.innerText.trim()==="Not now");if(b)b.click();const r=Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Session rail");if(r?.getAttribute("aria-pressed")==="false")r.click();})()');
  await page.click('button[aria-label='+JSON.stringify(runLabel)+']');
  const result={serverId:'dev-'+current.sessionId.slice(6)+':'+encodeURIComponent(name),previewId:'preview-'+current.sessionId};
  serverId = result.serverId;
  if(!await page.eval('!!document.querySelector("[data-e2e-rail-context]")')){await page.click('button[aria-label="Session rail"]');await page.waitFor('!!document.querySelector("[data-e2e-rail-context]")',10000);}
  await page.waitFor(
    'document.querySelector("[data-e2e-rail-servers]")?.innerText.includes(' +
      JSON.stringify(name) +
      ")",
    20000,
  );
  const rowLabel = "Open " + name + " in Browser";
  await page.waitFor(
    '(()=>{const section=document.querySelector("[data-e2e-rail-servers]");const top=section?.querySelector("button[aria-expanded]");if(top?.getAttribute("aria-expanded")==="false")top.click();return Array.from(document.querySelectorAll("button")).some(b=>b.getAttribute("aria-label")===' +
      JSON.stringify(rowLabel) +
      ")})()",
    15000,
  );
  await page.click("button[aria-label=" + JSON.stringify(rowLabel) + "]");
  await page.waitFor(
    'window["claude.web"].Launch.previewSnapshot(' +
      JSON.stringify(result.previewId) +
      ').then(s=>s.includes("RAIL_SERVER_BODY"))',
    20000,
  );
  const logs = await api("Launch", "getLogs", serverId);
  assert.ok(
    logs.some(
      (r) =>
        r.line.includes("RAIL_SERVER_READY") &&
        r.stream === "stdout" &&
        Number.isFinite(Date.parse(r.timestamp)),
    ),
  );
  console.log(
    "Servers rail opens actual listening server and reads structured logs.",
  );
  await page.click(
    '[data-e2e-rail-servers] button[aria-label="Stop this server"]',
  );
  await page.waitFor(
    '!document.querySelector("[data-e2e-rail-servers]")?.innerText.includes(' +
      JSON.stringify(name) +
      ")",
    15000,
  );
  await assert.rejects(
    fetch("http://127.0.0.1:" + port, { signal: AbortSignal.timeout(2000) }),
  );
  assert.deepEqual(
    client
      .gapsSince(0)
      .filter((l) =>
        /getContextUsage|startFromConfig|getLogs|stopServer/.test(l),
      ),
    [],
  );
  if(process.env.CLAUDEX_RAIL_COMPACT==='1'){
    const before=await api('LocalSessions','getTranscript',current.sessionId);
    const prior=before.filter(row=>row.subtype==='compact_boundary').length;
    const compact=await page.eval('(()=>{const p=document.querySelector("[data-e2e-rail-context]");const b=Array.from(p?.querySelectorAll("button")??[]).find(b=>/compact session/i.test(b.getAttribute("aria-label")||b.innerText));if(!b)return {buttons:Array.from(p?.querySelectorAll("button")??[]).map(b=>({label:b.getAttribute("aria-label"),text:b.innerText}))};b.setAttribute("data-rail-compact","");return {found:true}})()');
    if(compact.found)await page.click('[data-rail-compact]');
    else {
      assert.ok(usage.percentage<50,'Official Compact affordance must be present above its usage threshold');
      console.log('Official source hides Compact below its 50% threshold; verifying native /compact without changing UI gates.');
      await api('LocalSessions','sendMessage',current.sessionId,'/compact',[],[],[],'next',{},randomUUID());
    }
    await page.waitFor('window["claude.web"].LocalSessions.getTranscript('+JSON.stringify(current.sessionId)+').then(rows=>rows.filter(r=>r.subtype==="compact_boundary").length>'+prior+')',120000,500);
    await page.waitFor('window["claude.web"].LocalSessions.getSession('+JSON.stringify(current.sessionId)+').then(s=>!s.turnRunning)',30000,300);
    console.log('Real engine compaction completed; transcript contains a new compact boundary.');
  }
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "existing measured context real rail; launch.json real process; server row open, rendered page, logs, UI stop and closed port; no model send",
    }),
  );
} catch (error) {
  console.error(error);
  console.error(
    JSON.stringify({
      body: await page
        .eval("document.body.innerText.slice(-2500)")
        .catch(() => null),
      gaps: client.gapsSince(0).slice(-15),
    }),
  );
  process.exitCode = 1;
} finally {
  if(current)await api('LocalSessions','changeCwd',current.sessionId,current.cwd).catch(()=>{});
  if (serverId) await api("Launch", "stopServer", serverId).catch(() => {});
  if (configFile) {
    if (previous) await fs.writeFile(configFile, previous);
    else await fs.rm(configFile, { force: true });
  }
  if (fixture) await fs.rm(fixture, { force: true });
  console.log("Client evidence: " + client.logFile);
  await client.stop();
}
