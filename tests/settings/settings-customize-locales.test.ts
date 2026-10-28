import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";
import { pluginChatPrompt } from "../../src/plugins/try-plugin-chat";

const privacyKeys = [
  "Feedback retained by your Claudex service. Local reply ratings and unsent reports are not this history.",
  "Conversation excerpt attached",
  "Not recorded",
  "No feedback found",
  "Loading feedback…",
  "Withdraw feedback?",
  "This removes the feedback stored by your Claudex service, including any attached conversation excerpt. It does not delete your chat.",
  "Withdrawing…",
  "Partial inventory: attachment copies stored by this execution host. Project files, browser transfer uploads and external originals are not included.",
  "This inventory is read-only. Other copies cannot be verified for deletion. Text already extracted into chats is retained.",
  "Loading uploaded files…",
  "Attachment copy",
  "Unknown location",
  "No stored attachment copies found in this inventory",
  "Some storage entries could not be included. This is not a complete account inventory.",
  "Couldn’t check privacy data support.",
  "Checking privacy data support…",
  "Local accounts have no service feedback history.",
  "Feedback history management is unavailable in this app.",
  "This service does not support feedback history management.",
  "This host cannot list stored attachment copies.",
  "This privacy request belongs to a retired account. Open Privacy again.",
  "This page has expired or belongs to another account. Refresh the list.",
  "This account has no feedback collection service.",
  "The attachment storage boundary changed. Try again.",
  "Positive",
  "Negative",
  "Withdraw feedback",
];
const extensionKeys = [
  "The browser is only in Code sessions or Cowork sessions running on this computer.",
  "This extension is unavailable.",
  "The extension changed. Reload it and try again.",
  "Extension configuration is unavailable on this host.",
  "Extensions are disabled by your administrator.",
  "This extension is not allowed by your administrator.",
  "Unknown extension setting.",
  "Fill in all required extension settings.",
  "An extension setting has an invalid value.",
  "Extension settings are too large.",
  "This extension package is used by another MCP entry.",
  "Loading extensions…",
  "Couldn’t load installed extensions.",
  "Disabled",
  "Details",
  "Configure",
  "More options for {extension}",
  "Uninstall",
  "Extension details",
  "Loading extension…",
  "Couldn’t load this extension.",
  "Version",
  "Author",
  "License",
  "Documentation",
  "Support",
  "Tools",
  "Prompts",
  "Uninstall extension?",
  "This removes the extension and its saved settings from this computer.",
  "Cancel",
  "Close",
  "Enabled",
  "Saved value",
  "Save",
  "Retry",
];
const newKeys = [
  "I have the {pluginName} plugin. Please walk me through what it can do.",
  "Feedback retained by your Claudex service. Local reply ratings and unsent reports are not this history.",
  "Conversation excerpt attached",
  "Not recorded",
  "No feedback found",
  "Loading feedback…",
  "Withdraw feedback?",
  "This removes the feedback stored by your Claudex service, including any attached conversation excerpt. It does not delete your chat.",
  "Withdrawing…",
  "Partial inventory: attachment copies stored by this execution host. Project files, browser transfer uploads and external originals are not included.",
  "This inventory is read-only. Other copies cannot be verified for deletion. Text already extracted into chats is retained.",
  "Loading uploaded files…",
  "Attachment copy",
  "Unknown location",
  "No stored attachment copies found in this inventory",
  "Some storage entries could not be included. This is not a complete account inventory.",
  "Couldn’t check privacy data support.",
  "Checking privacy data support…",
  "Local accounts have no service feedback history.",
  "Feedback history management is unavailable in this app.",
  "This service does not support feedback history management.",
  "This host cannot list stored attachment copies.",
  "This privacy request belongs to a retired account. Open Privacy again.",
  "This page has expired or belongs to another account. Refresh the list.",
  "This account has no feedback collection service.",
  "The attachment storage boundary changed. Try again.",
  "Positive",
  "Negative",
  "Withdraw feedback",
  "The browser is only in Code sessions or Cowork sessions running on this computer.",
  "This extension is unavailable.",
  "The extension changed. Reload it and try again.",
  "Extension configuration is unavailable on this host.",
  "Extensions are disabled by your administrator.",
  "This extension is not allowed by your administrator.",
  "Unknown extension setting.",
  "Fill in all required extension settings.",
  "An extension setting has an invalid value.",
  "Extension settings are too large.",
  "This extension package is used by another MCP entry.",
  "Loading extensions…",
  "Couldn’t load installed extensions.",
  "Configure",
  "More options for {extension}",
  "Uninstall",
  "Extension details",
  "Loading extension…",
  "Couldn’t load this extension.",
  "Version",
  "License",
  "Prompts",
  "Uninstall extension?",
  "This removes the extension and its saved settings from this computer.",
  "Saved value",
];
const allKeys = [pluginChatPrompt, ...privacyKeys, ...extensionKeys];
const expectedConfigure: Record<string, string> = {
  "zh-CN": "配置",
  "fr-FR": "Configurer",
  "de-DE": "Konfigurieren",
  "hi-IN": "कॉन्फ़िगर करें",
  "id-ID": "Konfigurasi",
  "it-IT": "Configura",
  "ja-JP": "設定",
  "ko-KR": "구성",
  "pt-BR": "Configurar",
  "es-419": "Configurar",
  "es-ES": "Configurar",
};
const noChatDeletion: Record<string, string> = {
  "zh-CN": "不会删除你的对话",
  "fr-FR": "Votre conversation n’est pas supprimée.",
  "de-DE": "Dein Chat wird nicht gelöscht.",
  "hi-IN": "आपकी चैट नहीं हटती।",
  "id-ID": "Chat Anda tidak dihapus.",
  "it-IT": "La chat non viene eliminata.",
  "ja-JP": "チャットは削除されません。",
  "ko-KR": "채팅은 삭제되지 않습니다.",
  "pt-BR": "Seu chat não será excluído.",
  "es-419": "No elimina tu chat.",
  "es-ES": "No elimina tu chat.",
};
const readOnly: Record<string, string> = {
  "zh-CN": "只读",
  "fr-FR": "lecture seule",
  "de-DE": "schreibgeschützt",
  "hi-IN": "केवल पढ़ी",
  "id-ID": "hanya dapat dibaca",
  "it-IT": "sola lettura",
  "ja-JP": "読み取り専用",
  "ko-KR": "읽기 전용",
  "pt-BR": "somente leitura",
  "es-419": "solo lectura",
  "es-ES": "solo lectura",
};
const intentionallyShared: Record<string, readonly string[]> = {
  "fr-FR": ["Version"],
  "de-DE": ["Version", "Prompts"],
  "pt-BR": ["Prompts"],
  "es-419": ["Prompts"],
  "es-ES": ["Prompts"],
};
const encodings = [
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
const withdrawal =
  "This removes the feedback stored by your Claudex service, including any attached conversation excerpt. It does not delete your chat.";
const inventory =
  "This inventory is read-only. Other copies cannot be verified for deletion. Text already extracted into chats is retained.";

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: actual Privacy, Extensions and Try-chat strings load with literal placeholders and brands`, async () => {
    const previous = currentLocale();
    try {
      await setLocale(id);
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      assert.equal(currentLocale(), id);
      for (const key of allKeys) {
        assert.equal(typeof catalog[key], "string", `entry exists: ${key}`);
        assert.equal(t(key), catalog[key], `runtime loads the catalog: ${key}`);
        assert.equal(formatText(key), t(key));
        assert.ok(t(key).trim());
      }
      for (const key of newKeys)
        if (!intentionallyShared[id]?.includes(key))
          assert.notEqual(t(key), key, key);
      assert.equal(t("Configure"), expectedConfigure[id]);
      assert.ok(t(withdrawal).includes(noChatDeletion[id]));
      assert.ok(t(inventory).includes(readOnly[id]));
      assert.notEqual(
        t("No feedback found"),
        t("Local accounts have no service feedback history."),
      );
      assert.notEqual(
        t("This extension is unavailable."),
        t("This extension is not allowed by your administrator."),
      );
      assert.notEqual(
        t("Couldn’t load installed extensions."),
        t("Couldn’t load this extension."),
      );
      for (const key of allKeys)
        for (const brand of ["Claudex", "Code", "Cowork", "MCP"])
          if (key.includes(brand))
            assert.ok(t(key).includes(brand), `${key}: ${brand}`);
      for (const [key, name] of [
        [pluginChatPrompt, "pluginName"],
        ["More options for {extension}", "extension"],
      ]) {
        const value = "Settings $& {owner} <原稿> / plugin@market";
        assert.equal(
          formatText(key, { [name]: value }),
          t(key).replace(`{${name}}`, () => value),
        );
        assert.ok(formatText(key, { [name]: value }).includes(value));
      }
      for (const key of encodings) {
        assert.equal(typeof catalog[key], "string");
        assert.ok(t(key).endsWith(key.slice(key.lastIndexOf("("))), key);
      }
    } finally {
      await setLocale(previous);
    }
  });
}

test("English Try-chat copy stays an unsent plugin introduction with the literal plugin name", async () => {
  const previous = currentLocale();
  try {
    await setLocale(sourceLocale);
    assert.equal(
      pluginChatPrompt,
      "I have the {pluginName} plugin. Please walk me through what it can do.",
    );
    for (const key of allKeys) assert.equal(t(key), key);
    assert.equal(
      formatText(pluginChatPrompt, { pluginName: "Settings {literal}" }),
      "I have the Settings {literal} plugin. Please walk me through what it can do.",
    );
  } finally {
    await setLocale(previous);
  }
});

test("all supplied UI keys occur once per catalog and preserve exact placeholder names", () => {
  assert.equal(newKeys.length, 54);
  assert.equal(allKeys.length, 65);
  assert.equal(new Set(allKeys).size, allKeys.length);
  const holes = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
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
    for (const key of [...allKeys, ...encodings]) {
      const values = entries.get(key);
      assert.equal(values?.length, 1, `${id}: ${key}`);
      assert.deepEqual(holes(values![0]), holes(key), `${id}: ${key}`);
    }
  }
});
