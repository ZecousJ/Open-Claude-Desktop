import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(
  path.join(process.env.CLAUDEX_E2E_PLAYWRIGHT_ROOT, "package.json"),
);
const { chromium } = require("playwright-core");
const origin = new URL(process.argv[2]).origin;
assert.equal(
  new URL(origin).hostname,
  "127.0.0.1",
  "Use the local relay fixture.",
);
const root = path.resolve(process.argv[3] || "dist-official-web");
const out = process.env.CLAUDEX_E2E_OUTPUT;
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CLAUDEX_E2E_CHROME,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1300, height: 900 },
      colorScheme: "dark",
      locale: "zh-CN",
    });
    const page = await context.newPage();
    let release, hold, holdComposer = false, holdHistory;
    const serve = async (route) => {
      const req = route.request(),
        u = new URL(req.url());
      if (holdHistory && u.pathname.endsWith("/officialUiRead")) {
        const call = req.postDataJSON()?.args?.[0];
        if (/\/chat_conversations\/[^/?]+(?:\?|$)|\.ConversationService\/StreamTimeline$/.test(call?.path ?? ""))
          await holdHistory.promise;
      }
      if (
        req.method() !== "GET" ||
        /^\/(api|v1|edge-api|claudeai-rpc)(\/|$)/.test(u.pathname)
      )
        return route.continue();
      if (u.pathname === "/official-frame.html" && hold) await hold;
      let file = path.resolve(root, "." + u.pathname);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (path.extname(u.pathname)) return route.continue();
        file = path.join(root, "index.html");
      }
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      };
      if (u.pathname === "/official-frame.html" && holdComposer)
        return route.fulfill({
          body: fs.readFileSync(file, "utf8").replace("</head>",
            '<style id="hold-composer">[data-testid="chat-input"]{visibility:hidden!important}</style></head>'),
          contentType: "text/html",
        });
      return route.fulfill({
        path: file,
        contentType: types[path.extname(file)],
      });
    };
    await page.route(origin + "/**", serve);
    await page.goto(origin + "/login");
    await page.waitForFunction(
      () => typeof window.desktop?.loginAccount === "function",
    );
    await page.evaluate(() =>
      window.desktop.loginAccount("alice@example.test", "alice-password-1"),
    );
    await page.goto(origin + "/new");
    const frame = () => page.frameLocator(".official-web-frame");
    await frame().getByTestId("chat-input").waitFor({ timeout: 30000 });
    let chatId = await page.evaluate(async () => (await window.desktop.snapshot()).conversations.find(c => c.mode === "chat")?.id);
    if (!chatId) {
      const input = frame().getByTestId("chat-input");
      await input.fill("Startup fixture");
      await input.press("Enter");
      await frame()
        .getByText("Hello through the relay.", { exact: false })
        .first()
        .waitFor({ timeout: 30000 });
      chatId = await page.evaluate(async () => (await window.desktop.snapshot()).conversations.find(c => c.mode === "chat")?.id);
    }
    await page.evaluate(async () => {
      const s = await window.desktop.snapshot();
      await window.desktop.saveSettings(
        { ...s.settings, locale: "zh-Hans" },
        {},
      );
    });
    assert.ok(chatId);
    const chat = "/chat/" + chatId;
    hold = new Promise((r) => (release = r));
    holdHistory = Promise.withResolvers();
    await page.addInitScript(() => {
      if (window !== window.top) return;
      window.transcriptOpacities = [];
      const sample = () => {
        const frame = document.querySelector(".official-web-frame");
        const transcript = frame?.contentDocument?.querySelector('[data-testid="transcript-list"]:not([aria-busy])');
        const row = transcript?.querySelector("[data-rs-index]");
        if (row?.checkVisibility({ visibilityProperty: true })) {
          const opacity = Number(getComputedStyle(row).opacity) * Number(getComputedStyle(transcript).opacity);
          window.transcriptOpacities.push(opacity);
          if (opacity === 1) return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto(origin + chat, { waitUntil: "commit" });
    await page
      .locator("#official-home-boot")
      .waitFor({ state: "visible", timeout: 10000 });
    assert.equal(
      await page.locator("html").getAttribute("data-official-boot-route"),
      "chat",
    );
    await page.screenshot({ path: path.join(out, "chat-skeleton.png") });
    release();
    hold = undefined;
    const routeSkeleton = frame().getByTestId("conversation-loading-placeholder");
    await routeSkeleton.getByTestId("chat-message-skeleton").locator("..")
      .waitFor({ state: "visible", timeout: 30000 });
    holdHistory.resolve();
    holdHistory = undefined;
    await page.waitForFunction(() => window.transcriptOpacities.includes(1));
    const opacities = await page.evaluate(() => window.transcriptOpacities);
    assert.ok(opacities[0] < 0.45 && opacities.some(value => value > 0.45 && value < 1),
      "The conversation fades in after its skeleton: " + JSON.stringify(opacities.slice(0, 20)));
    await page.emulateMedia({ reducedMotion: "reduce" });
    holdHistory = Promise.withResolvers();
    await page.reload({ waitUntil: "commit" });
    await routeSkeleton.getByTestId("chat-message-skeleton").locator("..").waitFor({ state: "visible", timeout: 30000 });
    holdHistory.resolve();
    holdHistory = undefined;
    await page.waitForFunction(() => window.transcriptOpacities.length > 0);
    assert.deepEqual(await page.evaluate(() => window.transcriptOpacities), [1]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page
      .locator("#official-home-boot")
      .waitFor({ state: "hidden", timeout: 30000 });
    await frame().getByText("新建", { exact: true }).first().waitFor();
    const editor = frame().getByTestId("chat-input").first();
    await editor.fill("启动验收草稿");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("第二行");
    const draftBefore = (await editor.innerText()).trim();
    await page.reload({ waitUntil: "commit" });
    await page
      .locator("#official-home-boot")
      .waitFor({ state: "hidden", timeout: 30000 });
    await frame().getByTestId("chat-input").first().waitFor();
    assert.equal(
      (await frame().getByTestId("chat-input").first().innerText()).trim(),
      draftBefore,
    );
    const model = frame().getByTestId("model-selector-dropdown").first();
    await model.click();
    await frame().getByRole("menu").first().waitFor({ timeout: 5000 });
    await model.press("Escape");
    await frame()
      .getByTestId("chat-input")
      .first()
      .press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await frame().getByTestId("chat-input").first().press("Backspace");
    await page.screenshot({ path: path.join(out, "chat-ready.png") });
    holdComposer = true;
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => {
      const ready = document.documentElement.dataset.officialBootReady?.split(" ") ?? [];
      return ["sidebar", "header", "content"].every(part => ready.includes(part)) && !ready.includes("composer");
    }, { timeout: 30000 });
    assert.equal(await page.locator("#official-home-boot-rail").evaluate(el => getComputedStyle(el).visibility), "hidden");
    assert.equal(await page.locator("#official-home-boot-composer").evaluate(el => getComputedStyle(el).visibility), "visible");
    await page.screenshot({ path: path.join(out, "chat-partial.png") });
    await frame().locator("#hold-composer").evaluate(el => el.remove());
    holdComposer = false;
    await page.locator("#official-home-boot").waitFor({ state: "hidden", timeout: 30000 });

    await page.goto(origin + "/artifacts", { waitUntil: "commit" });
    await frame().getByRole("button", { name: /^(New|新建|新增)$/ }).last().click({ timeout: 30000 });
    await frame().getByRole("menu").getByRole("menuitem", { name: /^(Design|设计)$/ }).waitFor();

    for (const mobile of [true, false]) {
      const themedContext = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1300, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const themedPage = await themedContext.newPage();
      await themedPage.route(origin + "/**", serve);
      await themedPage.goto(origin + "/login");
      await themedPage.waitForFunction(() => typeof window.desktop?.loginAccount === "function");
      await themedPage.evaluate(() => window.desktop.loginAccount("alice@example.test", "alice-password-1"));
      await themedPage.goto(origin + "/new");
      await themedPage.frameLocator(".official-web-frame").getByTestId("chat-input").waitFor({ timeout: 30000 });
      await themedPage.locator("#official-home-boot").waitFor({ state: "hidden", timeout: 30000 });
      for (const system of ["light", "dark"]) {
        await themedPage.emulateMedia({ colorScheme: system });
        for (const mode of ["light", "dark", "auto"]) {
          await themedPage.frameLocator(".official-web-frame").locator("html").evaluate((el, value) => {
            localStorage.setItem("LSS-userThemeMode", JSON.stringify({ value }));
          }, mode);
          hold = new Promise(resolve => { release = resolve; });
          await themedPage.reload({ waitUntil: "commit" });
          await themedPage.locator("#official-home-boot").waitFor({ state: "visible", timeout: 10000 });
          const expected = mode === "auto" ? system : mode;
          const background = await themedPage.locator("html").evaluate(el => getComputedStyle(el).backgroundColor);
          assert.equal(background, expected === "dark" ? "rgb(25, 25, 25)" : "rgb(255, 255, 255)", `${mobile ? "phone" : "PC"} ${system}/${mode} skeleton`);
          release();
          hold = undefined;
          await themedPage.locator("#official-home-boot").waitFor({ state: "hidden", timeout: 30000 });
          assert.equal(await themedPage.frameLocator(".official-web-frame").locator("html").getAttribute("data-mode"), expected);
          console.log(JSON.stringify({ mobile, system, mode, skeletonAndUI: expected }));
        }
      }
      await themedContext.close();
    }
    console.log(
      JSON.stringify({
        chat,
        skeleton: true,
        chinese: true,
        draftRetained: true,
        modelMenu: true,
        transcriptEntrance: true,
        reducedMotion: true,
        artifactTemplateMenu: true,
        progressiveReveal: true,
        themeCases: 12,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
