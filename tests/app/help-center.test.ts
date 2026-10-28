import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  configureHelpOrigin,
  helpSlugs,
  helpUrl,
} from "../../shared/help-links";
import { DEFAULT_TRUSTED_DOMAINS } from "../../shared/cloud-network-domains";
import { DEFAULT_TRUSTED_DOMAINS as runnerDomains } from "../../runner/src/net-policy";
import { defaultLocale, locales } from "../../shared/locales";
import { helpArticles } from "../../src/help/articles";
import { HelpPage } from "../../src/help/HelpPage";
import { setLocale } from "../../src/i18n";
import { formatWebRoute, parseWebRoute, siteZone } from "../../src/web/routes";

test("help links use the service origin, never its API path", () => {
  assert.equal(helpUrl("support"), "/help/support");
  assert.equal(
    helpUrl("memory", "https://service.example/api/v1"),
    "https://service.example/help/memory",
  );
  configureHelpOrigin("https://configured.example/api");
  assert.equal(helpUrl("support"), "https://configured.example/help/support");
  configureHelpOrigin("https://claudex.example.com");
});

test("every help target has a public route and an article", () => {
  assert.deepEqual(parseWebRoute("/help/"), { kind: "help" });
  assert.equal(formatWebRoute({ kind: "help" }), "/help");
  assert.deepEqual(
    helpArticles.map((article) => article.slug),
    [...helpSlugs],
  );
  for (const slug of helpSlugs) {
    const url = `/help/${slug}`;
    assert.equal(siteZone(url), "app");
    assert.deepEqual(parseWebRoute(url), { kind: "help", slug });
    assert.equal(formatWebRoute({ kind: "help", slug }), url);
  }
  assert.equal(parseWebRoute("/help/support/extra").kind, "not-found");
  assert.equal(defaultLocale, "zh-CN");
  assert.strictEqual(DEFAULT_TRUSTED_DOMAINS, runnerDomains);
});

test("public help renders translated articles, live domain defaults and a useful missing page", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  const render = (pathname: string) => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        pathname,
        search: "",
        origin: "https://claudex.example.com",
        protocol: "https:",
      },
    });
    return renderToStaticMarkup(createElement(HelpPage));
  };
  try {
    await setLocale("zh-CN");
    const index = render("/help");
    assert.match(index, /Claudex 帮助中心/);
    for (const slug of helpSlugs) assert.ok(index.includes(`/help/${slug}`));
    for (const article of helpArticles) {
      const html = render(`/help/${article.slug}`);
      assert.match(html, /<article>/);
      assert.ok(!html.includes(article.body));
      assert.doesNotMatch(html, /\bClaude\b|Anthropic|claude\.ai|\bofficial\b/);
    }
    const domains = render("/help/cloud-environments");
    for (const domain of DEFAULT_TRUSTED_DOMAINS)
      assert.ok(domains.includes(`<code>${domain}</code>`));
    await setLocale("en-US");
    assert.match(render("/help/no-such-article"), /Page not found/);
    assert.match(render("/help/support"), /service administrator/);
    const main = readFileSync("src/main.tsx", "utf8");
    assert.match(main, /lazyPiece\(\(\) => import\("\.\/help\/HelpPage"\)/);
    assert.ok(main.indexOf("{helpPage ?") < main.indexOf("<AuthGate />"));
    for (const locale of locales.filter((entry) => entry.id !== "en-US")) {
      await setLocale(locale.id);
      for (const article of helpArticles)
        assert.ok(
          !render(`/help/${article.slug}`).includes(article.body),
          `${locale.id}: ${article.slug}`,
        );
    }
  } finally {
    await setLocale("en-US");
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("renderer and shared code never direct people to vendor pages", () => {
  const excluded = new Set([
    "shared/design-pdf.ts",
    "src/cowork/prompt-links.ts",
  ]);
  const violations: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name);
      if (file === "shared/i18n/catalogs" || excluded.has(file)) continue;
      if (entry.isDirectory()) visit(file);
      else if (/\.(tsx?|css|html|json)$/.test(file)) {
        const text = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (
          /(?:https?:)?\/\/(?:[\w-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)(?=[/\s"'`?#]|$)/i.test(
            text,
          )
        )
          violations.push(file);
      }
    }
  };
  for (const directory of ["src", "src-web", "shared"]) visit(directory);
  assert.deepEqual(violations, []);
});
