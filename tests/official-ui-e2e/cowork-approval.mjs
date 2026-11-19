/** A real Cowork permission card; its command is either read-only or denied. */
import { access, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, profile } from "./harness.mjs";

const client = await Client.launch(),
  page = client.page(0);
const deny = process.env.COWORK_APPROVAL_DECISION === "deny";
const target = path.join(
  os.tmpdir(),
  `claudex-cowork-approval-${randomUUID()}`,
);
const windows = process.platform === "win32";
const command = windows
  ? deny
    ? `Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value test`
    : "Write-Output COWORK_APPROVAL_E2E"
  : deny
    ? `printf test > '${target.replaceAll("'", "'\\''")}'`
    : "printf COWORK_APPROVAL_E2E";
const domain = "window['claude.web'].LocalAgentModeSessions";
let id;
let workspace;
const mark = client.logMark();
try {
  const prompt = `To test manual approval, run exactly this command using escalated permissions so it requests approval: ${command}. Do not run any other command.`;
  id = await page.eval(
    `${domain}.start({message:${JSON.stringify(prompt)},permissionMode:'default'}).then(r=>r.sessionId)`,
  );
  workspace = await page.eval(
    `${domain}.getSession(${JSON.stringify(id)}).then(s=>s?.cwd)`,
  );
  await page.goto(`/cowork/${id}`);
  await page.eval(
    "(() => { window.__approvalErrors=[]; window.addEventListener('error', e => window.__approvalErrors.push(e.message)); window.addEventListener('unhandledrejection', e => window.__approvalErrors.push(String(e.reason))); })()",
  );
  await page.waitFor(
    `${domain}.getSession(${JSON.stringify(id)}).then(s=>s?.pendingToolPermissions?.length>0)`,
    90000,
    1000,
  );
  const request = await page.eval(
    `${domain}.getSession(${JSON.stringify(id)}).then(s=>s.pendingToolPermissions[0])`,
  );
  const allowedCommand = request.input?.command;
  if (
    deny
      ? !allowedCommand?.includes(windows ? path.basename(target) : target)
      : windows
        ? !/^"[^"]*\\powershell\.exe" -Command 'Write-Output COWORK_APPROVAL_E2E'$/i.test(
            allowedCommand ?? "",
          )
        : ![command, `/bin/zsh -lc '${command}'`].includes(allowedCommand)
  )
    throw Error(
      `The model requested a different command; no approval was given: ${String(request.input?.command).slice(0, 300)}`,
    );
  // Reopen with a pending request: it must hydrate from the engine.
  await page.goto(`/cowork/${id}`);
  await page.eval(
    `(async()=>{const button=await __e2e.waitFor(()=>__e2e.all('button').find(b=>__e2e.visible(b)&&${deny ? "/^Deny$/" : "/^(Allow once|Allow|Approve)$/"}.test(b.innerText.trim().split(String.fromCharCode(10))[0])),30000);button.setAttribute('data-claudex-e2e-approval','');})()`,
  );
  // shared-1 wh/Ae deliberately ignores approval input during the first
  // second after a document is created. Respect that guard after reopening.
  await page.eval("__e2e.sleep(1100)");
  await page.click("[data-claudex-e2e-approval]");
  await page.waitFor(
    `${domain}.getSession(${JSON.stringify(id)}).then(s=>s&&!s.pendingToolPermissions?.length)`,
    30000,
    500,
  );
  if (deny) {
    await page.eval(`${domain}.stop(${JSON.stringify(id)})`);
    await page.waitFor(
      `${domain}.getSession(${JSON.stringify(id)}).then(s=>s&&!s.isRunning)`,
      30000,
      1000,
    );
    if (
      await access(target).then(
        () => true,
        () => false,
      )
    )
      throw Error("The denied Cowork command created its target.");
    console.log(
      "Cowork reopened a pending permission and denied its command; no target file was created.",
    );
  } else {
    await page.waitFor(
      `${domain}.getSession(${JSON.stringify(id)}).then(s=>s&&!s.isRunning)`,
      90000,
      1000,
    );
    const rows = await page.eval(
      `${domain}.getTranscript(${JSON.stringify(id)})`,
    );
    if (
      !rows.some(
        (row) =>
          Array.isArray(row.message?.content) &&
          row.message.content.some(
            (block) =>
              block.type === "tool_result" &&
              !block.is_error &&
              block.content?.includes("COWORK_APPROVAL_E2E"),
          ),
      )
    )
      throw Error(
        "The approved Cowork command result is missing from history.",
      );
    await page.goto(`/cowork/${id}`);
    await page.waitFor(
      "document.body.innerText.includes('COWORK_APPROVAL_E2E')",
      30000,
    );
    console.log(
      "Cowork reopened a pending permission, accepted its read-only command and preserved its result.",
    );
  }
  const syncFailures = client
    .logSince(mark)
    .filter(
      (line) =>
        /LocalAgentModeSessions_\$_(?:replaceRemoteMcpServers|replaceEnabledMcpTools)/.test(
          line,
        ) && /Error:/.test(line),
    );
  if (syncFailures.length)
    throw Error(
      `Cowork connector synchronization failed: ${syncFailures[0].slice(-350)}`,
    );
} catch (error) {
  console.error(
    "Cowork approval diagnostic:",
    JSON.stringify(
      await page
        .eval(
          "({errors:window.__approvalErrors,buttons:__e2e.all('button').filter(__e2e.visible).map(e=>e.innerText.trim()).filter(t=>/allow|approve|deny/i.test(t)).slice(-15)})",
        )
        .catch(() => null),
    ),
  );
  for (const line of client
    .logSince(mark)
    .filter((line) => /Error:|native refused|not configured/.test(line))
    .slice(-8))
    console.error(line.slice(0, 500));
  throw error;
} finally {
  if (id) {
    await page
      .eval(`${domain}.stop(${JSON.stringify(id)}).catch(()=>{})`)
      .catch(() => {});
    try {
      await page.eval(`${domain}.delete(${JSON.stringify(id)})`);
      const raw = id.slice(6);
      await page.eval(
        `(async()=>{const call=(name,args=[])=>fetch('/__debug/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json());const snapshot=await call('snapshot');if(snapshot.error)throw Error(snapshot.error);const mirror=snapshot.value.conversations.find(c=>c.id===${JSON.stringify(raw)}&&c.cloudHosted&&c.turns?.some(t=>t.prompt.includes('To test manual approval, run exactly this command using escalated permissions so it requests approval:')));if(mirror){const removed=await call('deleteConversation',[mirror.id]);if(removed.error)throw Error(removed.error);}})()`,
      );
    } catch (error) {
      console.error(`Cowork test cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  await client.quit().catch(() => client.stop());
  if (
    workspace &&
    path.resolve(workspace).startsWith(path.resolve(profile) + path.sep) &&
    /[\\/]sessions[\\/][a-f0-9-]{36}$/.test(workspace)
  )
    await rmdir(workspace).catch(() => {});
  await rm(target, { force: true });
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
