/** Real desktop/native IPC/official UI against a disposable Git session. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
let id,
  cwd,
  deleted = false;
const file = "official-git-e2e.txt";
try {
  id = await page.eval(
    `window['claude.web'].LocalSessions.start({cwd:'',message:'Reply exactly GIT_E2E_READY. Do not use tools.',permissionMode:'default'}).then(s=>s.sessionId)`,
  );
  cwd = await page.eval(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s.cwd)`,
  );
  if (
    !path.resolve(cwd).startsWith(path.resolve(profile) + path.sep) ||
    !/[\\/]sessions[\\/][a-f0-9-]{36}$/.test(cwd)
  )
    throw Error("Test workspace is not isolated.");
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s && !s.turnRunning)`,
    120000,
    1000,
  );
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  await writeFile(path.join(cwd, file), "GIT_BEFORE\n");
  git("add", file);
  git("commit", "-m", "Git UI test base");
  git("checkout", "-b", "e2e-git-live");
  await writeFile(path.join(cwd, file), "GIT_AFTER\n");
  const result = await page.eval(
    `(async()=>{const a=window['claude.web'];const cwd=${JSON.stringify(cwd)};const id=${JSON.stringify(id)};const state=await a.GitState.getGitStateSnapshot([cwd]);const info=await a.LocalSessions.getGitInfo(cwd);const changes=await a.LocalSessions.getUncommittedChanges(id);const diff=await a.LocalSessions.getGitDiff(cwd,'main');return {state,info,changes,diff};})()`,
  );
  assert.equal(result.state[0].branch, "e2e-git-live");
  assert.equal(result.info.branch, "e2e-git-live");
  assert.equal(result.changes, null);
  assert.equal(result.diff.files[0].additions, 1);
  assert.equal(result.diff.files[0].deletions, 1);
  assert.match(result.diff.files[0].patch, /GIT_AFTER/);
  assert.equal(
    await page.eval(
      `window['claude.web'].LocalSessions.getWorkingTreeDirtyState(${JSON.stringify(cwd)})`,
    ),
    "dirty",
  );
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(`document.body.innerText.includes('e2e-git-live')`, 30000);
  console.log(
    "Real desktop IPC: branch, worktree scope, diff line counts and patch passed; official session page shows the actual branch.",
  );
  // Native pointer click on the official changes toggle, with no React/state patching.
  const controls = await page.eval(
    `Array.from(document.querySelectorAll('button')).map(b=>({text:(b.innerText||'').trim(),aria:b.getAttribute('aria-label'),title:b.getAttribute('title')})).filter(b=>/diff|change|review/i.test([b.text,b.aria,b.title].join(' ')))`,
  );
  console.log("Official changes controls:", JSON.stringify(controls));
  const toggle = await page.eval(
    `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>/^(Show|Open|Toggle|View) (changes|diff)|^Changes$/i.test((b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'').trim()));if(!b)return null;b.setAttribute('data-git-e2e-toggle','');return true})()`,
  );
  if (!toggle) throw Error("No official changes panel toggle found.");
  await page.click("[data-git-e2e-toggle]");
  await page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(file)})`,
    30000,
  );
  console.log("Official changes panel displays the real modified file.");
  const fileRow = await page.eval(
    `(()=>{const candidates=Array.from(document.querySelectorAll('button[aria-expanded=false]')).filter(e=>e.innerText.includes(${JSON.stringify(file)}));const e=candidates.sort((a,b)=>a.innerText.length-b.innerText.length)[0];if(!e)return false;e.setAttribute('data-git-e2e-file','');return true})()`,
  );
  if (fileRow) await page.click("[data-git-e2e-file]");
  // The official diff renderer uses a shadow root, outside body.innerText.
  await page.waitFor(
    `Array.from(document.querySelectorAll('diffs-container')).some(e=>e.shadowRoot?.textContent.includes('GIT_AFTER') && e.shadowRoot?.textContent.includes('GIT_BEFORE'))`,
    30000,
  );
  console.log(
    "Official expanded diff displays both before and after lines in its shadow renderer.",
  );
  await page.eval(
    `(()=>{window.__gitEvents=[];window['claude.web'].GitState.onGitStateChanged((changed,removed)=>window.__gitEvents.push({changed,removed}));return true})()`,
  );
  git("checkout", "-b", "e2e-git-updated");
  await page.waitFor(
    `window.__gitEvents.some(e=>e.changed.some(r=>r.branch==='e2e-git-updated'))`,
    15000,
  );
  console.log("Native live branch event received by official preload.");
  // The official Changes repository query refreshes on window focus/reopen;
  // GitState's separate live store does not invalidate that query.
  // This unfocusable test client verifies the supported reopen path explicitly.
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(
    `document.body.innerText.includes('e2e-git-updated')`,
    15000,
  );
  assert.equal(await readFile(path.join(cwd, file), "utf8"), "GIT_AFTER\n");
  console.log(
    "Official UI: expanded file diff and branch change after reopening passed. No production repository was modified.",
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "macOS source build; real native IPC, live GitState event, official Code changes UI and reopened branch; foreground focus refresh not tested",
    }),
  );
} catch (error) {
  console.error(error.message.replace(/cookie\s+\S+/g, "cookie [redacted]"));
  process.exitCode = 1;
} finally {
  try {
    if (id) {
      await page
        .eval(
          `window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(()=>{})`,
        )
        .catch(() => {});
      await page.eval(
        `window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`,
      );
      deleted = true;
    }
  } finally {
    await client.stop();
    if (
      deleted &&
      cwd &&
      path.resolve(cwd).startsWith(path.resolve(profile) + path.sep) &&
      /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(cwd)
    ) {
      await rm(path.join(cwd, ".git"), { recursive: true, force: true });
      await rm(path.join(cwd, file), { force: true });
      await rmdir(cwd).catch(() => {});
    }
    await rm(path.dirname(client.logFile), { recursive: true, force: true });
  }
}
