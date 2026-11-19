import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(
  path.join(process.env.CLAUDEX_E2E_PLAYWRIGHT_ROOT, "package.json"),
);
const { chromium } = require("playwright-core");
const [origin, source = "-"] = process.argv.slice(2);
const dir = process.env.CLAUDEX_E2E_OUTPUT;
fs.mkdirSync(dir, { recursive: true });
const expected = [
  "projects",
  "artifacts",
  "scheduled",
  "claudex-api",
  "claudex-service-status",
  "design",
  "customize",
];
const bootstrap = (req) =>
  new URL(req.url()).pathname.endsWith("/officialUiRead") &&
  /^(?:\/edge-api|\/api)\/bootstrap(?:[/?]|$)/.test(
    req.postDataJSON()?.args?.[0]?.path || "",
  );
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CLAUDEX_E2E_CHROME,
    args: ["--disable-background-networking"],
  });
  try {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      viewport: { width: 1300, height: 900 },
    });
    const page = await context.newPage();
    let gate;
    let frameGate;
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(origin + "/**", async (route) => {
      const req = route.request(),
        u = new URL(req.url());
      if (gate && bootstrap(req)) await gate.promise;
      if (frameGate && u.pathname === "/official-frame.html")
        await frameGate.promise;
      if (
        source === "-" ||
        req.method() !== "GET" ||
        /^\/(?:api|v1|edge-api|claudeai-rpc|admin)(?:\/|$)/.test(u.pathname)
      )
        return route.continue();
      let target = path.resolve(source, "." + u.pathname);
      if (target === source || !fs.existsSync(target)) {
        if (path.extname(u.pathname)) return route.continue();
        target = path.join(source, "index.html");
      }
      const mime = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      };
      await route.fulfill({
        path: target,
        contentType: mime[path.extname(target)],
      });
    });
    await page.goto(origin + "/login", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => typeof window.desktop?.loginAccount === "function",
    );
    assert.equal(
      await page.evaluate(
        async ({ email, password }) => {
          try {
            await window.desktop.loginAccount(email, password);
            return "ok";
          } catch (e) {
            return String(e.code || e.message);
          }
        },
        {
          email: process.env.CLAUDEX_E2E_EMAIL ?? "alice@example.test",
          password: process.env.CLAUDEX_E2E_PASSWORD_FILE
            ? fs
                .readFileSync(process.env.CLAUDEX_E2E_PASSWORD_FILE, "utf8")
                .trim()
            : "alice-password-1",
        },
      ),
      "ok",
    );
    await page.waitForFunction(
      () =>
        !!sessionStorage.getItem("claudex-web-account") ||
        !!localStorage.getItem("claudex-web-last-account"),
    );
    await page.goto(origin + "/new", { waitUntil: "domcontentloaded" });
    const frame = () => page.frameLocator(".official-web-frame");
    await frame()
      .getByTestId("user-menu-button")
      .first()
      .waitFor({ timeout: 40000 });
    const chat =
      process.env.CLAUDEX_E2E_CHAT_PATH ??
      (await frame()
        .locator('a[href^="/chat/"]')
        .first()
        .getAttribute("href", { timeout: 20000 }));
    assert.ok(chat);
    await context.addInitScript(() => {
      if (window !== top) return;
      window.__startupStates = [];
      let last = "";
      const shown = (n) =>
        !!n && n.checkVisibility({ visibilityProperty: true });
      const font = (n) => {
        if (!shown(n)) return null;
        const s = n.ownerDocument.defaultView.getComputedStyle(n),
          r = n.getBoundingClientRect();
        return {
          loaded: n.ownerDocument.fonts.check("500 20px anthropic-serif"),
          family: s.fontFamily,
          size: s.fontSize,
          weight: s.fontWeight,
          variation: s.fontVariationSettings,
          features: s.fontFeatureSettings,
          optical: s.fontOpticalSizing,
          color: s.color,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      };
      const tick = () => {
        const root = document.querySelector(
          ".official-web-frame",
        )?.contentDocument;
        const shell = shown(document.getElementById("official-home-boot"));
        const footer = root?.querySelector('[data-testid="user-menu-button"]');
        const nav =
          !shell && root
            ? [...root.querySelectorAll("[data-nav-item]")]
                .filter(shown)
                .map((n) => n.getAttribute("data-nav-item"))
            : [];
        const composer = shell
          ? document.getElementById("official-home-boot-composer")
          : root
              ?.querySelector('[data-testid="chat-input"]')
              ?.closest(".rounded-composer");
        const composerRect = shown(composer)
          ? composer.getBoundingClientRect()
          : null;
        const state = {
          composer: composerRect && {
            x: composerRect.x,
            y: composerRect.y,
            width: composerRect.width,
            height: composerRect.height,
          },
          shell,
          nav,
          footer:
            !shell && shown(footer)
              ? {
                  y: footer.getBoundingClientRect().y,
                  text: footer.textContent.trim(),
                }
              : null,
          brand: font(
            shell
              ? document.getElementById("official-home-boot-wordmark")
              : root?.querySelector('[data-app-wordmark="claude"] span'),
          ),
          ready: root
            ?.querySelector("[data-claudex-sidebar-ready]")
            ?.getAttribute("data-claudex-sidebar-ready"),
        };
        const json = JSON.stringify(state);
        if (json !== last) {
          last = json;
          window.__startupStates.push(state);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const results = [];
    for (const [route, height] of [
      ["/new", 900],
      ["/artifacts", 900],
      [chat, 900],
      ["/new", 600],
    ]) {
      await page.setViewportSize({ width: 1300, height });
      gate = Promise.withResolvers();
      frameGate = route === "/new" ? Promise.withResolvers() : undefined;
      const started = page.waitForRequest(bootstrap, { timeout: 30000 });
      await page.goto(origin + route, { waitUntil: "commit" });
      if (frameGate) {
        await page.locator("#official-home-boot-wordmark").waitFor();
        await page.evaluate(() =>
          document.fonts.load("500 20px anthropic-serif", "Claudex"),
        );
        await page.screenshot({
          path: path.join(dir, "sidebar-new-shell-" + height + ".png"),
        });
        frameGate.resolve();
        frameGate = undefined;
      }
      await started;
      await page.screenshot({
        path:
          dir +
          "/sidebar-" +
          (route === "/new"
            ? "new"
            : route === "/artifacts"
              ? "artifacts"
              : "chat") +
          "-pending-" +
          height +
          ".png",
      });
      gate.resolve();
      gate = undefined;
      await frame()
        .locator('[data-claudex-sidebar-ready="true"]')
        .waitFor({ state: "attached", timeout: 40000 });
      await frame()
        .locator('[data-nav-item="claudex-service-status"]')
        .first()
        .waitFor({ timeout: 40000 });
      await frame()
        .getByTestId("user-menu-button")
        .first()
        .waitFor({ timeout: 40000 });
      await page
        .locator("#official-home-boot")
        .waitFor({ state: "hidden", timeout: 40000 });
      await page.screenshot({
        path:
          dir +
          "/sidebar-" +
          (route === "/new"
            ? "new"
            : route === "/artifacts"
              ? "artifacts"
              : "chat") +
          "-ready-" +
          height +
          ".png",
      });
      const states = await page.evaluate(() => window.__startupStates);
      results.push({ route, height, states });
      fs.writeFileSync(
        dir + "/sidebar-layout-proof.json",
        JSON.stringify({ results, errors }, null, 2),
      );
      const first = states.find((s) => s.nav.length);
      assert.ok(first, route + " nav");
      assert.ok(
        expected.every(
          (id) => first.nav.includes(id) || first.nav.includes(id + "-chorus"),
        ),
        JSON.stringify(first),
      );
      assert.ok(
        states.every((s) => s.shell || !s.brand || s.brand.loaded),
        "original wordmark font is loaded before first display",
      );
      if (route === "/new") {
        const shellComposer = states.find(
          (s) => s.shell && s.composer,
        )?.composer;
        const originalComposer = states.find(
          (s) => !s.shell && s.composer,
        )?.composer;
        assert.ok(shellComposer && originalComposer, "both composers rendered");
        for (const property of ["x", "y", "width", "height"])
          assert.ok(
            Math.abs(shellComposer[property] - originalComposer[property]) < 1,
            `${property}: ${JSON.stringify({ shellComposer, originalComposer })}`,
          );
        const shellBrand = states.find(
          (s) => s.shell && s.brand?.loaded,
        )?.brand;
        const originalBrand = states.find(
          (s) => !s.shell && s.brand?.loaded,
        )?.brand;
        assert.ok(shellBrand && originalBrand, "both wordmarks rendered");
        for (const property of [
          "size",
          "weight",
          "variation",
          "features",
          "optical",
          "color",
          "x",
          "y",
        ])
          assert.equal(shellBrand[property], originalBrand[property], property);
        assert.ok(originalBrand.family.includes("anthropic-serif"));
        assert.ok(shellBrand.family.includes("anthropic-serif"));
        assert.ok(
          Math.abs(shellBrand.width - originalBrand.width) < 1,
          "wordmark width stays fixed",
        );
      }
      assert.ok(
        states.every((s) => !s.footer || s.footer.y > height - 200),
        "footer never collapses to top",
      );
      assert.ok(
        states.every((s) => !s.footer || s.nav.length > 0),
        "footer and nav appear together",
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ routes: results.map((r) => r.route), errors }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
