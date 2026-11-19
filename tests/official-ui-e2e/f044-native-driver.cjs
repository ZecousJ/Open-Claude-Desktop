const { chromium } = require(process.env.F044_PLAYWRIGHT || "playwright-core");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const elicitation = process.argv.includes("--elicitation");

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f044-native-"));
  const profile = path.join(temp, "profile"), fixture = path.join(temp, "fixture.cjs");
  const route = "/epitaxy/local_8cfc6561-4d86-4efa-8e94-72a293f83a45";
  let child, browser, page, log = "";
  await build({ entryPoints: ["tests/official-ui-e2e/f044-native-fixture.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: fixture, logLevel: "warning" });
  async function launch() {
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
    child = spawn(process.env.F044_ELECTRON || path.resolve("node_modules/.bin/electron"), [fixture], { env: { ...process.env, CLAUDEX_F044_PROFILE: profile, CLAUDEX_F044_CDP_PORT: String(port), CLAUDEX_F044_TEST_ELICITATION: elicitation ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => { log += data; });
    child.stderr.on("data", data => { log += data; });
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null) throw Error("Fixture exited: " + log.slice(-3000));
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!browser) throw Error("Fixture did not start: " + log.slice(-3000));
    const context = browser.contexts()[0];
    for (let i = 0; i < 120 && !context.pages().length; i++) await new Promise(resolve => setTimeout(resolve, 250));
    page = context.pages()[0];
    await page.waitForURL(url => url.pathname === route, { timeout: 60000 });
    if (!elicitation)
      await page.getByRole("button", { name: "Add", exact: true }).waitFor({ timeout: 60000 });
  }
  async function menu(expected) {
    if (!(await page.getByRole("menuitem", { name: /Connectors/ }).isVisible()))
      await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Connectors/ }).hover();
    const item = page.getByRole("menuitemcheckbox", { name: /fixture_connector/ });
    await item.waitFor();
    await page.waitForFunction(expected => document.querySelector('[role="menuitemcheckbox"][aria-checked="' + expected + '"]')?.textContent.includes("fixture_connector"), String(expected));
    return item;
  }
  async function quit() {
    await page.evaluate(() => fetch("/__debug/quit", { method: "POST" }));
    await new Promise((resolve, reject) => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => reject(Error("Fixture did not quit")), 15000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    await browser.close().catch(() => {});
    browser = undefined; child = undefined;
  }
  async function waitStored(expected) {
    for (let i = 0; i < 150; i++) {
      const value = JSON.parse(fs.readFileSync(path.join(profile, "conversations.json"), "utf8"))[0].connectorOverrides?.fixture_connector;
      if (value === expected) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "conversations.json"), "utf8"))[0].connectorOverrides?.fixture_connector, expected);
  }
  async function answerElicitations() {
    const form = page.getByTestId("epitaxy-elicitation-form");
    await form.waitFor();
    await form.getByRole("textbox", { name: "Project name" }).fill("Project F044");
    await form.getByRole("spinbutton", { name: "Number of copies" }).fill("3");
    await form.getByRole("checkbox", { name: "Include drafts" }).press("Space");
    await page.getByRole("checkbox", { name: "Include drafts", checked: true }).waitFor();
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    const link = page.getByTestId("epitaxy-elicitation-link");
    await link.waitFor();
    const url = "https://example.com/f044-connect";
    assert.ok((await link.textContent()).includes(url));
    const receipts = () => JSON.parse(fs.readFileSync(path.join(profile, "elicitation-responses.json"), "utf8"));
    const formResponse = { id: 1, response: { action: "accept", content: { project: "Project F044", copies: 3, includeDrafts: true }, _meta: null } };
    assert.deepEqual(receipts(), [formResponse]);

    await page.evaluate(() => { window.open = href => { window.fixtureOpenedUrl = href; return null; }; });
    const approvalClickGraceMs = 450;
    await page.waitForTimeout(approvalClickGraceMs);
    await page.getByRole("button", { name: "Open link", exact: true }).click();
    await page.waitForFunction(expected => window.fixtureOpenedUrl === expected, url);
    await page.getByRole("button", { name: "I’m done, continue", exact: true }).click();
    await link.waitFor({ state: "detached" });
    assert.deepEqual(receipts(), [formResponse, { id: 2, response: { action: "accept", content: null, _meta: null } }]);
    console.log("PASS: Original Code form and link controls delivered typed MCP responses.");
  }
  try {
    await launch();
    if (elicitation) return await answerElicitations();
    const item = await menu(true);
    await item.click();
    await page.waitForFunction(() => window["claude.web"].LocalSessions.getSession("local_8cfc6561-4d86-4efa-8e94-72a293f83a45").then(s => Object.entries(s.enabledMcpTools || {}).some(([key, value]) => key.endsWith(":fixture_lookup") && value === false)));
    await waitStored(false);
    await menu(false);
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add", exact: true }).waitFor({ timeout: 60000 });
    await menu(false);
    await quit();
    await launch();
    const disabled = await menu(false);
    await disabled.click();
    await page.waitForFunction(() => window["claude.web"].LocalSessions.getSession("local_8cfc6561-4d86-4efa-8e94-72a293f83a45").then(s => Object.entries(s.enabledMcpTools || {}).some(([key, value]) => key.endsWith(":fixture_lookup") && value === true)));
    await waitStored(true);
    await menu(true);
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add", exact: true }).waitFor({ timeout: 60000 });
    await menu(true);
    console.log("PASS: Original Code connector menu retains off through reload and restart, then retains re-enabled state through reload.");
  } catch (error) {
    if (page && elicitation) console.error("Approval cards:", await page.locator("[data-approval-card-root]").allTextContents().catch(() => []));
    if (page) console.error("Menu state:", await page.locator('[role="menuitemcheckbox"]').evaluateAll(rows => rows.map(row => ({ text: row.textContent, checked: row.getAttribute("aria-checked") }))).catch(() => []));
    if (page) console.error("Session:", await page.evaluate(() => window["claude.web"].LocalSessions.getSession("local_8cfc6561-4d86-4efa-8e94-72a293f83a45")).catch(() => null));
    console.error(log.slice(-3000));
    throw error;
  } finally {
    if (child) await quit().catch(() => { child?.kill(); });
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
