import test from "node:test";
import assert from "node:assert/strict";
import {
  locales,
  nearestLocale,
  defaultLocale,
  sourceLocale,
} from "../../shared/locales";
import {
  currentLocale,
  formatText,
  listSeparator,
  setLocale,
  t,
  tf,
} from "../../src/i18n";
import zh from "../../shared/i18n/catalogs/zh-CN";

test("the language list is the dialog's: English first, Simplified Chinese added", () => {
  assert.equal(locales.length, 12);
  assert.equal(locales[0]?.id, sourceLocale);
  assert.equal(
    defaultLocale,
    "zh-CN",
    "Simplified Chinese until a person chooses",
  );
  assert.ok(locales.some((l) => l.id === "zh-CN" && l.native === "简体中文"));
  assert.equal(new Set(locales.map((l) => l.id)).size, locales.length);
  for (const id of [
    "fr-FR",
    "de-DE",
    "hi-IN",
    "id-ID",
    "it-IT",
    "ja-JP",
    "ko-KR",
    "pt-BR",
    "es-419",
    "es-ES",
  ])
    assert.ok(
      locales.some((l) => l.id === id),
      id,
    );
});

test("a browser language maps to the nearest supported one", () => {
  assert.equal(nearestLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(nearestLocale("zh-TW"), "zh-CN");
  assert.equal(nearestLocale("es-MX"), "es-419");
  assert.equal(nearestLocale("es-ES"), "es-ES");
  assert.equal(nearestLocale("pt-PT"), "pt-BR");
  assert.equal(nearestLocale("fr-CA"), "fr-FR");
  assert.equal(nearestLocale("en-GB"), "en-US");
  assert.equal(nearestLocale("sv"), defaultLocale);
  assert.equal(nearestLocale(""), defaultLocale);
});

test("every catalog has the complete key set, nonempty values and matching placeholders", async () => {
  const keys = Object.keys(zh).sort();
  for (const { id } of locales.filter((l) => l.id !== sourceLocale)) {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    assert.deepEqual(
      Object.keys(catalog).sort(),
      keys,
      `${id}: catalog keys differ`,
    );
    for (const [english, text] of Object.entries(catalog)) {
      assert.deepEqual(
        (text.match(/\{\w+\}/g) ?? []).sort(),
        (english.match(/\{\w+\}/g) ?? []).sort(),
        `${id}: placeholders differ for ${english}`,
      );
      assert.ok(text.trim(), `${id}: “${english}” is empty`);
      assert.ok(keys.includes(english), `${id}: “${english}” is not in zh-CN`);
    }
    assert.ok(Object.keys(catalog).length >= 2000, id);
  }
});

test("a text is looked up by its English words and stays English without an entry", async () => {
  await setLocale("zh-CN");
  assert.equal(currentLocale(), "zh-CN");
  assert.equal(t("Settings"), "设置");
  assert.equal(
    t("A sentence nobody translated"),
    "A sentence nobody translated",
  );
  await setLocale("ja-JP");
  assert.equal(t("Settings"), "設定");
  await setLocale("en-US");
  assert.equal(t("Settings"), "Settings");
  // Anything unknown falls back to the default language.
  await setLocale("nonsense");
  assert.equal(currentLocale(), defaultLocale);
  assert.equal(t("Settings"), "设置");
  assert.equal(
    t("Good morning, {name}").replace("{name}", "Ann"),
    "早上好，Ann",
  );
});

test("a text with a hole matches whatever fills it, and the hole keeps its words", async () => {
  await setLocale("zh-CN");
  assert.equal(t("Thought for 12s"), "思考了 12 秒");
  assert.equal(t("ran 3 commands"), "运行了 3 条命令");
  assert.equal(t("3 days ago"), "3 天前");
  assert.equal(t("1 hour ago"), "1 小时前");
  assert.equal(
    tf("Invitation sent to {x}.", { x: "ann@example.com" }),
    "已向 ann@example.com 发送邀请。",
  );
  assert.equal(
    tf("Created {a} · Last used {b}", { a: "Sep 21", b: "6 days ago" }),
    "创建于 Sep 21 · 上次使用 6 天前",
  );
  // A hole takes a name, never a clause: "Add {name}" leaves "Add plugins and
  // more" alone and takes "Add GitHub Enterprise" for what it is.
  assert.equal(t("Add plugins and more"), "Add plugins and more");
  assert.equal(t("Please add plugins and more"), "Please add plugins and more");
  assert.equal(t("Add GitHub Enterprise"), "添加 GitHub Enterprise");
  assert.equal(t("Reading package.json"), "正在读取 package.json");
  assert.equal(listSeparator(), "，");
  await setLocale("fr-FR");
  assert.equal(t("Thought for 12s"), "Réflexion pendant 12 s");
  assert.equal(listSeparator(), ", ");
});

test("explicit sentences preserve opaque names and the latest concurrent locale choice wins", async () => {
  await setLocale("zh-CN");
  assert.equal(
    formatText("Remove {name}", { name: "Settings" }),
    "移除 Settings",
  );
  assert.equal(formatText("{unknown}", {}), "{unknown}");
  assert.equal(formatText("{toString}", {}), "{toString}");
  await Promise.all([setLocale("ja-JP"), setLocale("en-US")]);
  assert.equal(currentLocale(), "en-US");
  assert.equal(t("Private"), "Private");
  await Promise.all([setLocale("fr-FR"), setLocale("zh-CN")]);
  assert.equal(currentLocale(), "zh-CN");
  assert.equal(t("Private"), "私密");
  await setLocale("en-US");
});

test("texts that only look like a sentence with a hole stay as they are", async () => {
  await setLocale("zh-CN");
  try {
    for (const text of [
      "Remove the stale lock file.",
      "Show answer",
      "Delete my notes",
      "Connect to the database",
      "Use npm to install packages",
      "Looking at the error log",
      "Done at noon",
      "Most of your chats",
      "Connection failed",
      "Try it in the background",
      "Could not reach the server on this device",
      "Turn on Allow bypass permissions mode in Settings to use it later.",
      "A desktop app for scientific research, built for long analyses on large datasets.",
    ])
      assert.equal(t(text), text, text);
    // Sentences made only of the small words between two holes are filled
    // by formatText and never taken for a pattern.
    assert.equal(t("Studio Mac in Garage"), "Studio Mac in Garage");
    assert.equal(t("Safari on macOS"), "Safari on macOS");
  } finally {
    await setLocale("en-US");
  }
});
