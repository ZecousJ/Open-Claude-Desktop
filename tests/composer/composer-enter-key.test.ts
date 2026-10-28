import test from "node:test";
import assert from "node:assert/strict";
import { enterAction, plainEnterSends } from "../../src/composer/enter-key";

const touch = (coarse: boolean, points: number, userAgent = "Mozilla/5.0") => ({
  navigator: { userAgent, maxTouchPoints: points },
  matchMedia: (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
  }),
});

test("plain Enter sends except on a touch screen on the web", () => {
  assert.equal(plainEnterSends(true, touch(true, 5)), true);
  assert.equal(plainEnterSends(false, touch(false, 0)), true);
  // A laptop with a touch screen but a fine pointer still sends.
  assert.equal(plainEnterSends(false, touch(false, 10)), true);
  assert.equal(plainEnterSends(false, touch(true, 5)), false);
  assert.equal(
    plainEnterSends(false, touch(true, 5, "Mozilla/5.0 (Windows NT 10.0)")),
    true,
  );
  assert.equal(
    plainEnterSends(false, touch(true, 5, "Mozilla/5.0 Electron/38.0")),
    true,
  );
});

test("Enter's action by its modifiers", () => {
  const key = {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  };
  assert.equal(enterAction(key, true), "send");
  assert.equal(enterAction(key, false), "newline");
  assert.equal(enterAction({ ...key, metaKey: true }, false), "send");
  assert.equal(enterAction({ ...key, ctrlKey: true }, false), "send");
  assert.equal(enterAction({ ...key, shiftKey: true }, true), "newline");
  assert.equal(enterAction({ ...key, altKey: true }, true), "newline");
  assert.equal(enterAction({ ...key, isComposing: true }, true), undefined);
  assert.equal(enterAction({ ...key, key: "a" }, true), undefined);
});
