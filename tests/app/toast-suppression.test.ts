import test from "node:test";
import assert from "node:assert/strict";
import {
  currentToasts,
  dismissAllToasts,
  dismissToast,
  resetToastSuppression,
  showToast,
} from "../../src/ui/toast-store";

test("a repeated toast the person closes stays away for 30 seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  resetToastSuppression();
  const id = showToast("Couldn’t save");
  showToast("Couldn’t save");
  assert.equal(currentToasts()[0].count, 2);
  dismissToast(id, true);
  t.mock.timers.tick(300);
  assert.equal(showToast("Couldn’t save"), -1);
  t.mock.timers.tick(30_000);
  assert.notEqual(showToast("Couldn’t save"), -1);
  // A single toast closed by the person is not held back.
  const once = showToast("Saved");
  dismissToast(once, true);
  t.mock.timers.tick(300);
  assert.notEqual(showToast("Saved"), -1);
  dismissAllToasts();
  t.mock.timers.tick(300);
});

test("a danger toast given no time stays 6.5 seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  resetToastSuppression();
  showToast("Failed", { variant: "danger" });
  t.mock.timers.tick(6_100);
  assert.equal(currentToasts().filter((toast) => !toast.closing).length, 1);
  t.mock.timers.tick(500);
  assert.equal(currentToasts().filter((toast) => !toast.closing).length, 0);
  t.mock.timers.tick(300);
});
