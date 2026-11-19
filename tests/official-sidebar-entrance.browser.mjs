import fs from "node:fs";
import assert from "node:assert/strict";
// Run with Playwright installed; optionally point to a local module and Chrome binary.
const { chromium } = await import(
  process.env.CLAUDEX_PLAYWRIGHT_MODULE ?? "playwright-core"
);
const b = await chromium.launch(
  process.env.CLAUDEX_CHROME_EXECUTABLE
    ? { executablePath: process.env.CLAUDEX_CHROME_EXECUTABLE }
    : {},
);
try {
  const html = fs.readFileSync(
    new URL("../official-frame.html", import.meta.url),
    "utf8",
  );
  const css = html.match(/<style>[\s\S]*?<\/style>/)[0],
    boot = html.match(/<script nonce[^>]*>[\s\S]*?<\/script>/)[0];

  const sidebar = (rows) => `<div data-claudex-sidebar-ready="true">
    <nav>${rows}</nav><div class="df-bottom-tray">Account</div></div>`;
  const first = '<a data-nav-item="projects" href="/projects">Projects</a>';
  const second = '<a data-nav-item="design" href="/design">Design</a>';
  const recent = '<div data-row-key="chat:example">Recent chat</div>';
  const reorder = (page, markup) =>
    page.evaluate((markup) => {
      document.querySelector("[data-claudex-sidebar-ready]").outerHTML = markup;
    }, markup);
  const animationStarts = (frame) =>
    frame.evaluate(async () => {
      await Promise.all(
        document.getAnimations().map((animation) => animation.ready),
      );
    });
  const state = (page) =>
    page
      .locator("[data-nav-item], [data-row-key], .df-bottom-tray")
      .evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((row) => [
            row.textContent,
            {
              opacity: Number(getComputedStyle(row).opacity),
              start:
                row
                  .getAnimations()
                  .find(
                    (animation) => animation.id === "claudex-sidebar-reveal",
                  )?.startTime ?? null,
            },
          ]),
        ),
      );

  for (const reducedMotion of ["no-preference", "reduce"]) {
    const page = await b.newPage({ reducedMotion });
    await page.setContent(
      `<style>html[data-official-boot-ready~="sidebar"] #official-home-boot-rail {visibility:hidden}</style>
       <div id="official-home-boot-rail">Loading</div><iframe></iframe>`,
    );
    const frame = await (
      await page.locator("iframe").elementHandle()
    ).contentFrame();
    await page.evaluate(() => {
      document.documentElement.dataset.officialHomeBoot = "";
    });
    await frame.setContent(css + boot + sidebar(first));
    // Even a slow start must leave the whole fade available when the host uncovers the frame.
    await page.waitForTimeout(300);
    assert.deepEqual((await state(frame)).Projects, {
      opacity: 1,
      start: null,
    });
    await page.evaluate(() => {
      document.documentElement.dataset.officialBootReady = "sidebar";
    });
    await animationStarts(frame);
    const initial = await state(frame);
    if (reducedMotion === "no-preference") {
      assert.notEqual(initial.Projects.start, null);
      assert.ok(initial.Projects.opacity < 0.65);
      // Remount the sidebar while the first fade is still running.
      await page.waitForTimeout(30);
      await reorder(frame, sidebar(first + second));
      await animationStarts(frame);
      const during = await state(frame);
      assert.ok(
        Math.abs(during.Projects.start - initial.Projects.start) < 0.01,
      );
      assert.ok(Math.abs(during.Account.start - initial.Account.start) < 0.01);
      assert.ok(during.Design.start > initial.Projects.start);
      assert.ok(during.Projects.opacity > during.Design.opacity);
      await frame.waitForFunction(
        () =>
          !document
            .getAnimations()
            .some((a) => a.id === "claudex-sidebar-reveal"),
      );
    }
    await page.evaluate(() => {
      delete document.documentElement.dataset.officialHomeBoot;
    });
    assert.deepEqual((await state(frame)).Projects, { opacity: 1, start: null });
    // The original also remounts the list when it replaces skeletons with recents.
    await reorder(frame, sidebar(first + second + recent));
    await animationStarts(frame);
    const after = await state(frame);
    assert.deepEqual(after.Projects, { opacity: 1, start: null });
    assert.deepEqual(after.Account, { opacity: 1, start: null });
    if (reducedMotion === "reduce") {
      assert.deepEqual(after["Recent chat"], { opacity: 1, start: null });
    } else {
      assert.deepEqual(after.Design, { opacity: 1, start: null });
      assert.notEqual(after["Recent chat"].start, null);
      assert.ok(after["Recent chat"].opacity < 1);
      await frame.waitForFunction(
        () =>
          !document
            .getAnimations()
            .some((a) => a.id === "claudex-sidebar-reveal"),
      );
      assert.deepEqual((await state(frame))["Recent chat"], {
        opacity: 1,
        start: null,
      });
    }
    console.log(`Sidebar batches passed with reduced motion: ${reducedMotion}`);
    await page.close();
  }
} finally {
  await b.close();
}
