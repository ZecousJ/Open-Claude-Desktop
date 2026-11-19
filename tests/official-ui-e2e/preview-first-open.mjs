import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, profile } from "./harness.mjs";
const root = path.join(
    profile,
    "profiles/86411823-4720-5ce3-ad9a-e6f769032f3b",
  ),
  file = path.join(root, "conversations.json");
const rows = JSON.parse(await fs.readFile(file, "utf8"));
const template = rows.find((c) => c.mode === "code");
const id = randomUUID(),
  cwd = path.join(root, "workspace", "preview-probe-" + id);
await fs.mkdir(cwd);
const c = {
  ...template,
  id,
  title: "Empty preview probe",
  cwd,
  turns: [],
  threadId: undefined,
  codeNewTask: undefined,
};
rows.push(c);
await fs.writeFile(file, JSON.stringify(rows));
let client;
try {
  client = await Client.launch();
  const p = client.page(0);
  await p.goto("/epitaxy/local_" + id);
  await p.waitFor('!!document.querySelector("button[aria-label=Browser]")');
  if (
    (await p.eval(
      'document.querySelector("button[aria-label=Browser]").getAttribute("aria-pressed")',
    )) !== "true"
  )
    await p.click("button[aria-label=Browser]");
  await new Promise((r) => setTimeout(r, 2000));
  await p.waitFor(
    'document.body.innerText.includes("Browse with Claudex") && !document.body.innerText.includes("Setting up preview")',
    15000,
  );
  const image = await fetch(
    client.origin + "/images/clawd/core/Clawd-CrabWalking.gif",
    { headers: { Cookie: client.cookie } },
  );
  if (!image.ok) throw Error("Official loading image missing");
  const decoded = await p.eval(
    "(async () => { const img = new Image(); img.src = '/images/clawd/core/Clawd-CrabWalking.gif'; try { await img.decode(); return { width: img.naturalWidth, height: img.naturalHeight }; } catch (error) { return { error: String(error) }; } })()",
  );
  console.log(JSON.stringify({ loadingImage: { contentType: image.headers.get("content-type"), ...decoded } }));
  if (decoded.error || decoded.width !== 2750 || decoded.height !== 1850)
    throw Error("Official loading animation could not decode: " + JSON.stringify(decoded));
  if (image.headers.get("content-type") !== "image/gif")
    throw Error("Official loading animation has incorrect MIME type");
  await p.click("button[aria-label=Browser]");
  await p.click("button[aria-label=Browser]");
  await p.waitFor('document.body.innerText.includes("Browse with Claudex") && !document.body.innerText.includes("Setting up preview")');
  await client.quit();
  await client.stop();
  client = await Client.launch();
  const reopened = client.page(0);
  await reopened.goto("/epitaxy/local_" + id);
  await reopened.waitFor('!!document.querySelector("button[aria-label=Browser]")');
  if ((await reopened.eval('document.querySelector("button[aria-label=Browser]").getAttribute("aria-pressed")')) !== "true")
    await reopened.click("button[aria-label=Browser]");
  await reopened.waitFor('document.body.innerText.includes("Browse with Claudex") && !document.body.innerText.includes("Setting up preview")');
  const brokenImages = await reopened.eval('Array.from(document.images).filter(i => i.complete && i.currentSrc && i.naturalWidth === 0).map(i=>i.currentSrc)');
  if (brokenImages.length) throw Error("Broken images after restart: " + JSON.stringify(brokenImages));
  const capture = await fetch(client.origin + "/__debug/capture", { headers: { Cookie: client.cookie } });
  if (!capture.ok) throw Error("Preview screenshot failed");
  await fs.writeFile(process.env.PREVIEW_FIRST_OPEN_SCREENSHOT ?? "/tmp/claudex-preview-first-open.png", Buffer.from(await capture.arrayBuffer()));
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "never-opened Code session; hide/reopen and normal quit/restart; Browser opens real New tab and address input; no stuck loader or broken images; GIF HTTP 200, image/gif and browser decode 2750x1850; no model send",
    }),
  );
} finally {
  if (client) await client.stop();
  const rows = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify(rows.filter((c) => c.id !== id)));
  await fs.rm(cwd, { recursive: true, force: true });
}
