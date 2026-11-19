/** Exercises queued Code messages against the official renderer and engine. */
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch();
const page = client.page(0);
let id;
let workspace;
let deleted = false;
const textIn = (row, value) =>
  JSON.stringify(row.message?.content).includes(value);
try {
  id = await page.eval(
    `window['claude.web'].LocalSessions.start({cwd:'',message:'For a manual approval test, request escalated permissions to run exactly printf CODE_QUEUE_BASE_OK. After it succeeds reply CODE_QUEUE_BASE_OK. Do not run any other command.',permissionMode:'default',thinkingSummariesWanted:false}).then(r => r.sessionId)`,
  );
  workspace = await page.eval(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.cwd)`,
  );
  await page.goto(`/epitaxy/${id}`);
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.pendingToolPermissions?.length > 0)`,
    90000,
    250,
  );
  const permission = await page.eval(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s=>s?.pendingToolPermissions?.[0]??null)`,
  );
  const command = permission?.input?.command;
  if (
    command !== "printf CODE_QUEUE_BASE_OK" &&
    command !== "/bin/zsh -lc 'printf CODE_QUEUE_BASE_OK'"
  )
    throw Error("The queue test requested an unexpected command.");
  await page.eval(
    `(() => { window.__queueEvents = []; window['claude.web'].LocalSessions.onOnEvent(event => { if (event.sessionId === ${JSON.stringify(id)}) window.__queueEvents.push(event); }); })()`,
  );

  const send = (message, uuid) =>
    page.eval(
      `window['claude.web'].LocalSessions.sendMessage(${JSON.stringify(id)},${JSON.stringify(message)},[],[],[],'later',{},${JSON.stringify(uuid)})`,
    );

  await send("CODE_QUEUE_CANCEL_ME", "code-queue-cancel");
  await page.waitFor(
    "window.__queueEvents.some(event => event.type === 'message' && event.message?.uuid === 'code-queue-cancel')",
    30000,
    250,
  );
  const cancelled = await page.eval(
    `window['claude.web'].LocalSessions.cancelQueuedMessage(${JSON.stringify(id)},'code-queue-cancel')`,
  );
  if (!cancelled) {
    const state = await page.eval(
      `(async () => ({ session: await window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}), transcript: (await window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50)).messages.map(m => ({uuid:m.uuid,type:m.type,content:m.message?.content})) }))()`,
    );
    throw Error(
      `The queued message could not be cancelled: ${JSON.stringify({ turnRunning: state.session?.turnRunning, rows: state.transcript.slice(-5) })}`,
    );
  }
  await page.waitFor(
    "window.__queueEvents.some(event => event.type === 'held_input_withdrawn' && event.withdrawnUuids?.includes('code-queue-cancel'))",
    30000,
    500,
  );

  await send(
    "After the pending command finishes, reply with CODE_QUEUE_NEXT_OK and do not run commands.",
    "code-queue-next",
  );
  await page.waitFor(
    "window.__queueEvents.some(event => event.type === 'message' && event.message?.uuid === 'code-queue-next')",
    30000,
    250,
  );
  await page.eval(
    `window['claude.web'].LocalSessions.respondToToolPermission(${JSON.stringify(permission.requestId)},'once')`,
  );

  await page.waitFor(
    `window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message?.content).includes('CODE_QUEUE_BASE_OK')))`,
    120000,
    1000,
  );
  await page.waitFor(
    `window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50).then(t => t.messages.some(r => r.type === 'assistant' && JSON.stringify(r.message?.content).includes('CODE_QUEUE_NEXT_OK')))`,
    120000,
    1000,
  );
  await page.waitFor(
    "document.body.innerText.includes('CODE_QUEUE_NEXT_OK')",
    30000,
    500,
  );
  await page.waitFor(
    `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`,
    120000,
    1000,
  );
  const transcript = await page.eval(
    `window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50)`,
  );
  if (
    !transcript.messages.some(
      (row) => row.type === "assistant" && textIn(row, "CODE_QUEUE_BASE_OK"),
    )
  )
    throw Error("The initial turn did not finish before the queued reply.");
  if (
    !transcript.messages.some(
      (row) => row.type === "assistant" && textIn(row, "CODE_QUEUE_NEXT_OK"),
    )
  )
    throw Error("The queued message did not receive its reply.");
  console.log(
    "A queued Code message appeared, cancellation removed it, and the next queued message ran after the active turn.",
  );
} catch (error) {
  const state = id
    ? await page
        .eval(
          `(async()=>{const s=await window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)});const t=await window['claude.web'].LocalSessions.getTranscriptTail(${JSON.stringify(id)},50);return {running:s?.turnRunning,permissions:s?.pendingToolPermissions?.map(p=>({command:p.input?.command})),rows:t.messages.map(r=>({type:r.type,content:r.message?.content})).slice(-7)}})()`,
        )
        .catch(() => null)
    : null;
  console.error("Code queue outcome:", JSON.stringify(state));
  throw error;
} finally {
  if (id) {
    const isRunning = await page
      .eval(
        `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s?.turnRunning)`,
      )
      .catch(() => false);
    if (isRunning) {
      await page
        .eval(
          `window['claude.web'].LocalSessions.stop(${JSON.stringify(id)}).catch(() => {})`,
        )
        .catch(() => {});
      await page
        .waitFor(
          `window['claude.web'].LocalSessions.getSession(${JSON.stringify(id)}).then(s => s && !s.turnRunning)`,
          30000,
          500,
        )
        .catch(() => {});
    }
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
  await client.stop();
  if (
    deleted &&
    workspace &&
    path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) &&
    /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)
  ) {
    try {
      await rmdir(workspace);
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error(`The test workspace was retained: ${workspace}`);
    }
  }
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
