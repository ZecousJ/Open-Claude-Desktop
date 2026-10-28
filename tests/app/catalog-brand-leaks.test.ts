import test from "node:test";
import assert from "node:assert/strict";
import { locales, sourceLocale } from "../../shared/locales";

// A text written for Claudex is translated as Claudex: a value does not
// name the product Claude, or the vendor, when its English key does not.
const named = /Claude(?!x)|claude\.ai|Anthropic/;

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale))
  test(`${id}: a translation does not rename the product`, async () => {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    const leaks = Object.entries(catalog)
      .filter(([key, value]) => !named.test(key) && named.test(value))
      .map(([key]) => key);
    assert.deepEqual(leaks, []);
  });
