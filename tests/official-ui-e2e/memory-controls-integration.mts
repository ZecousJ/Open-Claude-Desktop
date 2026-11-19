/** Official renderer + real adapter/service/file persistence. Only memory HTTP
 * calls are pointed at an isolated store. This is a UI integration test, not
 * evidence of production deployment, remote-account E2E or a real model reply. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
// @ts-expect-error Existing JavaScript E2E harness has no declaration file.
import { Client } from "./harness.mjs";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { MemoryService } from "../../electron/memory/service";
import { MemorySynthesizer } from "../../electron/memory/synthesizer";
import { memoryRoute } from "../../electron/official-ui/api/memory";
import { openPolicy } from "../../shared/client-policy";
import { scopeOf } from "../../electron/memory/types";
import type { MemoryScopeRef } from "../../shared/memory-api";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-memory-ui-"));
const store = new LocalMemoryStore(root);
const memory = new MemoryService({
  store,
  policy: () => openPolicy,
  changed() {},
});
await memory.setPrefs({ generate: true, searchChats: true });
await memory.saveDoc("global", "## Work context\nUI integration original", 0);
await memory.addEdit("global", "Seeded preference");
let calls = 0;
let conflictOnNextSave = false;
let failNextSynthesis = false;
const synth = new MemorySynthesizer({
  root,
  service: memory,
  conversations: () => [],
  complete: async () => {
    if (failNextSynthesis) {
      failNextSynthesis = false;
      throw new Error("Deliberate model outage");
    }
    calls++;
    return `## Work context\nUI integration regenerated ${calls}`;
  },
});
const requests: { method: string; path: string; status: number }[] = [];
const server = http.createServer(async (req, res) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    String(req.headers.origin ?? "*"),
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    String(req.headers["access-control-request-headers"] ?? "content-type"),
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url!, "http://localhost");
  res.once("finish", () =>
    requests.push({
      method: req.method!,
      path: url.pathname,
      status: res.statusCode,
    }),
  );
  try {
    const handled = await memoryRoute(req, res, url.pathname, url, {
      snapshot: async () => ({ projects: [] }),
      async call(name: string, ...args: unknown[]) {
        const scope = () => scopeOf(args[0] as MemoryScopeRef)!;
        if (name === "memoryStatus") return memory.status();
        if (name === "memoryControlsState") {
          await memory.refresh();
          return {
            doc: memory.docView(scope()),
            version: memory.controlsVersion(scope()),
          };
        }
        if (name === "replaceMemoryControls") {
          if (conflictOnNextSave) {
            conflictOnNextSave = false;
            await memory.addEdit(scope(), "Concurrent window preference");
          }
          return memory.replaceControls(
            scope(),
            args[1] as string[],
            args[2] as string,
          );
        }
        if (name === "synthesizeMemory") {
          const result = await synth.regenerate(scope());
          if (result.status !== "done") throw new Error(result.message);
          return memory.docView(scope());
        }
        throw new Error(`Unexpected call: ${name}`);
      },
    } as never);
    if (!handled) res.writeHead(501).end();
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// Install the isolated HTTP boundary before the official modules capture fetch
// or cache bootstrap. Production account preferences remain untouched.
const preload = path.join(root, "memory-preload.cjs");
fs.writeFileSync(
  preload,
  `const {contextBridge}=require('electron');
contextBridge.executeInMainWorld({args:[${JSON.stringify(origin)}],func:(origin)=>{
 const original=window.fetch.bind(window);window.__memoryCalls=[];window.__memoryErrors=[];
 window.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:input,location.origin);
  if(url.pathname.startsWith('/api/organizations/')&&url.pathname.includes('/memory')){window.__memoryCalls.push(url.pathname);return original(origin+url.pathname+url.search,{...init,credentials:'omit',mode:'cors'}).catch(e=>{window.__memoryErrors.push(e.message);throw e;});}
  const response=await original(input,init);
  if(url.pathname.includes('/bootstrap')&&response.ok&&response.headers.get('content-type')?.includes('json')){
   const data=await response.json();
   if(data.account){
    Object.assign(data.account.settings,{enabled_saffron:true,enabled_saffron_search:true,enabled_melange:false});
    Object.assign(data,{memory_mode:'classic',classic_mode_available:true,melange_available:false});
   }
   return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});
  }
  return response;
 };
}});`,
);
const starter = path.join(root, "memory-main.cjs");
fs.writeFileSync(
  starter,
  `const {app,session}=require('electron');
app.whenReady().then(()=>session.fromPartition('persist:official-ui').registerPreloadScript({type:'frame',filePath:${JSON.stringify(preload)}}));
import(${JSON.stringify(new URL("../../dist-electron/main.js", import.meta.url).href)});`,
);
const client = await Client.launch({ entrypoint: starter });
const page = client.page(0);
try {
  await page.goto("/new");
  await page.eval("__e2e.chatMode()");
  await page.eval("(location.hash='#settings/memory',true)");
  await page.waitFor(
    "document.body.innerText.includes('UI integration original')",
    30000,
  );
  console.log(
    "PASS: official memory page displays the actual isolated document.",
  );
  await page.eval("__e2e.clickLabel('Edit')");
  const input = 'input[aria-label="Tell Claudex what to remember or forget"]';
  await page.waitFor(`!!document.querySelector(${JSON.stringify(input)})`);
  await page.eval(
    `(() => { const e=document.querySelector(${JSON.stringify(input)}); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(e,'Use metric units'); e.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`,
  );
  await page.waitFor("!!__e2e.byLabel('Submit').find(e=>!e.disabled)");
  await page.eval("__e2e.clickLabel('Submit')");
  await page.waitFor(
    "document.body.innerText.includes('UI integration regenerated 1')",
    30000,
  );
  assert.deepEqual(
    memory.docView("global")!.edits.map((e) => e.text),
    ["Seeded preference", "Use metric units"],
  );
  assert.equal(calls, 1);
  console.log(
    "PASS: official input saves the complete controls list and automatically regenerates memory.",
  );
  await page.eval("__e2e.clickLabel('Edit')");
  const manage = await page.eval("!!__e2e.byText('Manage edits')[0]");
  if (manage) await page.eval("__e2e.clickText('Manage edits')");
  await page.waitFor("!!__e2e.byLabel('Remove edit')[0]");
  await page.eval("__e2e.clickLabel('Remove edit')");
  // The settings panel saves individual deletion immediately; the modal
  // variant keeps a Save changes button. Exercise whichever source offers.
  const save = await page.eval(
    "__e2e.byText('Save changes')[0] ? true : false",
  );
  if (save) await page.eval("__e2e.clickText('Save changes')");
  await page.waitFor(
    "document.body.innerText.includes('UI integration regenerated 2')",
    30000,
  );
  assert.deepEqual(
    memory.docView("global")!.edits.map((e) => e.text),
    ["Use metric units"],
  );
  console.log(
    "PASS: official delete saves and regenerates; the stored list contains only the remaining edit.",
  );
  assert.deepEqual(
    new LocalMemoryStore(root).current().edits.map((e) => e.text),
    ["Use metric units"],
  );
  assert.equal(
    requests.filter(
      (r) =>
        r.path.endsWith("/controls") && r.method === "PUT" && r.status === 200,
    ).length,
    2,
  );
  assert.equal(
    requests.filter(
      (r) =>
        r.path.endsWith("/synthesize") &&
        r.method === "POST" &&
        r.status === 200,
    ).length,
    2,
  );
  // Reopen the dialog, then let another window save between read and write.
  await page.goto("/new");
  await page.eval("(location.hash='#settings/memory',true)");
  await page.waitFor(
    "document.body.innerText.includes('UI integration regenerated 2')",
  );
  await page.eval("__e2e.clickLabel('Edit')");
  await page.waitFor(`!!document.querySelector(${JSON.stringify(input)})`);
  conflictOnNextSave = true;
  await page.eval(
    `(() => {const e=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Added after conflict');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
  await page.waitFor("!!__e2e.byLabel('Submit').find(e=>!e.disabled)");
  await page.eval("__e2e.clickLabel('Submit')");
  await page.waitFor(
    "document.body.innerText.includes('UI integration regenerated 3')",
    30000,
  );
  assert.deepEqual(
    memory.docView("global")!.edits.map((e) => e.text),
    [
      "Use metric units",
      "Concurrent window preference",
      "Added after conflict",
    ],
  );
  assert.equal(
    requests.filter((r) => r.path.endsWith("/controls") && r.status === 409)
      .length,
    1,
  );
  console.log(
    "PASS: official conflict handler rereads and merges the concurrent edit before one retry; no edit is lost.",
  );
  // The controls save can succeed while regeneration fails. The page must
  // report failure and retain the previous synthesized document.
  await page.eval("__e2e.clickLabel('Edit')");
  await page.waitFor(`!!document.querySelector(${JSON.stringify(input)})`);
  failNextSynthesis = true;
  await page.eval(
    `(() => {const e=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Keep old document on error');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
  await page.waitFor("!!__e2e.byLabel('Submit').find(e=>!e.disabled)");
  await page.eval("__e2e.clickLabel('Submit')");
  await page.waitFor(
    "document.body.innerText.includes('Couldn’t regenerate memory right now')",
    30000,
  );
  assert.equal(
    memory.docView("global")!.content,
    "## Work context\nUI integration regenerated 3",
  );
  assert.equal(
    memory.docView("global")!.edits.at(-1)!.text,
    "Keep old document on error",
  );
  assert.ok(
    requests.some((r) => r.path.endsWith("/synthesize") && r.status >= 400),
  );
  console.log(
    "PASS: official regeneration error is visible and the previous document survives.",
  );
} catch (error) {
  console.error(
    "Memory diagnostics:",
    await page
      .eval("({calls:window.__memoryCalls,errors:window.__memoryErrors})")
      .catch(() => null),
  );
  console.error(
    "UI state:",
    await page
      .eval(
        "document.querySelector('[role=dialog]')?.innerText.slice(-4000) ?? 'unavailable'",
      )
      .catch(() => "unavailable"),
  );
  throw error;
} finally {
  console.log("Client evidence:", client.logFile);
  console.log("Memory requests:", JSON.stringify(requests));
  await client.stop();
  synth.stop();
  memory.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
