import test from "node:test";
import assert from "node:assert/strict";
import { locales, sourceLocale } from "../../shared/locales";
import { connectorCategoryGroups } from "../../src/settings/directory/connector-categories";

// The category menu of the connector directory shows these labels as they are.
const labels = [
  ...new Set(
    connectorCategoryGroups().flatMap((group) =>
      group.categories.map((category) => category.label),
    ),
  ),
];

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale))
  test(`${id}: every connector category label has a translation`, async () => {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    assert.ok(labels.length > 100);
    const missing = labels.filter((label) => !Object.hasOwn(catalog, label));
    assert.deepEqual(missing, []);
  });
