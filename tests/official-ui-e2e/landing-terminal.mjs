import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "./harness.mjs";
const client = await Client.launch();
const page = client.page(0);
try {
  const before = await page.eval(
    `window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.map(s=>s.sessionId).sort())`,
  );
  await page.goto("/epitaxy");
  await page.eval(
    `(()=>{window.__landingOutput='';window.__landingOff=window['claude.web'].LocalSessions.onOnEvent(e=>{if(e.type==='shell_pty_data'&&e.sessionId==='landing')window.__landingOutput+=e.data})})()`,
  );
  const pressed = await page.waitFor(
    `(()=>{const b=document.querySelector('button[aria-label="Terminal"]');return b&&{pressed:b.getAttribute('aria-pressed')}})()`,
  );
  if (pressed.pressed !== "true")
    await page.click('button[aria-label="Terminal"]');
  await page.waitFor(
    `window['claude.web'].LocalSessions.whenShellPtyReads('landing')`,
    30000,
  );
  assert.equal(
    await page.eval(
      `document.body.innerText.includes('Open a local Code session before starting its terminal.')`,
    ),
    false,
  );
  await page.eval(
    `window['claude.web'].LocalSessions.writeShellPty('landing',"printf '%s%s' LANDING_ UI_OK; pwd${JSON.stringify(String.fromCharCode(10)).slice(1, -1)}")`,
  );
  await page.waitFor(`window.__landingOutput.includes('LANDING_UI_OK')`, 20000);
  await page.waitFor(
    `Array.from(document.querySelectorAll('.xterm canvas')).some(c=>c.width>0&&c.height>0)`,
    15000,
  );
  if (process.env.CLAUDEX_TERMINAL_CAPTURE) {
    await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,250))))`);
    const response = await fetch(client.origin + "/__debug/capture", {
      headers: { Cookie: client.cookie },
    });
    assert.equal(response.ok, true);
    await writeFile(
      process.env.CLAUDEX_TERMINAL_CAPTURE,
      Buffer.from(await response.arrayBuffer()),
    );
  }
  const cwd = await page.eval(`window.__landingOutput`);
  assert.ok(
    cwd.includes(os.homedir()),
    "Official ~ default opens the user home",
  );
  await page.eval(
    `window['claude.web'].LocalSessions.resizeShellPty('landing',100,30)`,
  );
  const other = await client.openPage();
  await other.goto("/epitaxy");
  await other.eval(
    `(()=>{window.__secondOutput='';window.__secondOff=window['claude.web'].LocalSessions.onOnEvent(e=>{if(e.type==='shell_pty_data'&&e.sessionId==='landing')window.__secondOutput+=e.data})})()`,
  );
  await other.eval(
    `window['claude.web'].LocalSessions.startShellPty('landing',80,24,'test')`,
  );
  await other.eval(
    `window['claude.web'].LocalSessions.writeShellPty('landing',"printf '%s%s' SECOND_ WINDOW_OK${JSON.stringify(String.fromCharCode(10)).slice(1, -1)}")`,
  );
  await other.waitFor(
    `window.__secondOutput.includes('SECOND_WINDOW_OK')`,
    15000,
  );
  assert.equal(
    await page.eval(`window.__landingOutput.includes('SECOND_WINDOW_OK')`),
    false,
  );
  await other.eval(
    `window['claude.web'].LocalSessions.stopShellPty('landing')`,
  );
  await page.eval(
    `window['claude.web'].LocalSessions.writeShellPty('landing',"printf '%s%s' FIRST_ STILL_ALIVE${JSON.stringify(String.fromCharCode(10)).slice(1, -1)}")`,
  );
  await page.waitFor(
    `window.__landingOutput.includes('FIRST_STILL_ALIVE')`,
    15000,
  );
  await page.eval(`window['claude.web'].LocalSessions.stopShellPty('landing')`);
  assert.equal(
    await page.eval(
      `window['claude.web'].LocalSessions.whenShellPtyReads('landing')`,
    ),
    false,
  );
  const restart = await page.eval(
    `window['claude.web'].LocalSessions.startShellPty('landing',80,24,'test')`,
  );
  assert.equal(restart.ok, true);
  await page.eval(
    `window['claude.web'].LocalSessions.writeShellPty('landing',"printf '%s%s' REOPEN_ OK${JSON.stringify(String.fromCharCode(10)).slice(1, -1)}")`,
  );
  await page.waitFor(`window.__landingOutput.includes('REOPEN_OK')`, 15000);
  await page.eval(`window['claude.web'].LocalSessions.stopShellPty('landing')`);
  assert.deepEqual(
    await page.eval(
      `window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.map(s=>s.sessionId).sort())`,
    ),
    before,
  );
  assert.deepEqual(
    client.gapsSince(0).filter((l) => /ShellPty|Terminal/.test(l)),
    [],
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "actual official landing Terminal button, real native shell output visible, resize, two-window isolation, close/reopen, no conversation created and no model request",
    }),
  );
} catch (error) {
  console.error(error);
  console.error(
    JSON.stringify({
      body: await page
        .eval("document.body.innerText.slice(-2500)")
        .catch(() => null),
      gaps: client.gapsSince(0).slice(-10),
      errors: client
        .logSince(0)
        .filter((l) =>
          /startShellPty|DraftTerminal|terminal|ZodError|invalid_type/.test(l),
        )
        .slice(-25),
    }),
  );
  process.exitCode = 1;
} finally {
  await page
    .eval(
      `window['claude.web'].LocalSessions.stopShellPty('landing').catch(()=>{})`,
    )
    .catch(() => {});
  await client.stop();
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
