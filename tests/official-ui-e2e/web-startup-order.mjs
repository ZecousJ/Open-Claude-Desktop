import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const origin = new URL(process.argv[2]);
assert.equal(
  origin.hostname,
  "127.0.0.1",
  "Use the local relay smoke fixture.",
);
const requirePlaywright = createRequire(
  path.join(process.env.CLAUDEX_E2E_PLAYWRIGHT_ROOT, "package.json"),
);
const { chromium } = requirePlaywright("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CLAUDEX_E2E_CHROME,
  args: ["--disable-background-networking"],
});

const rpc = "/api/v1/claudex/web/rpc/officialUiRead";
const memory = /\/users\/me\/memory\?repo=cowork$/;
const timeout = 15_000;
try {
  const context = await browser.newContext({ colorScheme: "dark" });
  const login = await context.request.post(
    new URL("/api/v1/claudex/web/auth/login", origin).href,
    { data: { email: "alice@example.test", password: "alice-password-1" } },
  );
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const release = Promise.withResolvers();
  const isMemory = (request) =>
    new URL(request.url()).pathname === rpc &&
    memory.test(request.postDataJSON()?.args?.[0]?.path);
  await page.route("**" + rpc, async (route) => {
    if (isMemory(route.request())) await release.promise;
    await route.continue();
  });

  const memoryReplied = page.waitForResponse(
    (response) => isMemory(response.request()),
    { timeout: timeout * 2 },
  );
  try {
    await Promise.all([
      page.waitForRequest(isMemory, { timeout }),
      page.goto(new URL("/new", origin).href, { waitUntil: "commit" }),
    ]);
    const frame = page.frameLocator(".official-web-frame");
    const editor = frame.locator('[contenteditable="true"]').first();
    await frame.getByTestId("user-menu-button").waitFor({ timeout });
    await editor.waitFor({ timeout });
    await editor.fill("Startup order draft");
    assert.match(await editor.innerText(), /Startup order draft/);
  } finally {
    release.resolve();
    await memoryReplied.catch(() => {});
  }
  assert.deepEqual(errors, []);
  console.log(
    "Chat sidebar and editable composer rendered while the Cowork memory request was held.",
  );
} finally {
  await browser.close();
}
