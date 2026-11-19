import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Client, profile, sleep } from "./harness.mjs";
const source = process.env.CLAUDEX_OFFICE_FIXTURES;
assert.ok(source);
const client = await Client.launch(),
  page = client.page(0);
const copies = [];
const mimes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
try {
  const sessions = await page.eval(
    'window["claude.web"].LocalSessions.getSessionList().then(r=>r.sessions)',
  );
  const c = sessions.find(
    (s) =>
      s.cwd?.startsWith(profile + path.sep) && !s.turnRunning && !s.isArchived,
  );
  assert.ok(c);
  for (const ext of ["docx", "pptx", "pdf", "xlsx"]) {
    const name = "office-" + randomUUID().slice(0, 8) + "." + ext,
      file = path.join(c.cwd, name);
    await fs.copyFile(path.join(source, "proof." + ext), file);
    copies.push({ ext, name, file });
  }
  await page.goto("/epitaxy/" + c.sessionId);
  await page.waitFor('!!document.querySelector("button[aria-label=Files]")');
  if (
    (await page.eval(
      'document.querySelector("button[aria-label=Files]").getAttribute("aria-pressed")',
    )) !== "true"
  )
    await page.click("button[aria-label=Files]");
  const tree = await page.eval(
    '(()=>{const b=document.querySelector("button[aria-label=\\"Show file tree\\"]");if(b){b.setAttribute("data-office-tree","");return true;}return false;})()',
  );
  if (tree) await page.click("[data-office-tree]");
  for (const f of copies) {
    await page.waitFor(
      "document.body.innerText.includes(" + JSON.stringify(f.name) + ")",
    );
    const encoded = await page.eval(
      'window["claude.web"].LocalSessions.readSessionPanelDocumentAsDataUrl(' +
        JSON.stringify(c.sessionId) +
        "," +
        JSON.stringify(f.file) +
        ")",
    );
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(encoded.split(",")[1], "base64"))
        .digest("hex"),
      createHash("sha256")
        .update(await fs.readFile(f.file))
        .digest("hex"),
    );
    await page.eval(
      '(()=>{const row=Array.from(document.querySelectorAll("[role=treeitem],button")).filter(e=>e.textContent.includes(' +
        JSON.stringify(f.name) +
        ')).sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!row)throw Error("Missing office row");document.querySelector("[data-office-file]")?.removeAttribute("data-office-file");row.setAttribute("data-office-file","");})()',
    );
    await page.click("[data-office-file]");
    let frames = [];
    let ok = false;
    for (let i = 0; i < 90; i++) {
      frames = await fetch(client.origin + "/__debug/frames", {
        headers: { Cookie: client.cookie },
      }).then((r) => r.json());
      ok = frames.some((x) =>
        f.ext === "pdf"
          ? x.nativePdf && x.shown && x.ready?.ready && x.captureBytes > 5000
          : x.url?.startsWith("https://www.claudeusercontent.com/") &&
            new URL(x.url).searchParams.get("contentType") === mimes[f.ext] &&
            (f.ext === "xlsx"
              ? x.text?.includes("Proof") &&
                x.text?.includes("Second") &&
                x.canvases?.some((c) => c.darkPixels > 500)
              : x.text?.includes("Page 1 / " + (f.ext === "docx" ? 1 : 2)) &&
                x.canvases?.some((c) => c.darkPixels > 500)),
      );
      if (ok) break;
      await sleep(500);
    }
    if (process.env.CLAUDEX_OFFICE_CAPTURE) {
      const r = await fetch(
        client.origin +
          "/__debug/capture" +
          (f.ext === "pdf" ? "?nativePdf=1" : ""),
        {
          headers: { Cookie: client.cookie },
        },
      );
      await fs.writeFile(
        process.env.CLAUDEX_OFFICE_CAPTURE + "-" + f.ext + ".png",
        Buffer.from(await r.arrayBuffer()),
      );
    }
    assert.ok(
      ok,
      JSON.stringify({
        format: f.ext,
        frames,
        body: await page.eval("document.body.innerText.slice(-1800)"),
      }),
    );
    console.log(
      JSON.stringify({
        format: f.ext,
        result: "passed",
        completedAt: new Date().toISOString(),
        frames: frames.filter(
          (x) =>
            x.nativePdf ||
            x.url?.startsWith("https://www.claudeusercontent.com/"),
        ),
      }),
    );
  }
  const pdf = copies.find((f) => f.ext === "pdf"),
    consumer = "lifecycle-" + randomUUID();
  const invoke = (p, method, ...args) =>
    p.eval(
      'window["claude.web"].' +
        method +
        "(" +
        args.map(JSON.stringify).join(",") +
        ")",
    );
  const bounds = { x: 450, y: 180, width: 500, height: 500 };
  const shown = await invoke(
    page,
    "LocalSessions.showSessionFilePreview",
    c.sessionId,
    pdf.file,
    bounds,
    consumer,
  );
  assert.ok(shown.ok);
  assert.ok(
    (
      await invoke(
        page,
        "CoworkFilePreview.whenContentReady",
        shown.loadSeq,
        consumer,
      )
    ).ready,
  );
  const other = await client.openPage();
  assert.equal(
    await invoke(other, "CoworkFilePreview.hide", consumer),
    false,
    "Another window cannot hide this consumer",
  );
  const foreign = await invoke(
    page,
    "LocalSessions.showSessionFilePreview",
    c.sessionId,
    pdf.file,
    bounds,
    consumer,
    "999999",
  );
  assert.equal(foreign.ok, false);
  const denied = await invoke(
    page,
    "LocalSessions.showSessionFilePreview",
    c.sessionId,
    "/etc/passwd.pdf",
    bounds,
    consumer + "-denied",
  );
  assert.equal(denied.ok, false);
  assert.ok(
    (
      await invoke(page, "CoworkFilePreview.parkAndCapture", bounds, consumer)
    ).startsWith("data:image/png;base64,"),
  );
  const reopened = await invoke(
    page,
    "LocalSessions.showSessionFilePreview",
    c.sessionId,
    pdf.file,
    { ...bounds, width: 450 },
    consumer,
  );
  assert.equal(reopened.loadSeq, shown.loadSeq);
  assert.equal(await invoke(page, "CoworkFilePreview.focus", consumer), true);
  assert.equal(await invoke(page, "CoworkFilePreview.hide", consumer), true);
  assert.equal(await invoke(page, "CoworkFilePreview.focus", consumer), false);
  const broken = path.join(c.cwd, "broken-" + randomUUID() + ".pdf");
  await fs.writeFile(broken, "invalid PDF");
  copies.push({ file: broken });
  assert.equal(
    (
      await invoke(
        page,
        "LocalSessions.showSessionFilePreview",
        c.sessionId,
        broken,
        bounds,
        consumer,
      )
    ).ok,
    false,
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "PDF native show/ready/park/capture/resize/reopen/focus/hide; another window cannot hide or target it; outside workspace and invalid PDF refused",
    }),
  );
} finally {
  for (const f of copies) await fs.rm(f.file, { force: true });
  await client.stop();
}
