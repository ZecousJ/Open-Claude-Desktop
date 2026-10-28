import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";

const keys = [
  "Comments aren’t available for this artifact.",
  "Commenting isn’t available with view-only access.",
  "View comments",
  "Done viewing",
  "Loading comments…",
  "View instructions",
  "Project instructions are read-only.",
  "Loading project options…",
  "Couldn’t load project options. Try again.",
  "Failed to prepare project context. You can try again.",
  "Project context already exists.",
  "optional",
  "Add context",
  "Upload files",
  "Choose how to read this file",
  "The text encoding for {fileName} could not be determined. Choose an encoding and verify with the preview.",
  "Select file encoding",
  "File preview",
  "Default (UTF-8)",
  "Western European (Windows-1252)",
  "Central European (Windows-1250)",
  "Cyrillic (Windows-1251)",
  "Latin-1 (ISO-8859-1)",
  "Japanese (Shift_JIS)",
  "Chinese (GB18030)",
  "Korean (EUC-KR)",
  "Arabic (Windows-1256)",
  "Turkish (Windows-1254)",
  "Greek (Windows-1253)",
  "Thai (TIS-620)",
  "Document extraction was interrupted. Retry this file.",
  "Choose a supported file encoding.",
  "This document needs text extraction.",
  "This pending file changed. Upload it again.",
  "This file is already being read. Try again when it finishes.",
  "You do not have permission to edit this project's context.",
];
const encodingLabels = [
  "Default (UTF-8)",
  "Western European (Windows-1252)",
  "Central European (Windows-1250)",
  "Cyrillic (Windows-1251)",
  "Latin-1 (ISO-8859-1)",
  "Japanese (Shift_JIS)",
  "Chinese (GB18030)",
  "Korean (EUC-KR)",
  "Arabic (Windows-1256)",
  "Turkish (Windows-1254)",
  "Greek (Windows-1253)",
  "Thai (TIS-620)",
];
const encodingPrompt =
  "The text encoding for {fileName} could not be determined. Choose an encoding and verify with the preview.";
const expectedInstructions: Record<string, string> = {
  "zh-CN": "查看指令",
  "fr-FR": "Voir les instructions",
  "de-DE": "Anweisungen ansehen",
  "hi-IN": "निर्देश देखें",
  "id-ID": "Lihat instruksi",
  "it-IT": "Visualizza istruzioni",
  "ja-JP": "指示を表示",
  "ko-KR": "지침 보기",
  "pt-BR": "Ver instruções",
  "es-419": "Ver instrucciones",
  "es-ES": "Ver instrucciones",
};
const reusedKeys = [
  "Project instructions",
  "Context",
  "Creating project…",
  "No access",
  "Remove {fileName}",
  "No artifacts matching “{search}”",
  "“{spaceName}” will be deleted. Its chats stay in your history, outside any project.",
];
const relatedSessionTemplates = [
  "{action} · {count} session here",
  "{action} · {count} sessions here",
];

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: artifact access and project instructions load actual translated labels`, async () => {
    const previous = currentLocale();
    try {
      await setLocale(id);
      assert.equal(currentLocale(), id);
      for (const key of keys) {
        if (
          !(id === "de-DE" && key === "optional") &&
          !encodingLabels.includes(key)
        )
          assert.notEqual(t(key), key, `${id}: ${key}`);
        assert.ok(t(key).trim());
        assert.equal(formatText(key), t(key));
      }
      for (const key of encodingLabels) {
        const code = key.slice(key.lastIndexOf("("));
        assert.ok(
          t(key).endsWith(code),
          `preserves technical encoding identifier ${code}`,
        );
      }
      const encodedFile = "Settings {owner} <原稿>.txt";
      assert.equal(
        formatText(encodingPrompt, { fileName: encodedFile }),
        t(encodingPrompt).replace("{fileName}", encodedFile),
      );
      assert.ok(
        formatText(encodingPrompt, { fileName: encodedFile }).includes(
          encodedFile,
        ),
      );
      assert.notEqual(
        t("Document extraction was interrupted. Retry this file."),
        t("Choose a supported file encoding."),
      );
      assert.notEqual(
        t("This document needs text extraction."),
        t("This file is already being read. Try again when it finishes."),
      );
      assert.equal(t("View instructions"), expectedInstructions[id]);
      assert.notEqual(
        t(keys[0]),
        t(keys[1]),
        "unavailable comments differ from read-only comments",
      );
      assert.notEqual(t("View comments"), t("Done viewing"));
      assert.notEqual(
        t("View instructions"),
        t("Project instructions are read-only."),
      );
      for (const key of reusedKeys)
        assert.notEqual(t(key), key, `reuses ${key}`);
      const fileName = "Settings {draft} <原稿>.pdf";
      const removeFile = formatText("Remove {fileName}", { fileName });
      assert.ok(removeFile.includes(fileName));
      assert.equal(
        removeFile,
        t("Remove {fileName}").replace("{fileName}", fileName),
      );
      assert.notEqual(t("Add context"), t("Upload files"));
      assert.notEqual(t("Loading project options…"), t("Creating project…"));
      assert.notEqual(
        t("Couldn’t load project options. Try again."),
        t("Failed to prepare project context. You can try again."),
      );
      assert.notEqual(
        t("Project context already exists."),
        t("Failed to prepare project context. You can try again."),
      );
      for (const template of relatedSessionTemplates) {
        const action = "Settings / notes {owner} <原稿>";
        for (const count of [0, 1, 2]) {
          assert.notEqual(
            t(template),
            template,
            "reuses the translated session-count template",
          );
          const actual = formatText(template, { action, count });
          assert.ok(
            actual.includes(action),
            "keeps the caller's action verbatim",
          );
          assert.ok(actual.includes(String(count)));
          assert.equal(
            actual,
            t(template)
              .replace("{action}", action)
              .replace("{count}", String(count)),
          );
        }
      }
    } finally {
      await setLocale(previous);
    }
  });
}

test("source locale preserves the exact access copy and interpolated session values", async () => {
  const previous = currentLocale();
  try {
    await setLocale(sourceLocale);
    for (const key of keys) assert.equal(t(key), key);
    assert.equal(
      formatText(relatedSessionTemplates[0], {
        action: "Chat with Claudex",
        count: 1,
      }),
      "Chat with Claudex · 1 session here",
    );
  } finally {
    await setLocale(previous);
  }
});

test("each catalog declares the actual new keys once and retains both session placeholders", () => {
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const url = new URL(`../../shared/i18n/catalogs/${id}.ts`, import.meta.url);
    const source = ts.createSourceFile(
      url.pathname,
      readFileSync(url, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const entries = new Map<string, string[]>();
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
        ts.isStringLiteral(node.initializer)
      ) {
        const values = entries.get(node.name.text) ?? [];
        values.push(node.initializer.text);
        entries.set(node.name.text, values);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const key of [...keys, ...relatedSessionTemplates, ...reusedKeys]) {
      const values = entries.get(key);
      assert.equal(values?.length, 1, `${id}: ${key}`);
      for (const placeholder of ["{action}", "{count}", "{fileName}"])
        assert.equal(
          values![0].includes(placeholder),
          key.includes(placeholder),
          `${id}: ${key}: ${placeholder}`,
        );
    }
  }
});
