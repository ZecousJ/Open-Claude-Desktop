import test from "node:test";
import assert from "node:assert/strict";
import { openPolicy } from "../../shared/client-policy";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import { setLocale, t } from "../../src/i18n";

test("the main process's attachment sentences are translated where they are shown", async () => {
  const sentences = [
    attachmentRefusal("run.exe", 4, openPolicy),
    attachmentRefusal("run.exe", 4, openPolicy, "session"),
    attachmentRefusal("huge.pdf", 40 * 1024 * 1024, openPolicy),
    attachmentRefusal("a.png", 30 * 1024 * 1024, openPolicy),
    attachmentRefusal("a.md", 10, {
      ...openPolicy,
      attachments: { maxBytes: null, types: ["png"] },
    }),
    "Your administrator has turned off attachments.",
  ].map((sentence) => sentence ?? "");
  try {
    await setLocale("zh-CN");
    const shown = sentences.map(t);
    assert.deepEqual(
      shown.map((text, index) => text !== sentences[index]),
      sentences.map(() => true),
      shown.join("\n"),
    );
    assert.match(shown[0]!, /“run\.exe”/);
    assert.match(shown[2]!, /“huge\.pdf”.*40 MB.*30 MB/);
    assert.doesNotMatch(shown.join(""), /\{/);
  } finally {
    await setLocale("en-US");
  }
});
