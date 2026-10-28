import test from "node:test";
import assert from "node:assert/strict";
import { withUtf8Locale } from "../../electron/engine/locale-env";

test("Codex's shells get a UTF-8 locale when Claudex was opened without one", () => {
  const all = () => true;
  const none = () => false;
  assert.equal(withUtf8Locale({}, "darwin", "zh-CN", all).LANG, "zh_CN.UTF-8");
  assert.equal(withUtf8Locale({}, "darwin", "zh-CN", none).LANG, "en_US.UTF-8");
  assert.equal(withUtf8Locale({}, "darwin", "en", all).LANG, "en_US.UTF-8");
  assert.equal(withUtf8Locale({}, "linux", "zh-CN", all).LANG, "C.UTF-8");
  assert.equal(
    withUtf8Locale({ LANG: "C" }, "darwin", "zh-CN", all).LANG,
    "zh_CN.UTF-8",
  );
  // What the person set stays.
  assert.deepEqual(withUtf8Locale({ LANG: "fr_FR.UTF-8" }, "darwin"), {
    LANG: "fr_FR.UTF-8",
  });
  assert.deepEqual(withUtf8Locale({ LC_ALL: "C" }, "darwin"), { LC_ALL: "C" });
  assert.deepEqual(withUtf8Locale({ LC_CTYPE: "UTF-8" }, "darwin"), {
    LC_CTYPE: "UTF-8",
  });
  assert.deepEqual(withUtf8Locale({}, "win32"), {});
});
