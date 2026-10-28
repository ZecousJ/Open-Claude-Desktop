import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  pluginArchiveRule,
  pluginManifestRule,
  pluginTrustWarning,
} from "../../shared/plugin-upload";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";

const createKeys = [
  "v1 · draft",
  "Save version",
  "Rename file path",
  "New file path",
  "File view",
  "Add a file before saving.",
  "Enter a path like scripts/run.py.",
  "A file with that path already exists.",
  "The plugin has too many files.",
  "The plugin manifest must contain a JSON object.",
  "The plugin files exceed the archive size limit.",
  "Open folder {folder}",
];
const removeKeys = [
  "Remove plugin?",
  "This plugin’s commands and skills will no longer be available. You can add it back later.",
];
// Upload uses the existing capability/trust strings. It advertises no new
// Security scan label without a genuine host scan capability.
const uploadReusedKeys = [
  "Upload a plugin",
  "Upload plugins",
  "Plugins",
  "Your plugins",
  "Plugin file",
  "Cancel",
  "Upload",
];
const reusedKeys = [
  pluginArchiveRule,
  pluginManifestRule,
  pluginTrustWarning,
  "Code",
  "Preview",
  "Delete",
  "Rename",
  "Add file",
  "Files",
  "Resize file list",
  "Plugin name",
  "Description",
  "What this plugin helps with",
  "Your changes haven’t been saved and will be lost.",
  "Keep editing",
  "Discard",
  "Name your plugin before saving.",
  "No plugins were added.",
  "Cancel",
  "Remove",
  "Removing…",
  ...uploadReusedKeys,
];
const keys = [...createKeys, ...removeKeys];
const expectedSave: Record<string, string> = {
  "zh-CN": "保存版本",
  "fr-FR": "Enregistrer la version",
  "de-DE": "Version speichern",
  "hi-IN": "संस्करण सहेजें",
  "id-ID": "Simpan versi",
  "it-IT": "Salva versione",
  "ja-JP": "バージョンを保存",
  "ko-KR": "버전 저장",
  "pt-BR": "Salvar versão",
  "es-419": "Guardar versión",
  "es-ES": "Guardar versión",
};
const expectedRemove: Record<string, string> = {
  "zh-CN": "移除插件？",
  "fr-FR": "Retirer le plugin ?",
  "de-DE": "Plugin entfernen?",
  "hi-IN": "प्लगइन हटाएं?",
  "id-ID": "Hapus plugin?",
  "it-IT": "Rimuovere il plugin?",
  "ja-JP": "プラグインを削除しますか？",
  "ko-KR": "플러그인을 제거할까요?",
  "pt-BR": "Remover plugin?",
  "es-419": "¿Quitar el plugin?",
  "es-ES": "¿Quitar el plugin?",
};
const reversibleClause: Record<string, string> = {
  "zh-CN": "稍后重新添加",
  "fr-FR": "rajouter plus tard",
  "de-DE": "später wieder hinzufügen",
  "hi-IN": "बाद में फिर से जोड़",
  "id-ID": "menambahkannya kembali nanti",
  "it-IT": "di nuovo in seguito",
  "ja-JP": "後で再度追加",
  "ko-KR": "나중에 다시 추가",
  "pt-BR": "novamente mais tarde",
  "es-419": "volver a agregarlo más tarde",
  "es-ES": "volver a añadirlo más tarde",
};
const holes = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
function sourceTree(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function literalValues(node: ts.Node, into = new Set<string>()) {
  if (ts.isStringLiteralLike(node)) into.add(node.text);
  ts.forEachChild(node, (child) => {
    literalValues(child, into);
  });
  return into;
}
const sourceFiles = [
  "src/plugins/CreatePluginDialog.tsx",
  "src/plugins/PluginBundleEditor.tsx",
  "src/plugins/plugin-create-files.ts",
  "src/plugins/PluginRemoveDialog.tsx",
];

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale))
  test(`${id}: actual plugin editor/remove/upload labels load with exact placeholders and no English fallback`, async () => {
    const previous = currentLocale();
    try {
      await setLocale(id);
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      assert.equal(currentLocale(), id);
      for (const key of [...keys, ...new Set(reusedKeys)]) {
        assert.equal(typeof catalog[key], "string", `${id}: ${key}`);
        assert.equal(t(key), catalog[key]);
        assert.equal(formatText(key), t(key));
        assert.ok(t(key).trim());
        assert.deepEqual(holes(t(key)), holes(key));
      }
      for (const key of keys) assert.notEqual(t(key), key, key);
      assert.equal(t("Save version"), expectedSave[id]);
      assert.equal(t("Remove plugin?"), expectedRemove[id]);
      assert.ok(t(removeKeys[1]).includes(reversibleClause[id]));
      assert.ok(t("v1 · draft").startsWith("v1 · "));
      assert.ok(
        t("The plugin manifest must contain a JSON object.").includes("JSON"),
      );
      assert.ok(
        t("Enter a path like scripts/run.py.").includes("scripts/run.py"),
      );
      const folder = "plugins/$& {owner} <原稿>/nested";
      assert.equal(
        formatText("Open folder {folder}", { folder }),
        t("Open folder {folder}").replace("{folder}", () => folder),
      );
      assert.ok(
        formatText("Open folder {folder}", { folder }).includes(folder),
      );
    } finally {
      await setLocale(previous);
    }
  });
test("all fourteen new keys come from actual editor/error/remove source literals; direct UI calls also have catalog entries", () => {
  assert.equal(createKeys.length, 12);
  assert.equal(removeKeys.length, 2);
  assert.equal(new Set(keys).size, 14);
  const literals = new Set<string>(),
    directUi = new Set<string>();
  for (const path of sourceFiles) {
    const tree = sourceTree(path);
    for (const literal of literalValues(tree)) literals.add(literal);
    const branch = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node)) directUi.add(node.text);
      else if (ts.isConditionalExpression(node)) {
        branch(node.whenTrue);
        branch(node.whenFalse);
      }
    };
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["t", "formatText"].includes(node.expression.text) &&
        node.arguments[0]
      )
        branch(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  for (const key of keys) assert.ok(literals.has(key), key);
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const tree = sourceTree(`shared/i18n/catalogs/${id}.ts`);
    const found = new Set<string>();
    function visit(node: ts.Node) {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))
      )
        found.add(node.name.text);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    for (const key of directUi)
      assert.ok(found.has(key), `${id}: direct UI string ${key}`);
  }
});
test("all catalog properties are unique and the new key placeholders retain their exact source names", () => {
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const tree = sourceTree(`shared/i18n/catalogs/${id}.ts`);
    const entries = new Map<string, string>();
    function visit(node: ts.Node) {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
        ts.isStringLiteral(node.initializer)
      ) {
        assert.equal(
          entries.has(node.name.text),
          false,
          `${id}: duplicate ${node.name.text}`,
        );
        entries.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    for (const key of keys) {
      assert.ok(entries.has(key));
      assert.deepEqual(holes(entries.get(key)!), holes(key), `${id}: ${key}`);
    }
  }
});
test("English source stays unchanged and formats literal folder user text once", async () => {
  const previous = currentLocale();
  try {
    await setLocale(sourceLocale);
    for (const key of keys) assert.equal(t(key), key);
    assert.equal(
      formatText("Open folder {folder}", { folder: "$& {literal}" }),
      "Open folder $& {literal}",
    );
  } finally {
    await setLocale(previous);
  }
});
