/** Official document renderer with the reported file, never a screenshot recreation. */
import assert from "node:assert/strict";
import { copyFile, readFile, rm, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Client, profile, sleep } from "./harness.mjs";

const source = process.env.CLAUDEX_E2E_DOCUMENT;
assert.ok(source, "CLAUDEX_E2E_DOCUMENT must point to an existing DOCX sample");
const expectedPages = Number(process.env.CLAUDEX_E2E_DOCUMENT_PAGES ?? 3);
let captureIndex = 0;
let client = await Client.launch();
let page = client.page(0),
  fixture;
const name = "document-e2e-" + randomUUID() + ".docx";
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = checksum(await readFile(source));
try {
  const sessions = await page.eval(
    "window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions)",
  );
  let session;
  for (const s of sessions.filter(
    (s) => !s.isArchived && !s.turnRunning && s.cwd,
  )) {
    if (!path.resolve(s.cwd).startsWith(path.resolve(profile) + path.sep))
      continue;
    try {
      await access(s.cwd);
      session = s;
      break;
    } catch {}
  }
  assert.ok(session, "An existing idle test-profile workspace is required");
  fixture = path.join(session.cwd, name);
  await copyFile(source, fixture);
  const id = JSON.stringify(session.sessionId);
  const dataUrl = await page.eval(
    "window['claude.web'].LocalSessions.readSessionPanelDocumentAsDataUrl(" +
      id +
      "," +
      JSON.stringify(fixture) +
      ")",
  );
  assert.ok(
    dataUrl?.startsWith(
      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,",
    ),
  );
  assert.equal(
    checksum(Buffer.from(dataUrl.split(",")[1], "base64")),
    original,
  );
  console.log("Official document reader preserves original DOCX bytes.");
  async function openDocument() {
    await page.goto("/epitaxy/" + session.sessionId);
    await page.eval(
      "window['claude.web'].LocalSessions.personOpenedSession(" + id + ")",
    );
    await page.waitFor(
      "!!document.querySelector('button[aria-label=Files]')",
      30000,
    );
    if (
      (await page.eval(
        "document.querySelector('button[aria-label=Files]').getAttribute('aria-pressed')",
      )) !== "true"
    )
      await page.click('button[aria-label="Files"]');
    const tree = await page.waitFor(
      "(()=>{if(document.body.innerText.includes(" +
        JSON.stringify(name) +
        "))return 'open';const b=Array.from(document.querySelectorAll('button')).find(b=>(b.getAttribute('aria-label')||b.textContent).trim()==='Show file tree');if(!b)return false;b.setAttribute('data-doc-tree','');return 'closed'})()",
      20000,
    );
    if (tree === "closed") await page.click("[data-doc-tree]");
    await page.waitFor(
      "document.body.innerText.includes(" + JSON.stringify(name) + ")",
      20000,
    );
    await page.eval(
      "(()=>{const row=Array.from(document.querySelectorAll('[role=treeitem],button')).filter(e=>e.textContent.includes(" +
        JSON.stringify(name) +
        ")).sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!row)throw Error('DOCX tree row missing');row.setAttribute('data-doc-file','')})()",
    );
    await page.click("[data-doc-file]");
    let frames;
    for (let i = 0; i < 80; i++) {
      frames = await fetch(client.origin + "/__debug/frames", {
        headers: { Cookie: client.cookie },
      }).then((r) => r.json());
      if (
        frames.some(
          (f) =>
            f.url.startsWith("https://www.claudeusercontent.com/") &&
            f.text?.includes("Page 1 / " + expectedPages) &&
            f.canvases?.some(
              (c) => c.width > 100 && c.height > 100 && c.darkPixels > 500,
            ),
        )
      )
        break;
      await sleep(500);
    }
    assert.ok(
      frames.some(
        (f) =>
          f.url.startsWith("https://www.claudeusercontent.com/") &&
          f.text?.includes("Page 1 / " + expectedPages) &&
          f.canvases?.some(
            (c) => c.width > 100 && c.height > 100 && c.darkPixels > 500,
          ),
      ),
      JSON.stringify({
        error: "Official DOCX pages did not paint nonblank document content",
        frames,
        body: await page.eval("document.body.innerText"),
        logs: client
          .logSince(0)
          .filter((l) => !l.includes("debug origin"))
          .slice(-40),
      }),
    );
    const capture = process.env.CLAUDEX_E2E_DOCUMENT_CAPTURE;
    if (capture) {
      const png = await fetch(client.origin + "/__debug/capture", {
        headers: { Cookie: client.cookie },
      });
      assert.ok(png.ok);
      await writeFile(
        capture + "-" + ++captureIndex + ".png",
        Buffer.from(await png.arrayBuffer()),
      );
    }
    console.log(
      "Official DOCX rendered pages and nonblank canvases:",
      JSON.stringify(
        frames.filter((f) =>
          f.url.startsWith("https://www.claudeusercontent.com/"),
        ),
      ),
    );
  }
  await openDocument();
  console.log("Normal quit:", await client.quit(), "ms");
  client = await Client.launch();
  page = client.page(0);
  await openDocument();
  assert.equal(checksum(await readFile(source)), original);
  console.log(
    JSON.stringify({
      status: "passed",
      at: new Date().toISOString(),
      sourceSha256: original,
      restarted: true,
    }),
  );
} finally {
  if (fixture) await rm(fixture, { force: true });
  await client.stop();
}
