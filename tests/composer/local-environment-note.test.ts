import test from "node:test";
import assert from "node:assert/strict";
import { locales, sourceLocale } from "../../shared/locales";

const note =
  "In <a>.env format</a>. These are stored securely and passed to Claudex sessions.";

// The note under the local environment field is one sentence with its link
// marked <a>…</a>, so each language puts the link where it belongs.
for (const { id } of locales.filter((locale) => locale.id !== sourceLocale))
  test(`${id}: the local environment note keeps its link markers`, async () => {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    const text = catalog[note];
    assert.ok(text, "has a translation");
    assert.equal(text.split("<a>").length, 2);
    assert.ok(text.indexOf("<a>") < text.indexOf("</a>"));
    assert.ok(!/[Aa]nthropic|Claude(?!x)/.test(text));
  });
