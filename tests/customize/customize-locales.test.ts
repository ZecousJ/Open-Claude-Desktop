import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";

const keys = [
  "Shared with you",
  "From Claudex & Partners",
  "From marketplaces you added",
  "Loading more…",
  "Couldn’t load more.",
  "Connect this plugin’s apps before trying it in chat.",
  "That plugin is no longer available.",
  "Plugin upload is unavailable.",
  "Couldn’t load this plugin.",
];
const expectedPublisher: Record<string, string> = {
  "zh-CN": "来自 Claudex 及合作伙伴",
  "fr-FR": "De Claudex et de ses partenaires",
  "de-DE": "Von Claudex und Partnern",
  "hi-IN": "Claudex और भागीदारों की ओर से",
  "id-ID": "Dari Claudex dan Mitra",
  "it-IT": "Da Claudex e partner",
  "ja-JP": "Claudex とパートナーから",
  "ko-KR": "Claudex 및 파트너 제공",
  "pt-BR": "Da Claudex e parceiros",
  "es-419": "De Claudex y sus socios",
  "es-ES": "De Claudex y sus socios",
};
for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: Customize pagination, provenance and plugin errors load without English fallback`, async () => {
    const before = currentLocale();
    try {
      await setLocale(id);
      assert.equal(currentLocale(), id);
      for (const key of keys) {
        assert.notEqual(t(key), key, `${id}: ${key}`);
        assert.ok(t(key).trim());
        assert.equal(formatText(key), t(key));
      }
      assert.equal(t("From Claudex & Partners"), expectedPublisher[id]);
      assert.ok(t("From Claudex & Partners").includes("Claudex"));
      assert.notEqual(
        t("Couldn’t load more."),
        t("Couldn’t load this plugin."),
        "pagination failure and plugin-detail failure remain distinct",
      );
      assert.notEqual(
        t("That plugin is no longer available."),
        t("Plugin upload is unavailable."),
        "a missing plugin is different from an unavailable upload capability",
      );
    } finally {
      await setLocale(before);
    }
  });
}

test("Customize locale keys exist exactly once and reuse established loading/shared labels", () => {
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const url = new URL(`../../shared/i18n/catalogs/${id}.ts`, import.meta.url);
    const source = ts.createSourceFile(
      url.pathname,
      readFileSync(url, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const counts = new Map<string, number>();
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))
      ) {
        const key = node.name.text;
        if (keys.includes(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const key of keys) assert.equal(counts.get(key), 1, `${id}: ${key}`);
  }
});
