/** Create one disposable file in the test profile's isolated Code workspace. */
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
const name = `claudex-e2e-${randomUUID()}.txt`;
const multiName = `claudex-e2e-multi-${randomUUID()}.txt`;
let id, workspace, deleted = false;
const forbidden = await mkdtemp(path.join(os.tmpdir(), "claudex-search-forbidden-"));
await writeFile(path.join(forbidden, "private.txt"), "FORBIDDEN_SEARCH_MARKER\n");
try {
  const message = `Use your file editing tool to create ${name} in the current working directory containing exactly CODE_FILE_E2E and a newline. Do not run shell commands or modify any other file.`;
  id = await page.eval(`window['claude.web'].LocalSessions.start({cwd:'',message:${JSON.stringify(message)},permissionMode:'acceptEdits',thinkingSummariesWanted:false}).then(r => r.sessionId)`);
  workspace = await page.eval(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.cwd)`);
  if (!workspace || !path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) || !/[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)) throw Error("The Code workspace is not isolated in the test profile.");
  const protectedKind = await page.eval(`window['claude.web'].LocalSessions.classifyTccFolderKind(${JSON.stringify(path.join(os.homedir(), "Desktop", "test"))})`);
  if (protectedKind !== "desktop") throw Error("The desktop protected-folder classification is incorrect.");
  let content;
  for (let i = 0; i < 120; i++) {
    try { content = await readFile(path.join(workspace, name), "utf8"); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (content !== "CODE_FILE_E2E\n") throw Error("The test file did not contain the expected content.");
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 120000, 1000);
  const searches = await page.eval(`(async()=>{const r=window['claude.web'].Resources;await r.setFocusedCwd(${JSON.stringify(workspace)});const own=await r.searchFileContents('CODE_FILE_E2E',20);await r.setFocusedCwd(${JSON.stringify(forbidden)});const blocked=await r.searchFileContents('FORBIDDEN_SEARCH_MARKER',20);await r.setFocusedCwd(${JSON.stringify(workspace)});return {own:own.some(x=>x.relativePath===${JSON.stringify(name)}),blocked:blocked.length};})()`);
  if (!searches.own || searches.blocked !== 0) throw Error(`Folder search authorization failed: ${JSON.stringify(searches)}`);
  let rows;
  try { rows = await page.eval(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages)`); }
  catch (error) {
    const shapes = client.logSince(0).filter((line) => line.includes("test file record shapes")).slice(-1);
    throw Error(`The file transcript could not be read: ${error.message}; ${shapes.join("")}`);
  }
  if (!rows.some((r) => r.toolUseResult?.filePath?.endsWith(name) && r.toolUseResult?.content === "CODE_FILE_E2E\n")) throw Error("The created file was not preserved in the transcript.");
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(name)})`, 30000);
  const edit = `Use your file editing tool to change the content of ${name} to exactly CODE_FILE_E2E_UPDATED and a newline. Do not run shell commands or modify any other file.`;
  await page.eval(`window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(id)}, ${JSON.stringify(edit)})`);
  let changed;
  for (let i = 0; i < 120; i++) {
    changed = await readFile(path.join(workspace, name), "utf8");
    if (changed === "CODE_FILE_E2E_UPDATED\n") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (changed !== "CODE_FILE_E2E_UPDATED\n") throw Error("The test file was not updated as requested.");
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 120000, 1000);
  const editedRows = await page.eval(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages)`);
  if (!editedRows.some((r) => r.toolUseResult?.filePath?.endsWith(name) && r.toolUseResult?.claudexReconstructedFromPatch && r.toolUseResult?.claudexOriginalDiff.includes("CODE_FILE_E2E_UPDATED"))) throw Error("The file edit was not preserved in the transcript.");
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(name)})`, 30000);
  const lines = ["FIRST_BEFORE", ...Array.from({ length: 30 }, (_, i) => `unchanged-${i}`), "LAST_BEFORE"];
  await writeFile(path.join(workspace, multiName), `${lines.join("\n")}\n`);
  const multiPrompt = `Use your file editing tool in one patch to change FIRST_BEFORE to FIRST_AFTER and LAST_BEFORE to LAST_AFTER in ${multiName}. Keep every other line unchanged. Do not run shell commands or modify other files.`;
  await page.eval(`window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(id)}, ${JSON.stringify(multiPrompt)})`);
  let multiContent = "";
  for (let i = 0; i < 120; i++) {
    multiContent = await readFile(path.join(workspace, multiName), "utf8");
    if (multiContent.startsWith("FIRST_AFTER\n") && multiContent.endsWith("LAST_AFTER\n")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const expected = ["FIRST_AFTER", ...lines.slice(1, -1), "LAST_AFTER"].join("\n") + "\n";
  if (multiContent !== expected) throw Error("The multi-hunk test file was not edited as requested.");
  await page.waitFor(`window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`, 120000, 1000);
  const multiRows = await page.eval(`window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},100).then(t => t.messages)`);
  if (!multiRows.some((r) => r.toolUseResult?.filePath?.endsWith(multiName) && r.toolUseResult?.structuredPatch?.length === 2))
    throw Error("The real multi-hunk edit was not preserved as two transcript hunks.");
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(multiName)})`, 30000);
  console.log("The isolated test files were created and edited, including a two-hunk edit shown in the official Code transcript.");
} finally {
  if (id) {
    await page.eval(`window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(() => {})`).catch(() => {});
    try { await page.eval(`window['claude.web'].LocalSessions.delete(${JSON.stringify(id)})`); deleted = true; }
    catch (error) { console.error(`Test session cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  await client.stop();
  if (deleted && workspace && path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) && /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)) {
    await rm(path.join(workspace, name), { force: true });
    await rm(path.join(workspace, multiName), { force: true });
    await rmdir(workspace).catch(() => {});
  }
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
  await rm(forbidden, { recursive: true, force: true });
}
