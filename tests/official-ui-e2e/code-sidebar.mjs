/** Verify official sidebar grouping without moving or merging session files. */
import assert from "node:assert/strict";
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0),
  created = [];
try {
  for (const label of ["SIDEBAR_GROUP_ONE", "SIDEBAR_GROUP_TWO"]) {
    const id = await page.eval(
      `window['claude.web'].LocalSessions.start({cwd:'',message:'Reply exactly READY. Do not use tools.',permissionMode:'default'}).then(s=>s.sessionId)`,
    );
    const s = await page.eval(
      `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)})`,
    );
    if (
      !path.resolve(s.cwd).startsWith(path.resolve(profile) + path.sep) ||
      !/[\\/]sessions[\\/][a-f0-9-]{36}$/.test(s.cwd)
    )
      throw Error("Test session is not isolated.");
    created.push({ id, cwd: s.cwd, label });
    await page.waitFor(
      `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s&&!s.turnRunning)`,
      120000,
      1000,
    );
    await page.eval(
      `window['claude.web'].LocalSessions.updateSession(${JSON.stringify(id)},{title:${JSON.stringify(label)}})`,
    );
  }
  assert.notEqual(
    created[0].cwd,
    created[1].cwd,
    "each task must retain its own files",
  );
  // A fresh page requests the persisted session list: this is also the upgrade path for history.
  await page.goto(`/epitaxy/${created[0].id}`);
  for (const s of created) {
    await page.waitFor(
      `document.querySelector('aside,[aria-label=Sidebar],.dframe-sidebar')?.innerText.includes(${JSON.stringify(s.label)})`,
      30000,
    );
    const native = await page.eval(
      `window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.find(s=>s.sessionId===${JSON.stringify(s.id)}))`,
    );
    assert.equal(native.isScratchWorkspace, true);
    assert.equal(native.cwd, s.cwd);
  }
  const groupMenu = await page.eval(
    `(()=>{const b=document.querySelector('button[aria-label="Group and sort"]');if(!b)return false;b.setAttribute('data-sidebar-e2e-group','');return true})()`,
  );
  if (!groupMenu) throw Error("Official Group and sort control is missing.");
  await page.click("[data-sidebar-e2e-group]");
  const grouping = await page.waitFor(
    `(()=>{const e=Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.innerText.startsWith('Group by'));if(!e)return false;e.setAttribute('data-sidebar-e2e-groupby','');return true})()`,
  );
  await page.click("[data-sidebar-e2e-groupby]");
  await page.eval(
    `document.querySelector('[data-sidebar-e2e-groupby]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`,
  );
  console.log(
    "Grouping options:",
    JSON.stringify(
      await page.eval(
        `Array.from(document.querySelectorAll('[role=menuitemradio],[role=menuitem]')).map(e=>({text:e.innerText,checked:e.getAttribute('aria-checked')}))`,
      ),
    ),
  );
  await page.waitFor(
    `(()=>{const e=Array.from(document.querySelectorAll('[role=menuitemradio],[role=menuitem]')).find(e=>e.innerText.replace(/[\\uE000-\\uF8FF]/g,'').trim()==='Folder');if(!e)return false;e.setAttribute('data-sidebar-e2e-folder','');return true})()`,
  );
  await page.click("[data-sidebar-e2e-folder]");
  await page.waitFor(
    `document.querySelector('aside,[aria-label=Sidebar],.dframe-sidebar')?.innerText.includes('This computer')`,
    30000,
  );
  const sidebar = await page.eval(
    `(()=>{const e=document.querySelector('aside,[aria-label=Sidebar],.dframe-sidebar');return {text:e?.innerText||'',groups:Array.from(e?.querySelectorAll('h2,h3,[role=heading],button[aria-expanded]')||[]).map(n=>n.innerText.trim())}})()`,
  );
  for (const s of created)
    assert.ok(
      !sidebar.text.includes(path.basename(s.cwd)),
      "internal workspace UUID must not be a sidebar group",
    );
  assert.ok(
    sidebar.text.includes("This computer"),
    "the official local scratch group label must be shown",
  );
  console.log(
    "Official sidebar: two persisted scratch tasks share This computer; titles remain visible, internal UUID headings absent, execution directories stay distinct.",
  );
  await page.goto(`/epitaxy/${created[1].id}`);
  await page.waitFor(
    `document.querySelector('aside,[aria-label=Sidebar],.dframe-sidebar')?.innerText.includes('This computer')`,
    30000,
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "macOS source/packaged official sidebar; persisted list/reopen; no existing session changed",
    }),
  );
} catch (error) {
  console.log(
    "Sidebar diagnostics:",
    JSON.stringify(
      await page
        .eval(
          `(()=>{const e=document.querySelector('.dframe-sidebar');return {groups:Array.from(e?.querySelectorAll('h3')||[]).map(e=>e.innerText.trim()),noFolder:e?.innerText.includes('This computer'),menu:Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).map(e=>({text:e.innerText,checked:e.getAttribute('aria-checked')}))}})()`,
        )
        .catch(() => null),
    ),
  );
  console.error(error.message.replace(/cookie\s+\S+/g, "cookie [redacted]"));
  process.exitCode = 1;
} finally {
  try {
    for (const s of created) {
      await page
        .eval(
          `window['claude.web'].LocalSessions.stop(${JSON.stringify(s.id)}).catch(()=>{})`,
        )
        .catch(() => {});
      await page.eval(
        `window['claude.web'].LocalSessions.delete(${JSON.stringify(s.id)})`,
      );
      s.deleted = true;
    }
  } finally {
    await client.stop();
    for (const s of created) if (s.deleted) await rmdir(s.cwd).catch(() => {});
    await rm(path.dirname(client.logFile), { recursive: true, force: true });
  }
}
