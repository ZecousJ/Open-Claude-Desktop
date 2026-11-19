/** Real native IPC + account-owned files in the signed-in Claudex Test profile. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
const marker = `e2e-cowork-memory-${Date.now().toString(36)}`;
const filename = `${marker}.md`;
let file;
let original;
let taskStarted = false;
let taskId;
async function openCoworkMemory() {
  if (!taskStarted) {
    await page.goto("/task/new?mode=cowork");
    await page.waitFor("location.pathname==='/new' && document.querySelector('main [contenteditable=true]')", 30000);
    await page.eval("__e2e.type('F114_NEW test memory navigation')");
    await page.waitFor(`(()=>{
      if(location.pathname.includes('/cowork/'))return true;
      const tour=[...document.querySelectorAll('[role=dialog] button')].find(b=>__e2e.visible(b)&&b.getAttribute('aria-label')==='Dismiss');
      if(tour){tour.click();return false;}
      const editor=document.querySelector('main [contenteditable=true]');
      if(!editor?.innerText.includes('F114_NEW'))return false;
      const start=[...document.querySelectorAll('main button')].find(b=>__e2e.visible(b)&&!b.disabled&&/^(Send|Send message|Start task)$/.test(b.getAttribute('aria-label')??''));
      if(start&&!start.hasAttribute('data-e2e-started')){start.setAttribute('data-e2e-started','');start.click();}
      return false;
    })()`,60000);
    taskId = await page.eval("decodeURIComponent(location.pathname.split('/').pop())");
    taskStarted = true;
  } else {
    await page.eval("[...document.querySelectorAll('[role=dialog] button[aria-label=Close]')].find(__e2e.visible)?.click()");
  }
  await page.waitFor("__e2e.visible(document.querySelector('[data-testid=user-menu-button]'))", 30000);
  await page.click('[data-testid="user-menu-button"]');
  await page.waitFor("[...document.querySelectorAll('[role=menuitem],button')].some(e=>__e2e.visible(e)&&e.innerText.includes('Settings'))");
  await page.eval("[...document.querySelectorAll('[role=menuitem],button')].find(e=>__e2e.visible(e)&&e.innerText.includes('Settings')).click()");
  await page.waitFor("[...document.querySelectorAll('[role=dialog] button')].some(e=>__e2e.visible(e)&&e.innerText.replace(/[\uE000-\uF8FF]/g,'').trim()==='Memory')");
  await page.eval("[...document.querySelectorAll('[role=dialog] button')].find(e=>__e2e.visible(e)&&e.innerText.replace(/[\uE000-\uF8FF]/g,'').trim()==='Memory').click()");
}
try {
  const account = await page.api("/api/account");
  assert.equal(account.status, 200);
  assert.match(account.body.uuid, /^[\w-]+$/);
  const directory = path.join(
    profile,
    "profiles",
    account.body.uuid,
    "cowork-memory",
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  file = path.join(directory, filename);
  fs.writeFileSync(
    file,
    "---\nname: E2E file memory\n---\nUses metric units.",
    { flag: "wx", mode: 0o600 },
  );
  original = await page.eval(
    "window['claude.web'].CoworkMemory.readGlobalMemory()",
  );
  assert.equal(
    await page.eval(
      `window['claude.web'].CoworkMemory.writeGlobalMemory(${JSON.stringify(original ?? "")})`,
    ),
    true,
  );
  const listed = await page.eval(
    "window['claude.web'].CoworkMemory.listAccountMemories(false)",
  );
  assert.ok(
    listed.some(
      (entry) => entry.path === filename && entry.content === undefined,
    ),
  );
  assert.match(
    (
      await page.eval(
        `window['claude.web'].CoworkMemory.readAccountMemory(${JSON.stringify(filename)})`,
      )
    ).content,
    /Uses metric/,
  );
  await openCoworkMemory();
  await page.waitFor(
    "document.body.innerText.includes('E2E file memory')",
    30000,
  );
  await page.eval("__e2e.clickText('E2E file memory','button,[role=button]')");
  await page.waitFor(
    "document.body.innerText.includes('Uses metric units.')",
    30000,
  );
  await page.eval("document.querySelector('[role=dialog] button[aria-label=Edit]').click()");
  const edit = "textarea[aria-label='E2E file memory']";
  await page.waitFor(`!!document.querySelector(${JSON.stringify(edit)})`);
  await page.eval(
    `(()=>{const e=document.querySelector(${JSON.stringify(edit)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify("Uses concise replies.")});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
  await page.eval("__e2e.clickText('Save')");
  await page.waitFor(
    "document.body.innerText.includes('Uses concise replies.')",
    30000,
  );
  assert.match(fs.readFileSync(file, "utf8"), /Uses concise replies/);
  await openCoworkMemory();
  await page.waitFor(
    "document.body.innerText.includes('E2E file memory')",
    30000,
  );
  await page.eval("__e2e.clickText('E2E file memory','button,[role=button]')");
  await page.waitFor(
    "document.body.innerText.includes('Uses concise replies.')",
    30000,
  );
  await page.eval("document.querySelector('[role=dialog] button[aria-label=\"More options\"]').click()");
  await page.eval("[...document.querySelectorAll('[role=menuitem]')].find(e=>__e2e.visible(e)&&e.innerText.includes('Delete')).click()");
  await page.waitFor("[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].some(e=>__e2e.visible(e)&&e.innerText.includes('Delete memory?'))");
  await page.eval("[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].find(e=>__e2e.visible(e)&&e.innerText.includes('Delete memory?')).querySelectorAll('button').forEach(b=>{if(b.innerText.trim()==='Delete')b.click()})");
  await page.waitFor("!document.body.innerText.includes('Uses concise replies.')",30000);
  assert.equal(fs.existsSync(file), false);
  if (process.env.CLAUDEX_F160_RESET_ISOLATED === "1") {
    assert.ok(process.env.CLAUDEX_E2E_PROFILE, "Reset requires an explicit isolated profile");
    assert.deepEqual(await page.eval("window['claude.web'].CoworkMemory.listAccountMemories(false)"), []);
    const resetNames = [`${marker}-reset-a.md`, `${marker}-reset-b.md`];
    for (const name of resetNames) {
      fs.writeFileSync(path.join(directory, name), "isolated reset fixture", { flag: "wx", mode: 0o600 });
    }
    if (process.env.CLAUDEX_F160_RESET_UI === "1") {
      const select = "[role=dialog] [role=combobox]";
      await page.waitFor(`!!document.querySelector(${JSON.stringify(select)})`);
      await page.click(select);
      await page.waitFor("[...document.querySelectorAll('[role=option],[role=menuitem],button')].some(e=>__e2e.visible(e)&&e.innerText.replace(/[\\uE000-\\uF8FF]/g,'').trim()==='Off')");
      await page.eval("[...document.querySelectorAll('[role=option],[role=menuitem],button')].find(e=>__e2e.visible(e)&&e.innerText.replace(/[\\uE000-\\uF8FF]/g,'').trim()==='Off').click()");
      await page.waitFor("document.body.innerText.includes('Turn off memory')");
      await page.eval("([...document.querySelectorAll('[role=radio]')].find(e=>e.innerText.includes('Reset memory')||e.closest('label')?.innerText.includes('Reset memory'))??[...document.querySelectorAll('label')].find(e=>e.innerText.trim().startsWith('Reset memory'))??[...document.querySelectorAll('[role=dialog] span')].find(e=>e.innerText.trim()==='Reset memory')).click()");
      await page.waitFor("[...document.querySelectorAll('[role=dialog] button')].some(e=>__e2e.visible(e)&&!e.disabled&&e.innerText.trim()==='Reset memory')");
      await page.eval("[...document.querySelectorAll('[role=dialog] button')].find(e=>__e2e.visible(e)&&!e.disabled&&e.innerText.trim()==='Reset memory').click()");
      await page.waitFor("(async()=>!document.body.innerText.includes('Turn off memory')&&(await window['claude.web'].CoworkMemory.listAccountMemories(false)).length===0)()",30000);
      console.log("PASS: original desktop Reset memory confirmation clears the isolated Cowork files.");
    } else {
      assert.equal(await page.eval("window['claude.web'].CoworkMemory.resetMemories()"), true);
    }
    assert.deepEqual(await page.eval("window['claude.web'].CoworkMemory.listAccountMemories(false)"), []);
    for (const name of resetNames) assert.equal(fs.existsSync(path.join(directory, name)), false);
    assert.equal(await page.eval("window['claude.web'].CoworkMemory.readGlobalMemory()"), original ?? "");
    console.log("PASS: isolated native reset removes both account files and preserves global instructions.");
  }
  console.log(
    "PASS: real CoworkMemory IPC lists/reads account file, official UI edits and saves, reopen retains content, and the confirmation deletes only the test file. Global instructions read/write unchanged; reset requires the explicitly isolated fixture.",
  );
} catch (error) {
  console.error(
    "Memory panel mode diagnostics (no personal memory content):",
    await page
      .eval(
        `(async()=>{
          const dialog=document.querySelector('[role=dialog]');
          const controls=[...document.querySelectorAll('main button,aside button,aside a,[data-testid=user-menu-button]')].filter(__e2e.visible).map(e=>e.getAttribute('aria-label')??e.innerText.replace(/[\uE000-\uF8FF]/g,'').trim()).filter(Boolean).slice(0,40);
          if(!dialog)return {route:location.pathname+location.search,dialog:false,controls};
          const module=await import('/assets/v1/shared-1-B16QIYNI.js');
          const fiber=dialog[Object.keys(dialog).find(key=>key.startsWith('__reactFiber'))];
          const modes=[];
          const visit=f=>{if(!f)return;for(let d=f.dependencies?.firstContext;d;d=d.next)if(d.context===module.Uf)modes.push(d.memoizedValue);visit(f.child);visit(f.sibling)};
          visit(fiber);
          let providers=0;for(let f=fiber;f;f=f.return)if(f.type===module.Uf||f.type?._context===module.Uf)providers++;
          return {route:location.pathname+location.search,dialog:true,controls,dialogLabels:[...dialog.querySelectorAll('h1,h2,button')].filter(__e2e.visible).map(e=>e.getAttribute('aria-label')??e.innerText.trim()).slice(0,25),memoryModeValues:[...new Set(modes)],modeProvidersAboveDialog:providers,showsClassicSummary:dialog.innerText.includes('Summary'),showsTestFile:dialog.innerText.includes('E2E file memory')};
        })()`,
      )
      .catch(() => null),
  );
  throw error;
} finally {
  try {
    if (file && path.basename(file) === filename)
      fs.rmSync(file, { force: true });
    if (taskId) {
      await page.eval(`window['claude.web'].LocalAgentModeSessions.stop(${JSON.stringify(taskId)}).catch(()=>{})`).catch(() => {});
      await page.eval(`window['claude.web'].LocalAgentModeSessions.delete(${JSON.stringify(taskId)})`).catch(error => { console.error("Cowork task cleanup failed:", error.message); process.exitCode = 1; });
    }
    await page.eval("__e2e.chatMode()").catch(() => {});
  } finally {
    console.log("Client evidence:", client.logFile);
    await client.stop();
  }
}
