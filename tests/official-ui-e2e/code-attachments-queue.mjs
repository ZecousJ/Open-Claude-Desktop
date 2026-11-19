import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client, profile, sleep } from "./harness.mjs";

let client = await Client.launch(),
  page = client.page(0),
  id,
  folder,
  fixture,
  pid;
const nonce = randomUUID().slice(0, 8),
  token = "QUEUE_FILE_" + nonce;
const prompt =
  "QUEUE_IMAGE_" +
  nonce +
  ": Read the attached text file and image. Reply with the exact token inside the text file and the dominant image color. You may read only the attached text file, without editing files.";
const api = (name, ...args) =>
  page.eval(
    'window["claude.web"].LocalSessions[' +
      JSON.stringify(name) +
      "](" +
      [id, ...args].map(JSON.stringify).join(",") +
      ")",
  );
try {
  const workspace = await page.eval(
    'window["claude.web"].LocalSessions.createScratchWorkspace()',
  );
  folder = workspace.cwd;
  fixture = path.join(folder, "queued-attachments-" + nonce);
  await fs.mkdir(fixture);
  const textFile = path.join(fixture, "queued.txt"),
    imageFile = path.join(fixture, "green.png"),
    pidFile = path.join(fixture, "pid");
  await fs.writeFile(textFile, token);
  const bytes = await page.eval(
    '(async()=>{const b=await __e2e.pngOf("#00ff00",110,70);return btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer())));})()',
  );
  await fs.writeFile(imageFile, Buffer.from(bytes, "base64"));
  const command =
    "python3 -c 'import time;print(\"QUEUE_WAIT_" +
    nonce +
    "\",flush=True);time.sleep(120)'";
  const started = await page.eval(
    'window["claude.web"].LocalSessions.start(' +
      JSON.stringify({
        cwd: folder,
        message:
          "Run exactly this command once: " +
          command +
          ". Do not add a timeout, background it, or run other commands. Wait for completion.",
        permissionMode: "default",
      }) +
      ")",
  );
  id = started.sessionId;
  await page.goto("/epitaxy/" + id);
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const processes = execFileSync("ps", ["-eo", "pid,command"], {
      encoding: "utf8",
    }).split("\n");
    const processLine = processes.find(
      (l) =>
        /python[^ ]* -c import time/.test(l) &&
        l.includes("QUEUE_WAIT_" + nonce),
    );
    if (processLine) {
      pid = Number(processLine.trim().split(/\s+/)[0]);
      break;
    }
    const permission = (await api("getSession")).pendingToolPermissions?.[0];
    if (permission) {
      assert.ok(permission.input?.command?.includes("QUEUE_WAIT_" + nonce));
      await page.eval(
        '(()=>{const b=__e2e.all("button").find(b=>__e2e.visible(b)&&b.innerText.trim().startsWith("Allow once"));if(!b)throw Error("approval absent");b.setAttribute("data-queue-allow","");})()',
      );
      await sleep(1100);
      await page.click("[data-queue-allow]");
    }
    await sleep(300);
  }
  assert.ok(pid, "Real command must be running");
  const select = async () => {
    const response = await fetch(client.origin + "/__debug/file-input", {
      method: "POST",
      headers: { Cookie: client.cookie },
      body: JSON.stringify({ files: [textFile, imageFile] }),
    });
    assert.ok(response.ok, await response.text());
    await page.waitFor('document.body.innerText.includes("queued.txt")');
  };
  const queue = async (message) => {
    await select();
    await page.eval("__e2e.type(" + JSON.stringify(message) + ")");
    const key = await fetch(
      client.origin + "/__debug/key?key=Enter&modifier=meta",
      { method: "POST", headers: { Cookie: client.cookie } },
    );
    assert.equal(key.status, 204);
    await page.waitFor(
      'window["claude.web"].LocalSessions.getTranscript(' +
        JSON.stringify(id) +
        ').then(rows=>rows.some(r=>r.priority==="later"&&JSON.stringify(r.message.content).includes(' +
        JSON.stringify(message) +
        ")))",
      15000,
    );
  };
  await queue("QUEUE_CANCEL_" + nonce);
  const cancelled = (await api("getTranscript")).find(
    (r) =>
      r.priority === "later" &&
      JSON.stringify(r).includes("QUEUE_CANCEL_" + nonce),
  );
  assert.ok(cancelled);
  assert.ok(cancelled.message.content.some((b) => b.type === "image"));
  await page.click('button[aria-label="Remove from queue"]');
  await page.waitFor(
    'window["claude.web"].LocalSessions.getTranscript(' +
      JSON.stringify(id) +
      ").then(r=>!r.some(x=>x.uuid===" +
      JSON.stringify(cancelled.uuid) +
      "))",
  );
  await queue(prompt);
  const retained = (await api("getTranscript")).find(
    (r) =>
      r.priority === "later" &&
      JSON.stringify(r).includes("QUEUE_IMAGE_" + nonce),
  );
  assert.ok(retained);
  assert.ok(retained.message.content.some((b) => b.type === "image"));
  await page.click('button[aria-label="Stop"]');
  await page.waitFor(
    'window["claude.web"].LocalSessions.getSession(' +
      JSON.stringify(id) +
      ").then(s=>!s.turnRunning)",
    20000,
  );
  console.log(
    "Native queue shortcut preserves image; Remove from queue removes only selected input; Stop leaves retained input.",
  );
  await client.quit();
  client = await Client.launch();
  page = client.page(0);
  await page.goto("/epitaxy/" + id);
  await page.waitFor(
    'document.body.innerText.includes("1 message queued")',
    20000,
  );
  const restored = (await api("getTranscript")).find(
    (r) => r.uuid === retained.uuid,
  );
  assert.ok(restored);
  assert.equal(
    restored.message.content.find((b) => b.type === "image").source.data,
    retained.message.content.find((b) => b.type === "image").source.data,
  );
  await page.click('button[aria-label="Edit in composer"]');
  await page.waitFor(
    'Array.from(document.querySelectorAll("[contenteditable=true]")).some(e=>e.textContent.includes(' +
      JSON.stringify("QUEUE_IMAGE_" + nonce) +
      "))",
  );
  assert.ok(
    await page.eval(
      'Array.from(document.querySelectorAll("img")).some(i=>i.complete&&i.naturalWidth>0&&/^(blob:|data:image)/.test(i.src))',
    ),
  );
  await page.click('button[aria-label="Send"]');
  await page.waitFor(
    'window["claude.web"].LocalSessions.getTranscript(' +
      JSON.stringify(id) +
      ').then(rows=>rows.some(r=>r.type==="assistant"&&JSON.stringify(r.message.content).includes(' +
      JSON.stringify(token) +
      ")))",
    180000,
    1000,
  );
  await page.waitFor(
    'window["claude.web"].LocalSessions.getSession(' +
      JSON.stringify(id) +
      ").then(s=>!s.turnRunning)",
    120000,
  );
  const final = await api("getTranscript");
  const answer = final
    .filter((r) => r.type === "assistant" && JSON.stringify(r).includes(token))
    .at(-1);
  assert.match(JSON.stringify(answer), /green|绿/i);
  assert.equal(
    final.filter(
      (r) =>
        r.type === "user" && JSON.stringify(r).includes("QUEUE_IMAGE_" + nonce),
    ).length,
    1,
  );
  assert.ok(
    !final.some((r) => JSON.stringify(r).includes("QUEUE_CANCEL_" + nonce)),
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "real running command; native Cmd+Enter mixed attachment queue; UI cancellation; Stop+normal quit; exact image restored; Edit in composer+Send; actual file token and green recognition; no duplicate or cancelled delivery",
      sessionId: id,
    }),
  );
} catch (error) {
  console.log(
    "UI state",
    await page.eval("document.body.innerText.slice(-6500)").catch(() => null),
  );
  throw error;
} finally {
  if (id) {
    await api("stop").catch(() => {});
    try {
      for (const r of await api("getTranscript"))
        if (r.priority && JSON.stringify(r).includes(nonce))
          await api("cancelQueuedMessage", r.uuid);
    } catch {}
  }
  await client.stop();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
}
