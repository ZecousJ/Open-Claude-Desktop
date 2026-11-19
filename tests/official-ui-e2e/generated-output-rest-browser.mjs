import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function verifyOriginalRestChat({
  origin,
  prompt,
  fileText,
  shellText,
  reopen,
}) {
  const { chromium } = require(process.env.CLAUDEX_F019_PLAYWRIGHT);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CLAUDEX_F019_CHROMIUM,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname !== "/edge-api/bootstrap") return route.continue();

      // The pinned frontend's Hub default selects classic Chat when off.
      const response = await route.fetch();
      const bootstrap = await response.json();
      for (const key of ["growthbook", "org_growthbook"])
        bootstrap[key].features["1174351393"] = { defaultValue: false };
      return route.fulfill({ response, json: bootstrap });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const submissions = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        request.method() === "POST" &&
        /\/(completion|PerformAction)$/.test(pathname)
      )
        submissions.push(pathname);
    });
    const verifyFiles = async () => {
      await page
        .getByRole("button", { name: "View Notes", exact: true })
        .click();
      await page.getByText(shellText.trimEnd(), { exact: true }).waitFor();
      for (const [label, name, content] of [
        ["Notes", "notes.txt", shellText],
        ["Report", "report.md", fileText],
      ]) {
        const button = page.getByRole("button", {
          name: `Download ${label}`,
          exact: true,
        });
        await page
          .getByRole("button", { name: `View ${label}`, exact: true })
          .hover();
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          button.click(),
        ]);
        assert.equal(download.suggestedFilename(), name);
        assert.deepEqual(
          fs.readFileSync(await download.path()),
          Buffer.from(content),
        );
      }
    };
    const verifyArtifact = async () => {
      await page
        .getByText("Inline report 中文", { exact: true })
        .last()
        .waitFor();
      await page.getByRole("button", { name: "REST report" }).waitFor();
    };

    await page.goto(origin + "/new");
    await page.getByText("gpt-5.2-codex", { exact: true }).first().waitFor();
    await page.locator("[contenteditable=true]").first().fill(prompt);
    const pending = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/completion"),
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const response = await pending;
    const request = response.request().postDataJSON();
    assert.equal(response.status(), 200, JSON.stringify(request));
    assert.match(response.headers()["content-type"], /^text\/event-stream/);
    assert.deepEqual(request.tools ?? [], []);

    await verifyArtifact();
    await verifyFiles();
    const chatPath = new URL(page.url()).pathname;
    const conversation = chatPath.split("/").at(-1);
    await reopen(conversation);
    const pendingHistory = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname.endsWith(
          "/chat_conversations/" + conversation,
        ),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const history = await pendingHistory;
    assert.equal(history.status(), 200);
    const saved = await history.json();
    assert.equal(
      saved.current_leaf_message_uuid,
      request.turn_message_uuids.assistant_message_uuid,
    );
    await verifyArtifact();
    await verifyFiles();
    assert.deepEqual(submissions, [new URL(response.url()).pathname]);
  } finally {
    await browser.close();
  }
}
