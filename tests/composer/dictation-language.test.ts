import assert from "node:assert/strict";
import test from "node:test";
import { dictationStartOptions } from "../../shared/voice-api";
import { dictationLanguages } from "../../src/composer/dictation-languages";
import {
  dictationOptions,
  selectedDictationLanguage,
  setDictationLanguage,
} from "../../src/voice/dictation-language";
import { recognitionLanguage } from "../../src/voice/browser-recognition";
import { dictationLanguagePosition } from "../../src/composer/dictation-language-position";

test("language search retains the source's held end edge as results shrink and clamps on resize", () => {
  const initial = {
    trigger: { left: 894.5, right: 1051.7734375, top: 535, bottom: 567 },
    width: 234.8359375,
    contentHeight: 710,
    viewport: { width: 1280, height: 720 },
    previous: { heldHeight: 0, alignEnd: undefined },
  };
  const full = dictationLanguagePosition(initial);
  assert.equal(full.top, 5);
  assert.equal(full.height, 710);
  assert.equal(full.alignEnd, true);
  const filtered = dictationLanguagePosition({
    ...initial,
    contentHeight: 146,
    previous: full,
  });
  assert.equal(filtered.top + filtered.height - 146, 569);
  assert.equal(filtered.top + filtered.height, 715);
  const resized = dictationLanguagePosition({
    ...initial,
    contentHeight: 146,
    viewport: { width: 390, height: 400 },
    previous: filtered,
  });
  assert.equal(resized.height, 390);
  assert.equal(resized.top, 5);
  assert.ok(resized.left >= 5 && resized.left + initial.width <= 385);
});

test("a short language menu keeps its start alignment and has no artificial minimum height", () => {
  const place = dictationLanguagePosition({
    trigger: { left: 20, right: 170, top: 90, bottom: 122 },
    width: 200,
    contentHeight: 100,
    viewport: { width: 800, height: 600 },
    previous: { heldHeight: 0, alignEnd: undefined },
  });
  assert.equal(place.left, 176);
  assert.equal(place.top, 86);
  assert.equal(place.height, 100);
  assert.equal(place.alignEnd, false);
});

test("dictation language accepts relay tags and rejects invalid inputs before opening a session", () => {
  for (const input of [
    undefined,
    {},
    { language: "" },
    { language: undefined },
  ])
    assert.deepEqual(dictationStartOptions(input), {});
  assert.deepEqual(dictationStartOptions({ language: "zh_CN" }), {
    language: "zh-CN",
  });
  assert.deepEqual(dictationStartOptions({ language: "es-419" }), {
    language: "es-419",
  });
  for (const input of [
    null,
    [],
    "en",
    { language: 2 },
    { language: "en\n" },
    { language: "x" },
    { language: "en-US-extra-too-long" },
  ])
    assert.throws(
      () => dictationStartOptions(input),
      /Invalid dictation language/,
    );
});

test("dictation inventory localizes names while retaining observed English labels and valid service tags", () => {
  const en = dictationLanguages("en-US");
  assert.equal(en.length, 30);
  assert.equal(new Set(en.map((x) => x.value)).size, en.length);
  assert.equal(en.find((x) => x.value === "zh")?.label, "Chinese (Mandarin)");
  assert.equal(en.find((x) => x.value === "en-IN")?.label, "English (India)");
  for (const item of en)
    assert.equal(
      dictationStartOptions({ language: item.value }).language,
      item.value,
    );
  assert.equal(
    dictationLanguages("zh-CN").find((x) => x.value === "en")?.label,
    "英语",
  );
});

test("input language reaches browser recognition, persists and resets without changing read-aloud language", () => {
  const storage = new Map<string, string>([
    ["claudex.speech.language", "fr-FR"],
  ]);
  const saved = new Map(
    ["localStorage", "dispatchEvent", "navigator"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let changes = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "dispatchEvent", {
    configurable: true,
    value: () => {
      changes++;
      return true;
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "ja-JP" },
  });
  try {
    setDictationLanguage("zh-CN");
    assert.equal(selectedDictationLanguage(), "zh-CN");
    assert.deepEqual(dictationOptions(), { language: "zh-CN" });
    assert.equal(recognitionLanguage(), "zh-CN");
    assert.equal(storage.get("claudex.dictation.language"), "zh-CN");
    assert.equal(storage.get("claudex.speech.language"), "fr-FR");
    setDictationLanguage("");
    assert.equal(dictationOptions(), undefined);
    assert.equal(recognitionLanguage(), "ja-JP");
    assert.equal(changes, 2);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw Error("blocked");
        },
        setItem: () => {
          throw Error("blocked");
        },
      },
    });
    setDictationLanguage("en-IN");
    assert.equal(selectedDictationLanguage(), "en-IN");
    setDictationLanguage("");
  } finally {
    for (const [key, value] of saved)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
});
