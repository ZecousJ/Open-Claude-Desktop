/** Restarts only Claudex Test, then exercises the recovered official queue. */
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile, sleep } from "./harness.mjs";

let client = await Client.launch();
let page = client.page(0);
const logs = [path.dirname(client.logFile)];
let id,
  workspace,
  deleted = false;
const api = (method, ...args) =>
  page.eval(
    `window['claude.web'].LocalSessions[${JSON.stringify(method)}](${[id, ...args].map((v) => JSON.stringify(v)).join(",")})`,
  );
try {
  id = await page.eval(
    `window['claude.web'].LocalSessions.start({cwd:'',message:'For a manual approval test, request escalated permissions to run exactly printf CODE_QUEUE_RESTART_BASE. Do not run any other command.',permissionMode:'default',thinkingSummariesWanted:false}).then(r => r.sessionId)`,
  );
  workspace = (await api("getSession"))?.cwd;
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.pendingToolPermissions?.length > 0)`,
    90000,
    1000,
  );
  await api(
    "sendMessage",
    "CODE_RESTART_CANCEL_ME",
    [],
    [],
    [],
    "later",
    {},
    "restart-cancel",
  );
  await api(
    "sendMessage",
    "Only reply with CODE_QUEUE_RESTART_OK. Do not run commands or edit files.",
    [],
    [],
    [],
    "later",
    {},
    "restart-next",
  );
  await client.stop();
  client = await Client.launch();
  logs.push(path.dirname(client.logFile));
  page = client.page(0);
  await page.goto(`/epitaxy/${id}`);
  const rows = (await api("getTranscriptTail", 50)).messages;
  const queued = rows.filter((row) =>
    ["restart-cancel", "restart-next"].includes(row.uuid),
  );
  if (queued.length !== 2 || queued.some((row) => row.priority !== "later"))
    throw Error("The queue did not survive the client restart.");
  await page.waitFor(
    "document.body.innerText.includes('2 messages queued')",
    30000,
    500,
  );
  await page.eval(
    `(() => { const button=[...document.querySelectorAll('button')].find(b=>__e2e.visible(b)&&b.innerText.includes('2 messages queued')); if (!button) throw Error('Queue disclosure is missing'); button.click(); })()`,
  );
  await page.waitFor(
    "document.body.innerText.includes('CODE_RESTART_CANCEL_ME') && document.body.innerText.includes('CODE_QUEUE_RESTART_OK')",
    30000,
    500,
  );
  console.log("The restarted official page restored both queued inputs.");
  await sleep(1100);
  await page.click('button[aria-label="Queued message actions"]');
  await page.eval("__e2e.clickMenu('Remove from queue')");
  await page.waitFor(
    `window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => !t.messages.some(r => r.uuid === 'restart-cancel'))`,
    30000,
    500,
  );
  // After an interrupted turn the official UI offers recovery through the
  // composer, rather than the mid-turn Send now action.
  await page.click('button[aria-label="Edit in composer"]');
  await page.waitFor(
    "[...document.querySelectorAll('[contenteditable=true]')].some(e=>e.innerText.includes('CODE_QUEUE_RESTART_OK'))",
    30000,
    500,
  );
  await page.click('button[aria-label="Send"]');
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`,
    120000,
    1000,
  );
  await page.waitFor(
    `window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message.content).includes('CODE_QUEUE_RESTART_OK')))`,
    120000,
    1000,
  );
  await page.waitFor(
    "(document.body.innerText.match(/CODE_QUEUE_RESTART_OK/g)||[]).length >= 2",
    30000,
    500,
  );
  await page.goto(`/epitaxy/${id}`);
  const final = (await api("getTranscriptTail", 50)).messages;
  if (
    final.filter(
      (row) =>
        row.type === "user" &&
        JSON.stringify(row.message?.content).includes("CODE_QUEUE_RESTART_OK"),
    ).length !== 1 ||
    final.some((row) =>
      JSON.stringify(row.message?.content).includes("CODE_RESTART_CANCEL_ME"),
    )
  )
    throw Error(
      "Recovered input was duplicated or a cancelled input reached the model.",
    );
  console.log(
    "Queue recovery, UI cancellation, composer recovery, real sending and duplicate-free history passed.",
  );
} catch (error) {
  const controls = await page
    .eval(
      `({buttons:[...document.querySelectorAll('button')].filter(b=>__e2e.visible(b)).map(b=>({label:b.getAttribute('aria-label'),text:b.innerText.trim().slice(0,60)}))})`,
    )
    .catch(() => null);
  console.error("Recovered queue controls:", JSON.stringify(controls));
  throw error;
} finally {
  if (id) {
    await api("stop").catch(() => {});
    try {
      await api("delete");
      deleted = true;
    } catch (error) {
      console.error(`Test session cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  await client.stop();
  if (
    deleted &&
    workspace &&
    path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) &&
    /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)
  )
    await rmdir(workspace).catch(() => {});
  for (const directory of logs)
    await rm(directory, { recursive: true, force: true });
}
