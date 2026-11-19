import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, profile } from "./harness.mjs";

let client = await Client.launch(),
  page = client.page(0);
let sessionId, fixtureFolder;
const nonce = randomUUID().slice(0, 8),
  marker = "ATTACHED_CONTENT_" + nonce,
  fileName = "attached-" + nonce + ".txt";
try {
  const sessions = await page.eval(
    'window["claude.web"].LocalSessions.getSessionList().then(r=>r.sessions)',
  );
  const current = sessions.find(
    (s) =>
      s.cwd?.startsWith(profile + path.sep) && !s.turnRunning && !s.isArchived,
  );
  assert.ok(current);
  sessionId = current.sessionId;
  await page.goto("/epitaxy/" + sessionId);
  await page.waitFor(
    '!!document.querySelector("[contenteditable=true]")',
    30000,
  );
  console.log(
    "File inputs:",
    await page.eval(
      'Array.from(document.querySelectorAll("input[type=file]")).map(e=>({accept:e.accept,multiple:e.multiple,testId:e.dataset.testid}))',
    ),
  );
  fixtureFolder = path.join(current.cwd, "attachment-e2e-" + nonce);
  await fs.mkdir(fixtureFolder);
  await fs.writeFile(path.join(fixtureFolder, fileName), marker);
  const imageData = await page.eval(
    '(async()=>{const b=await __e2e.pngOf("#ff0000",80,60);const bytes=new Uint8Array(await b.arrayBuffer());return btoa(String.fromCharCode(...bytes));})()',
  );
  await fs.writeFile(
    path.join(fixtureFolder, "red-square.png"),
    Buffer.from(imageData, "base64"),
  );
  const selected = await fetch(client.origin + "/__debug/file-input", {
    method: "POST",
    headers: { Cookie: client.cookie },
    body: JSON.stringify({
      files: [
        path.join(fixtureFolder, fileName),
        path.join(fixtureFolder, "red-square.png"),
      ],
    }),
  });
  assert.ok(selected.ok, await selected.text());
  await page.waitFor(
    "document.body.innerText.includes(" + JSON.stringify(fileName) + ")",
    20000,
  );
  await page.eval(
    '__e2e.type("Read the attached text file and the image. Reply with the exact token written inside the text file and the dominant image color. You may read only the attached text file with a read command if needed. Do not edit files or read other files.")',
  );
  await page.waitFor(
    '!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="Send"&&!b.disabled)',
    15000,
  );
  await page.click('button[aria-label="Send"]');
  const read =
    'window["claude.web"].LocalSessions.getTranscript(' +
    JSON.stringify(sessionId) +
    ")";
  try {
    await page.waitFor(
      read +
        '.then(rows=>rows.some(r=>r.type==="assistant"&&JSON.stringify(r.message.content).includes(' +
        JSON.stringify(marker) +
        ")))",
      180000,
      1500,
    );
  } catch (error) {
    console.log(
      "Failure body",
      await page.eval("document.body.innerText.slice(-8000)"),
    );
    console.log("Recent native errors", client.gapsSince(0));
    throw error;
  }
  await page.waitFor(
    'window["claude.web"].LocalSessions.getSession(' +
      JSON.stringify(sessionId) +
      ").then(s=>!s.turnRunning)",
    120000,
  );
  const rows = await page.eval(read);
  const reply = rows
    .filter(
      (r) =>
        r.type === "assistant" &&
        JSON.stringify(r.message.content).includes(marker),
    )
    .at(-1);
  assert.match(JSON.stringify(reply), /red|红/i);
  const user = rows.findLast(
    (r) =>
      r.type === "user" &&
      Array.isArray(r.message.content) &&
      r.message.content.some((b) => b.type === "image"),
  );
  assert.ok(user);
  assert.ok(
    user.file_attachments?.some((f) => f.file_name === fileName) ||
      JSON.stringify(user.message.content).includes(fileName),
  );
  await page.goto("/epitaxy/" + sessionId);
  await page.waitFor(
    "document.body.innerText.includes(" + JSON.stringify(fileName) + ")",
    30000,
  );
  assert.ok(
    await page.eval(
      'Array.from(document.querySelectorAll("img")).some(i=>i.complete&&i.naturalWidth>0&&i.src.startsWith("data:image/"))',
    ),
  );
  console.log(
    "Real official UI mixed file/image upload reaches model; response contains hidden file token and red color. History shows file badge and loaded image.",
  );
  if(process.env.CLAUDEX_ATTACHMENTS_CAPTURE){const response=await fetch(client.origin+'/__debug/capture',{headers:{Cookie:client.cookie}});assert.ok(response.ok);await fs.writeFile(process.env.CLAUDEX_ATTACHMENTS_CAPTURE,Buffer.from(await response.arrayBuffer()));}
  await client.quit();
  client = await Client.launch();
  page = client.page(0);
  await page.goto("/epitaxy/" + sessionId);
  await page.waitFor(
    "document.body.innerText.includes(" +
      JSON.stringify(marker) +
      ")&&document.body.innerText.includes(" +
      JSON.stringify(fileName) +
      ")",
    30000,
  );
  assert.ok(
    await page.eval(
      'Array.from(document.querySelectorAll("img")).some(i=>i.complete&&i.naturalWidth>0&&i.src.startsWith("data:image/"))',
    ),
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      sessionId,
      fileName,
      scope:
        "official composer text+PNG upload; true model content+color; history reroute and full restart; no project commands",
    }),
  );
} finally {
  await client.stop();
  if (fixtureFolder)
    await fs.rm(fixtureFolder, { recursive: true, force: true });
}
