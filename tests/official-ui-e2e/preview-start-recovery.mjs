import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, profile } from "./harness.mjs";

const owner = "86411823-4720-5ce3-ad9a-e6f769032f3b";
const catalog = path.join(profile, "profiles", owner, "conversations.json");
const original = JSON.parse(await fs.readFile(catalog, "utf8"));
assert.ok(Array.isArray(original));
const selected = original.find(
  (c) =>
    c.mode === "code" &&
    c.cwd?.startsWith(profile + path.sep) &&
    !c.codeNewTask,
);
assert.ok(selected, "Existing idle test session required");
const savedOffer = selected.codeNewTask;
const offerId = randomUUID(),
  savedText = "PREVIEW_LEGACY_INPUT_" + offerId;
selected.codeNewTask = {
  id: offerId,
  text: savedText,
  attachments: [],
  providerId: selected.providerId,
  model: selected.model,
};
await fs.writeFile(catalog, JSON.stringify(original));
let client, config, oldConfig, fixture;
try {
  client = await Client.launch();
  const page = client.page(0),
    id = "local_" + selected.id;
  const api = (d, m, ...args) =>
    page.eval(
      'window["claude.web"][' +
        JSON.stringify(d) +
        "][" +
        JSON.stringify(m) +
        "](" +
        args.map(JSON.stringify).join(",") +
        ")",
    );
  const session = await api("LocalSessions", "getSession", id);
  assert.ok(session.sendsHeldAfterError.includes("legacy-task-" + offerId));
  config = path.join(selected.cwd, ".claude/launch.json");
  await fs.mkdir(path.dirname(config), { recursive: true });
  oldConfig = await fs.readFile(config).catch(() => null);
  const suffix = randomUUID().slice(0, 8),
    name = "Missing fixture " + suffix;
  const content = oldConfig
    ? JSON.parse(oldConfig)
    : { version: "0.0.1", configurations: [] };
  fixture = path.join(selected.cwd, "missing-preview-" + suffix + ".mjs");
  content.configurations ??= [];
  content.configurations.push({
    name,
    runtimeExecutable: process.execPath,
    runtimeArgs: [fixture],
    port: 18791,
  });
  await fs.writeFile(config, JSON.stringify(content));
  const image = await fetch(
    client.origin + "/images/clawd/core/Clawd-CrabWalking.gif",
    { headers: { Cookie: client.cookie } },
  );
  assert.ok(image.ok);
  assert.equal(
    Buffer.from(await image.arrayBuffer())
      .subarray(0, 6)
      .toString(),
    "GIF89a",
  );
  // Remove this test session's browser so focus must initialize a never-opened pane.
  await api("Launch", "destroyPreview", "preview-" + id);
  await page.goto("/epitaxy");
  await page.goto("/epitaxy/" + id);
  await page.waitFor(
    '!!document.querySelector("button[aria-label=Browser]")',
    30000,
  );
  if (
    (await page.eval(
      'document.querySelector("button[aria-label=Browser]").getAttribute("aria-pressed")',
    )) !== "true"
  )
    await page.click("button[aria-label=Browser]");
  await page.waitFor(
    '!document.body.innerText.includes("Setting up preview")',
    15000,
  );
  const tabs = await api("Launch", "getPreviewTabs", "preview-" + id);
  assert.ok(tabs.tabs.length > 0);
  // Existing history may restore a prior URL. Use the official new-tab control.
  const blank = tabs.tabs.find((t) => t.origin === "about:blank");
  if (!blank) {
    await page.waitFor(
      '!!document.querySelector("button[aria-label=\\"New tab\\"]")',
    );
    await page.click('button[aria-label="New tab"]');
  }
  const label = "Run " + name;
  await page.waitFor(
    'Array.from(document.querySelectorAll("button")).some(b=>b.getAttribute("aria-label")===' +
      JSON.stringify(label) +
      ")",
    20000,
  );
  await page.eval(
    '(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.innerText.trim()==="Not now");if(b)b.click();})()',
  );
  await page.click("button[aria-label=" + JSON.stringify(label) + "]");
  await page.waitFor(
    'window["claude.web"].LocalSessions.getTranscript(' +
      JSON.stringify(id) +
      ').then(rows=>JSON.stringify(rows).includes("MODULE_NOT_FOUND"))',
    30000,
  );
  const queuedButton = await page.eval(
    '(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>/messages queued/.test(b.innerText));if(!b)return false;b.setAttribute("data-recovery-queue","");return true;})()',
  );
  if (queuedButton) await page.click("[data-recovery-queue]");
  await page.waitFor(
    'document.body.innerText.includes("MODULE_NOT_FOUND")',
    10000,
  );
  assert.equal(
    await page.eval(
      'document.body.innerText.includes("A message is already waiting to be sent")',
    ),
    false,
  );
  assert.equal(
    await page.eval('document.body.innerText.includes("Setting up preview")'),
    false,
  );
  const transcript = await api("LocalSessions", "getTranscript", id);
  assert.ok(JSON.stringify(transcript).includes(savedText));
  assert.ok(JSON.stringify(transcript).includes("MODULE_NOT_FOUND"));
  const now = await api("LocalSessions", "getSession", id);
  assert.equal(now.turnRunning, false);
  assert.ok(
    now.sendsHeldAfterError.length >= 2,
    "Original input and failed-server request remain visible and unsent",
  );
  for (const uuid of now.sendsHeldAfterError)
    await api("LocalSessions", "cancelQueuedMessage", id, uuid);
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "first empty Browser auto-initializes; official GIF loads; configured missing executable via Run button shows actual error; legacy input and automatic repair request remain visible and unsent, cancellation works; no model call",
    }),
  );
} finally {
  if (client) {
    try {
      await client
        .page(0)
        .eval(
          '(async()=>{const s=window["claude.web"].LocalSessions,id=' +
            JSON.stringify("local_" + selected.id) +
            ';const c=await s.getSession(id),rows=await s.getTranscript(id);for(const uuid of c?.sendsHeldAfterError??[]){const row=rows.find(r=>r.uuid===uuid),text=JSON.stringify(row);if(text.includes("PREVIEW_LEGACY_INPUT_")||text.includes("missing-preview-"))await s.cancelQueuedMessage(id,uuid);}})()',
        );
    } catch {}
  }
  if (config) {
    if (oldConfig) await fs.writeFile(config, oldConfig);
    else await fs.rm(config, { force: true });
  }
  if (client) await client.stop();
  const current = JSON.parse(await fs.readFile(catalog, "utf8"));
  const c = current.find((c) => c.id === selected.id);
  if (c?.codeNewTask?.id === offerId) {
    if (savedOffer) c.codeNewTask = savedOffer;
    else delete c.codeNewTask;
    await fs.writeFile(catalog, JSON.stringify(current));
  }
}
