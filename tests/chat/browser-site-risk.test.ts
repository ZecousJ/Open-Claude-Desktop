import test from "node:test";
import assert from "node:assert/strict";
import { SiteRiskChecks } from "../../electron/browser/site-risk";
import { siteQuestion } from "../../electron/browser/browser-tool-questions";

test("browser site risk is decided on this computer and cached by origin", async () => {
  // No address leaves the computer: the check takes no request function and
  // never asks a classification service.
  const originalFetch = globalThis.fetch;
  let requested = 0;
  globalThis.fetch = (async () => {
    requested++;
    return new Response("{}");
  }) as typeof fetch;
  try {
    const checks = new SiteRiskChecks();
    assert.equal(await checks.check("https://example.com/path"), undefined);
    assert.equal(await checks.check("https://example.com/other"), undefined);
    assert.equal(await checks.check("https://chase.com"), "financial");
    assert.equal(requested, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("financial and high-risk browser questions use verified safety notes", async () => {
  const checks = new SiteRiskChecks();
  assert.equal(await checks.check("https://chase.com"), "financial");
  assert.match(
    siteQuestion("https://chase.com", true, "financial").message,
    /won’t purchase, transfer funds, or enter payment details without your input/,
  );
  assert.match(
    siteQuestion("https://example.com", false, "high-risk").message,
    /asks before each visit/,
  );
});

test("private network URLs count as high risk", async () => {
  const checks = new SiteRiskChecks();
  assert.equal(await checks.check("http://192.168.1.20/private"), "high-risk");
  assert.equal(await checks.check("http://printer.local/"), "high-risk");
});
