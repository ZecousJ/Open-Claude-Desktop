const { chromium } = require(process.env.F016_PLAYWRIGHT || "playwright-core");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
async function port() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
(async () => {
  const profile = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-f016-native-"),
    ),
    exe =
      process.env.F016_ELECTRON ||
      (process.platform === "win32"
        ? path.resolve("node_modules/electron/dist/electron.exe")
        : path.resolve("node_modules/.bin/electron")),
    fixture =
      process.env.F016_NATIVE_FIXTURE ||
      (() => {
        throw Error("F016_NATIVE_FIXTURE is required");
      })();
  let child,
    browser,
    page,
    output = "";
  const fixtureOwner = "f016-synthetic-" + path.basename(profile),
    scope = createHash("sha256")
      .update(JSON.stringify(["windows-rest-v1", fixtureOwner]))
      .digest("hex"),
    registryKey = `HKCU\\Software\\Claudex\\OfficialRestReceipts\\${scope}`;
  if (
    process.platform === "win32" &&
    spawnSync("reg.exe", ["query", registryKey], {
      windowsHide: true,
      stdio: "ignore",
    }).status === 0
  )
    throw Error("Synthetic receipt key already exists");
  async function launch() {
    const p = await port();
    child = spawn(exe, [fixture], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDEX_F016_PROFILE: profile,
        CLAUDEX_F016_CDP_PORT: String(p),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null)
        throw Error("Fixture exited: " + output.slice(-3000));
      try {
        const r = await fetch(`http://127.0.0.1:${p}/json/version`);
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`);
    const context = browser.contexts()[0];
    for (let i = 0; i < 120 && !context.pages().length; i++)
      await new Promise((r) => setTimeout(r, 250));
    page = context.pages()[0];
    if (!page) throw Error("No native page");
  }
  async function quit() {
    await page.evaluate(() => fetch("/__debug/quit", { method: "POST" }));
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(
        () => reject(Error("Native fixture did not quit")),
        15000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await browser.close().catch(() => {});
    browser = undefined;
    page = undefined;
    child = undefined;
  }
  try {
    await launch();
    await page
      .getByText("The selected visible source here.", { exact: true })
      .first()
      .waitFor({ timeout: 90000 });
    await page.getByTestId("chat-input").fill("/btw");
    await page.getByText("Ask in side chat (btw)", { exact: true }).click();
    await page.locator("aside[data-open]").waitFor();
    let box = page.getByPlaceholder("Ask a quick question…");
    await box.fill("What was the source?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByText("F016 native side answer", { exact: true })
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Close side chat" }).click();
    await page.getByTestId("chat-input").click();
    await page.getByTestId("chat-input").fill("/btw");
    await page.getByText("Ask in side chat (btw)", { exact: true }).click();
    await page.locator("aside[data-open]").waitFor();
    await page.getByText("F016 native side answer", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Clear side chat" }).click();
    await page.getByPlaceholder("Ask a quick question…").waitFor();
    box = page.getByPlaceholder("Ask a quick question…");
    await box.fill("F016 slow side");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .locator("aside[data-open]")
      .getByText("Partial side answer", { exact: true })
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Clear side chat" }).click();
    await page.getByPlaceholder("Ask a quick question…").waitFor();
    let aborted = false;
    for (let i = 0; i < 50; i++) {
      const status = await page.evaluate(() =>
        fetch("/api/__f016/snapshot").then((r) => r.json()),
      );
      if (status.sideAborts === 1) {
        aborted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(aborted, true, "Clear must abort the in-flight side request");
    await page.getByRole("button", { name: "Close side chat" }).click();
    const source = page
      .getByText("The selected visible source here.", { exact: true })
      .first();
    await source.selectText();
    await page
      .getByRole("button", { name: /^Reply/ })
      .last()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "Write a reply" })
      .fill("F016 native quote comment");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByTestId("chat-input-send").click();
    await page
      .getByText("F016 native quote accepted", { exact: true })
      .last()
      .waitFor({ timeout: 30000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByText("F016 native quote accepted", { exact: true })
      .last()
      .waitFor({ timeout: 30000 });
    await page
      .getByText("F016 native quote comment", { exact: true })
      .last()
      .waitFor({ timeout: 15000 });
    const firstSnapshot = await page.evaluate(() =>
      fetch("/api/__f016/snapshot").then((r) => r.json()),
    );
    assert.equal(firstSnapshot.turns.length, 2);
    assert.equal(
      firstSnapshot.turns[1].completionQuotes[0].passage.value.targetMessageId,
      "seed:assistant",
    );
    assert.equal(
      firstSnapshot.turns[1].completionQuotes[0].comment,
      "F016 native quote comment",
    );
    const rest = await page.evaluate(async () => {
      const org = (await (await fetch("/api/organizations")).json())[0].uuid,
        id = "8cfc6561-4d86-4efa-8e94-72a293f83a45",
        base = `/api/organizations/${org}/chat_conversations/${id}`;
      const history = await (await fetch(base)).json();
      const selected = "The selected visible source here.";
      const body = {
        prompt: "F016 native REST comment",
        model: "fixture-model",
        tools: [],
        files: [],
        sync_sources: [],
        rendering_mode: "messages",
        parent_message_uuid: history.current_leaf_message_uuid,
        turn_message_uuids: {
          human_message_uuid: crypto.randomUUID(),
          assistant_message_uuid: crypto.randomUUID(),
        },
        completion_request_id: crypto.randomUUID(),
        attachments: [
          {
            file_name: "excerpt_from_previous_claude_message.txt",
            file_type: "txt",
            file_size: new TextEncoder().encode(selected).length,
            extracted_content: selected,
            kind: "excerpt",
            origin: "user_upload",
            quote_message_uuid: "seed:assistant",
          },
        ],
      };
      const response = await fetch(base + "/completion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text(), base };
    });
    assert.equal(rest.status, 200, rest.text);
    assert.match(rest.text, /event: message_stop/);
    const saved = await page.evaluate(
      (base) => fetch(base).then((r) => r.json()),
      rest.base,
    );
    const row = saved.chat_messages.find(
      (m) => m.sender === "human" && m.text === "F016 native REST comment",
    );
    assert.equal(row.attachments[0].quote_message_uuid, "seed:assistant");
    assert.equal(
      row.attachments[0].extracted_content,
      "The selected visible source here.",
    );
    await new Promise((r) => setTimeout(r, 1000));
    await quit();
    await launch();
    await page
      .getByText("F016 native quote accepted", { exact: true })
      .last()
      .waitFor({ timeout: 90000 });
    await page
      .getByText("F016 native quote comment", { exact: true })
      .last()
      .waitFor({ timeout: 30000 });
    await page
      .getByText("The selected visible source here.", { exact: true })
      .first()
      .waitFor();
    const restored = await page.evaluate(() =>
      fetch("/api/__f016/snapshot").then((r) => r.json()),
    );
    assert.equal(restored.turns.length, 3);
    assert.equal(
      restored.turns[1].completionQuotes[0].comment,
      "F016 native quote comment",
    );
    const restoredHistory = await page.evaluate(
      (base) => fetch(base).then((r) => r.json()),
      rest.base,
    );
    const restoredRow = restoredHistory.chat_messages.find(
      (m) => m.sender === "human" && m.text === "F016 native REST comment",
    );
    assert.equal(
      restoredRow.attachments[0].quote_message_uuid,
      "seed:assistant",
    );
    assert.equal(
      restoredRow.attachments[0].extracted_content,
      "The selected visible source here.",
    );
    await page.getByRole("button", { name: /Add files, connectors, and more/ }).click();
    await page.getByText("Upload or add files", { exact: true }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Choose files" }).click(),
    ]);
    const pickerText = "F016 file picker: lighthouse blue.";
    await chooser.setFiles({
      name: "f016-picker-local.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(pickerText),
    });
    await page.getByText("f016-picker-local.txt", { exact: true }).first().waitFor();
    await page.getByTestId("chat-input").fill("F016 local picker test");
    await page.getByTestId("chat-input-send").click();
    await page.getByText("F016 native quote accepted", { exact: true }).last().waitFor();
    const pickerHistory = await page.evaluate(
      (base) => fetch(base).then((r) => r.json()),
      rest.base,
    );
    const pickerRow = pickerHistory.chat_messages.find(
      (m) => m.sender === "human" && m.text === "F016 local picker test",
    );
    assert.ok(pickerRow);
    assert.equal(pickerRow.attachments.length, 1);
    assert.equal(pickerRow.attachments[0].file_name, "f016-picker-local.txt");
    assert.equal(pickerRow.attachments[0].extracted_content, pickerText);
    const beforeMissing = await page.evaluate(async () => {
      const before = await fetch("/api/__f016/snapshot").then((r) => r.json());
      const response = await fetch("/api/__f016/missing-attachment", { method: "POST" });
      if (!response.ok) throw Error("Could not prepare missing fixture attachment");
      return before;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("f016-missing.txt", { exact: true }).first().waitFor({ timeout: 30000 });
    await page.getByTestId("chat-input").fill("/btw What did the missing file say?");
    await page.getByTestId("chat-input-send").click();
    await page.getByText("A file in this conversation is unavailable or has changed. Start a new conversation with the file and try again.", { exact: true }).waitFor({ timeout: 30000 });
    const afterMissing = await page.evaluate(() => fetch("/api/__f016/snapshot").then((r) => r.json()));
    assert.equal(afterMissing.sideRequests, beforeMissing.sideRequests, "missing context must not reach the model");
    assert.equal(afterMissing.turns.length, beforeMissing.turns.length, "failed side question must not alter the main conversation");
    await page.evaluate(() => fetch("/api/__f016/unknown-attachment-error", { method: "POST" }));
    await page.getByPlaceholder("Ask a quick question…").fill("What happened to the file?");
    await page.locator("aside[data-open]").getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Something went wrong", { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByText("/synthetic/private-test-path", { exact: false }).count(), 0, "unrecognized server errors must not be displayed");
    const afterUnknown = await page.evaluate(() => fetch("/api/__f016/snapshot").then((r) => r.json()));
    assert.equal(afterUnknown.sideRequests, beforeMissing.sideRequests);
    assert.equal(afterUnknown.turns.length, beforeMissing.turns.length);
    await quit();
    console.log(
      "Hidden native Electron: side lifecycle, PB and REST quotes, reload, restart, local file picker and unavailable-file side question passed.",
    );
  } catch (e) {
    console.error(e);
    if (page)
      console.error(
        "page text:",
        (
          await page
            .locator("body")
            .innerText({ timeout: 2000 })
            .catch(() => "")
        ).slice(-2500),
      );
    console.error("fixture log:", output.slice(-3000));
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(resolve, 5000);
      });
    }
    if (
      process.platform === "win32" &&
      spawnSync("reg.exe", ["query", registryKey], {
        windowsHide: true,
        stdio: "ignore",
      }).status === 0
    ) {
      const removed = spawnSync("reg.exe", ["delete", registryKey, "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (removed.status !== 0) {
        console.error("Could not remove synthetic receipt key");
        process.exitCode = 1;
      }
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
