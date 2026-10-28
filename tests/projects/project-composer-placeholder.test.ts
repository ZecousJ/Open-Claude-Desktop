import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chatComposerPlaceholder } from "../../src/composer/chat-placeholder";
import { formatText, setLocale, t } from "../../src/i18n";
import { readSource } from "../support/read-source";

test("new chat and legacy task drafts share the project placeholder", () => {
  assert.equal(
    chatComposerPlaceholder("cowork", false, true),
    "What would you like to work on in this project?",
  );
  assert.equal(
    chatComposerPlaceholder("chat", false, true),
    "What would you like to work on in this project?",
  );
});

test("project-detail drafts name the actual project in Chat and Cowork", () => {
  for (const mode of ["chat", "cowork"] as const) {
    assert.equal(
      chatComposerPlaceholder(mode, false, true, "Product research"),
      "New session in Product research",
    );
    assert.equal(
      chatComposerPlaceholder(mode, true, true, "Product research"),
      "Reply",
    );
    assert.equal(
      chatComposerPlaceholder(mode, false, false, "Product research"),
      "How can I help you today?",
    );
  }
});

test("an unloaded or empty project keeps the truthful generic placeholder", () => {
  for (const name of [undefined, "", "  "])
    assert.equal(
      chatComposerPlaceholder("chat", false, true, name),
      "What would you like to work on in this project?",
    );
  const name = 'Settings {project} <img src=x onerror="alert(1)">';
  assert.equal(
    chatComposerPlaceholder("chat", false, true, name),
    `New session in ${name}`,
    "user text is inserted once as a plain placeholder value",
  );
});

test("home drafts keep their defaults, including when a project is selected", () => {
  assert.equal(
    chatComposerPlaceholder("chat", false, false),
    "How can I help you today?",
  );
  assert.equal(
    chatComposerPlaceholder("cowork", false, false),
    "How can I help you today?",
  );
});

test("project membership and page state never override follow-up placeholders", () => {
  for (const projectOverview of [false, true]) {
    assert.equal(
      chatComposerPlaceholder("chat", true, projectOverview),
      "Reply",
    );
    assert.equal(
      chatComposerPlaceholder("cowork", true, projectOverview),
      "Reply",
    );
  }
});

test("the project placeholder follows the selected interface language", async () => {
  try {
    await setLocale("zh-CN");
    assert.equal(
      t(chatComposerPlaceholder("cowork", false, true)),
      "你想在这个项目中做些什么？",
    );
  } finally {
    await setLocale("en-US");
  }
});

test("localized project placeholders insert braces and UI-like project names once", async () => {
  const key = "New session in {project}";
  try {
    for (const locale of [
      "zh-CN",
      "ja-JP",
      "ko-KR",
      "de-DE",
      "fr-FR",
      "es-ES",
      "es-419",
      "it-IT",
      "pt-BR",
      "id-ID",
      "hi-IN",
    ] as const) {
      await setLocale(locale);
      assert.notEqual(
        t(key),
        key,
        `${locale} requires the translated project template`,
      );
      for (const name of ["{project}", "Settings", "Settings {project}"]) {
        const placeholder = chatComposerPlaceholder(
          "cowork",
          false,
          true,
          name,
        );
        assert.equal(placeholder, formatText(key, { project: name }));
        assert.ok(
          placeholder.includes(name),
          `${locale} preserves the user project name`,
        );
      }
    }
  } finally {
    await setLocale("en-US");
  }
});

test("the production Composer gives the helper the real project name without a second translation", () => {
  const source = readSource("src/composer/Composer.tsx");
  assert.match(
    source,
    /const fullPlaceholder\s*=\s*chatComposerPlaceholder\([\s\S]*?projectOverview,\s*project\?\.name,?\s*\)/,
  );
  assert.doesNotMatch(source, /const fullPlaceholder\s*=\s*t\(/);
});
