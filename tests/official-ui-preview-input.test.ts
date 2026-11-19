import test from "node:test";
import assert from "node:assert/strict";
import { previewAction } from "../electron/browser/preview-input";
for (const mac of [true, false])
  test(`official preview keyboard contract (${mac ? "macOS" : "Windows"})`, () => {
    const key = (
      key: string,
      extra: object = {},
      page = true,
      chrome = false,
      armed = true,
    ) =>
      previewAction(
        {
          type: "keyDown",
          key,
          ...(mac ? { meta: true } : { control: true }),
          ...extra,
        },
        mac,
        page,
        chrome,
        armed,
      );
    assert.equal(key("l"), "address");
    assert.equal(key("w"), "close");
    assert.equal(key("t"), "new");
    assert.equal(key("t", { shift: true }), "reopen");
    assert.equal(key("q"), undefined);
    assert.equal(key("["), "back");
    assert.equal(key("]"), "forward");
    assert.equal(key("r"), "reload");
    assert.equal(key("1", { code: "Digit1" }), 0);
    assert.equal(key("9", { code: "Digit9" }), -1);
    assert.equal(key("l", {}, false, false), undefined);
    assert.equal(key("l", {}, false, true), "address");
    assert.equal(key("b", { shift: true }, true, false, false), undefined);
    assert.equal(key("b", { shift: true }, true, false, true), "pane");
    assert.equal(key("l", { alt: true }), undefined);
    assert.equal(key("l", { meta: true, control: true }), undefined);
    assert.equal(
      previewAction(
        { type: "keyDown", key: "F6", control: true },
        mac,
        true,
        false,
        false,
      ),
      "exit",
    );
    assert.equal(
      previewAction(
        { type: "keyDown", key: "Tab", control: true, shift: true },
        mac,
        true,
        false,
        false,
      ),
      "previous",
    );
    assert.equal(
      previewAction(
        { type: "keyDown", key: "Tab", control: true },
        mac,
        true,
        false,
        false,
      ),
      "next",
    );
  });
