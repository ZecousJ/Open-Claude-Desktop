/** Existing test-account session, real directory/text UI and native HTML Browser. */
import assert from "node:assert/strict";
import { writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { Client, profile } from "./harness.mjs";

let client = await Client.launch(),
  page = client.page(0);
let folder;
const basename = `panel-e2e-${randomUUID()}`;
const textName = `${basename}.txt`,
  htmlName = `${basename}.html`;
const addedName = `${basename}-added.txt`;
const web = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<h1>${req.url === "/two" ? "PANEL_NAV_TWO" : "PANEL_NAV_ONE"}</h1>`);
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const webUrl = `http://127.0.0.1:${web.address().port}`;
try {
  const sessions = await page.eval(
    `window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions)`,
  );
  let current;
  for (const s of sessions.filter(
    (s) => !s.isArchived && !s.turnRunning && s.cwd,
  )) {
    if (!path.resolve(s.cwd).startsWith(path.resolve(profile) + path.sep))
      continue;
    try {
      await access(s.cwd);
      current = s;
      break;
    } catch {}
  }
  assert.ok(current, "An existing idle test-profile workspace is required.");
  const id = current.sessionId;
  folder = current.cwd;
  await writeFile(path.join(folder, textName), "PANEL_TEXT_BODY\n");
  await writeFile(
    path.join(folder, htmlName),
    "<!doctype html><html><head><title>Panel preview test</title></head><body><h1>PANEL_HTML_BODY</h1><p>Real sandboxed browser</p></body></html>",
  );
  const args = `${JSON.stringify(id)},${JSON.stringify(folder)}`;
  const data = await page.eval(
    `(async()=>{const s=window['claude.web'].LocalSessions;const id=${JSON.stringify(id)},cwd=${JSON.stringify(folder)};return {entries:await s.listSessionDirectory(id,cwd),file:await s.readSessionFileWithStatus(id,${JSON.stringify(textName)}),missing:await s.readSessionFileWithStatus(id,'not-a-real-file.txt')};})()`,
  );
  assert.ok(data.entries.some((e) => e.name === textName));
  assert.equal(data.file.status, "ok");
  assert.equal(data.file.file.contents, "PANEL_TEXT_BODY\n");
  assert.equal(data.missing.status, "notFound");
  await page.goto(`/epitaxy/${id}`);
  await page.eval(`window['claude.web'].LocalSessions.personOpenedSession(${JSON.stringify(id)})`);
  console.log("Existing local history open acknowledged without sending a model task.");
  await page.waitFor(
    `!!document.querySelector('button[aria-label="Files"]')`,
    30000,
  );
  const files = await page.eval(
    `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Files');if(!b)return false;b.setAttribute('data-panel-files','');return true})()`,
  );
  assert.ok(files, "Official Files panel button must exist");
  const pressed = await page.eval(
    `document.querySelector('[data-panel-files]').getAttribute('aria-pressed')`,
  );
  if (pressed !== "true") await page.click("[data-panel-files]");
  const tree = await page.waitFor(
    `(()=>{if(document.body.innerText.includes(${JSON.stringify(textName)}))return 'open';const b=Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')||b.textContent).trim()==='Show file tree');if(!b)return false;b.setAttribute('data-panel-tree','');return 'closed'})()`,
    20000,
  );
  if (tree === "closed") await page.click("[data-panel-tree]");
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(textName)})`,
    20000,
  );
  const file = await page.eval(
    `(()=>{const es=Array.from(document.querySelectorAll('button,[role=treeitem]')).filter(e=>e.textContent.includes(${JSON.stringify(textName)}));const e=es.sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!e)return false;e.setAttribute('data-panel-text','');return true})()`,
  );
  assert.ok(file, "Official tree must provide a file row");
  await page.click("[data-panel-text]");
  await page.waitFor(
    `document.body.innerText.includes('PANEL_TEXT_BODY')`,
    30000,
  );
  console.log(
    "Official Files UI lists the real folder and opens the text file contents.",
  );
  await writeFile(path.join(folder, addedName), "WATCHER_BODY");
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(addedName)})`,
    15000,
  );
  const save = await page.eval(
    `(async()=>{const s=window['claude.web'].LocalSessions;const id=${JSON.stringify(id)},file=${JSON.stringify(textName)};const r=await s.readSessionFileWithStatus(id,file);return {saved:await s.writeSessionFile(id,file,'PANEL_TEXT_SAVED',r.file.hash),conflict:await s.writeSessionFile(id,file,'MUST_NOT_REPLACE',r.file.hash),read:await s.readSessionFile(id,file)}})()`,
  );
  assert.equal(save.saved.status, "ok");
  assert.equal(save.conflict.status, "conflict");
  assert.equal(save.read.contents, "PANEL_TEXT_SAVED");
  console.log(
    "Real directory watcher refresh and optimistic save conflict passed.",
  );
  await page.eval(
    `(()=>{const row=Array.from(document.querySelectorAll('[role=treeitem],button')).filter(e=>e.textContent.includes(${JSON.stringify(htmlName)})).sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!row)throw Error('HTML tree row missing');row.setAttribute('data-panel-html','')})()`,
  );
  await page.click("[data-panel-html]");
  const previewToggle = await page.waitFor(
    `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>['Preview','View source'].includes(b.getAttribute('aria-label')||b.textContent.trim()));if(!b)return null;b.setAttribute('data-panel-preview','');return b.getAttribute('aria-label')||b.textContent.trim()})()`,
  );
  if (previewToggle === "Preview") await page.click("[data-panel-preview]");
  await page.waitFor(`document.querySelectorAll('iframe').length>0`, 15000);
  console.log(
    "Files HTML preview frames:",
    JSON.stringify(
      await page.eval(
        `Array.from(document.querySelectorAll('iframe')).map(f=>({title:f.title,src:f.src,sandbox:f.sandbox.value}))`,
      ),
    ),
  );
  let renderedFrames;
  for (let attempt = 0; attempt < 40; attempt++) {
    renderedFrames = await fetch(client.origin + "/__debug/frames", {
      headers: { Cookie: client.cookie },
    }).then((r) => r.json());
    if (renderedFrames.some((f) => f.text?.includes("PANEL_HTML_BODY"))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(
    renderedFrames.some((f) => f.text?.includes("PANEL_HTML_BODY")),
    JSON.stringify({
      error: "Files HTML Preview did not render",
      frames: renderedFrames,
    }),
  );
  console.log(
    "Actual Files Preview button renders HTML through isolated official user-content renderer.",
  );
  const browserButton = await page.eval(
    `(()=>{const b=document.querySelector('button[aria-label="Browser"]');if(!b)return null;b.setAttribute('data-panel-browser','');return b.getAttribute('aria-pressed')})()`,
  );
  if (browserButton !== "true") await page.click("[data-panel-browser]");
  await page.waitFor(
    `window['claude.web'].Launch.getAllSessionPreviewTabs().then(rows=>rows.some(r=>r.serverId===${JSON.stringify("preview-" + id)}))`,
    20000,
  );
  await page.waitFor(
    `!document.body.innerText.includes('Setting up preview')`,
    20000,
  );
  const browserId = "preview-" + id;
  await page.eval(
    `window['claude.web'].Launch.navigatePreview(${JSON.stringify(browserId)},${JSON.stringify(webUrl + "/one")})`,
  );
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot(${JSON.stringify(browserId)}).then(s=>s.includes('PANEL_NAV_ONE'))`,
    20000,
  );
  await page.eval(
    `window['claude.web'].Launch.navigatePreview(${JSON.stringify(browserId)},${JSON.stringify(webUrl + "/two")})`,
  );
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot(${JSON.stringify(browserId)}).then(s=>s.includes('PANEL_NAV_TWO'))`,
    20000,
  );
  await page.eval(
    `window['claude.web'].Launch.goBack(${JSON.stringify(browserId)})`,
  );
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot(${JSON.stringify(browserId)}).then(s=>s.includes('PANEL_NAV_ONE'))`,
    20000,
  );
  await page.eval(
    `window['claude.web'].Launch.goForward(${JSON.stringify(browserId)})`,
  );
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot(${JSON.stringify(browserId)}).then(s=>s.includes('PANEL_NAV_TWO'))`,
    20000,
  );
  console.log("Official Browser toggle starts a real preview session.");
  const preview = await page.eval(
    `window['claude.web'].Launch.loadHtmlPreview(${JSON.stringify(path.join(folder, htmlName))},${args})`,
  );
  assert.ok(preview?.startsWith("html-preview-"));
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot(${JSON.stringify(preview)}).then(s=>JSON.stringify(s).includes('PANEL_HTML_BODY'))`,
    20000,
  );
  const frame = await page.eval(
    `window['claude.web'].Launch.capturePreviewScreenshot(${JSON.stringify(preview)})`,
  );
  assert.ok(
    typeof frame === "string" && !frame.startsWith("data:") && Buffer.from(frame, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && frame.length > 1000,
    "A real rendered preview must be capturable",
  );
  const initialTabs = await page.eval(
    `window['claude.web'].Launch.getPreviewTabs(${JSON.stringify(preview)})`,
  );
  assert.ok(initialTabs.tabs.some((t) => t.url.includes(htmlName)));
  assert.ok(
    initialTabs.tabs.every(
      (t) => typeof t.tabId === "string" && typeof t.origin === "string",
    ),
  );
  await page.eval(
    `window['claude.web'].Launch.showPreview(${JSON.stringify(preview)},{x:450,y:180,width:600,height:400,radius:8})`,
  );
  await page.eval(
    `window['claude.web'].Launch.hidePreview(${JSON.stringify(preview)})`,
  );
  const other = await client.openPage();
  await other.eval(
    `window['claude.web'].Launch.showPreview(${JSON.stringify(preview)},{x:100,y:100,width:700,height:450})`,
  );
  await other.eval(
    `window['claude.web'].Launch.hidePreview(${JSON.stringify(preview)})`,
  );
  console.log(
    "Real sandboxed HTML browser: DOM snapshot, pixels, tabs, show/hide and second-window attachment passed.",
  );
  await client.stop();
  const previousLog = client.logFile;
  client = await Client.launch();
  await rm(path.dirname(previousLog), { recursive: true, force: true });
  page = client.page(0);
  await page.eval(
    `window['claude.web'].Launch.getPreviewTabs(${JSON.stringify(preview)})`,
  );
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot(${JSON.stringify(preview)}).then(s=>s.includes('PANEL_HTML_BODY'))`,
    20000,
  );
  assert.equal(
    await page.eval(
      `window['claude.web'].Launch.stopServer(${JSON.stringify(preview)})`,
    ),
    true,
  );
  const stopped = await page.eval(
    `window['claude.web'].Launch.getPreviewTabs(${JSON.stringify(preview)})`,
  );
  assert.equal(stopped.tabs.length, 0);
  console.log(
    "Full client restart restores HTML preview; stop tears down the preview session.",
  );
  const gaps = client
    .gapsSince(0)
    .filter((line) => /Launch|File|Directory/.test(line));
  assert.deepEqual(
    gaps,
    [],
    "No missing adapters may remain in the tested panel path",
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "macOS source/packaged native file IPC, real official directory+text-file UI, actual HTML browser rendering and two-window show/hide; existing test session, no model messages",
    }),
  );
} catch (error) {
  console.error(String(error));
  console.error(
    JSON.stringify({
      body: await page
        .eval(`document.body.innerText.slice(-7000)`)
        .catch(() => null),
      gaps: client.gapsSince(0).slice(-12),
      previewCalls: [
        ...new Set(
          client.logSince(0).filter((l) => l.includes("preview trace")),
        ),
      ].slice(-40),
      previewGates: await page
        .eval(
          `import('/assets/v1/shared-l-p-m-w-3-B5uNmf7O.js').then(m=>({enabled:m.sp(),restricted:m.A3.getState().restricted,resolution:m.fI.getState().resolution}))`,
        )
        .catch(() => null),
      previewComponents: await page
        .eval(
          `(()=>{const e=Array.from(document.querySelectorAll('*')).find(e=>e.childNodes.length===1&&e.textContent==='Setting up preview');if(!e)return [];let f=e[Object.keys(e).find(k=>k.startsWith('__reactFiber'))],out=[];while(f){if(typeof f.type==='function'){const data=f.updateQueue?.memoCache?.data;const flags=data?.filter(a=>a.includes('4112513247')).map(a=>a.map(v=>v&&typeof v==='object'?{on:v.on,value:v.value,source:v.source,feature:v.growthbook?.getFeatures?.()['4112513247']}:typeof v==='symbol'?null:v));if(flags?.length)out.push({name:f.type.name,flags});}f=f.return}return out})()`,
        )
        .catch(() => null),
    }),
  );
  process.exitCode = 1;
} finally {
  await client.stop();
  if (folder) {
    await rm(path.join(folder, textName), { force: true });
    await rm(path.join(folder, htmlName), { force: true });
    await rm(path.join(folder, addedName), { force: true });
  }
  await new Promise((resolve) => web.close(resolve));
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
