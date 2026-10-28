import test from "node:test";
import assert from "node:assert/strict";
import { locales, sourceLocale } from "../../shared/locales";
import { navBadgeLabel, type NavBadge } from "../../src/sidebar/navItems";

// The navigation's accessible name is "{label}, <badge>"; the sentence for
// every badge the rows can carry is in each catalog.
const badges: NavBadge[] = ["beta", "ant", "lab", "preview", "new"];

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale))
  test(`${id}: the navigation names every badge, without the vendor's name`, async () => {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    for (const badge of badges) {
      const key = `{label}, ${navBadgeLabel(badge)}`;
      assert.equal(typeof catalog[key], "string", key);
      assert.ok(catalog[key].includes("{label}"), key);
      assert.ok(!/Anthropic/.test(catalog[key]), key);
    }
  });
