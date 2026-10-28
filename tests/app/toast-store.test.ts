import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  TOAST_EXIT_MS,
  TOAST_LIMIT,
  TOAST_TIMEOUT_MS,
  currentToasts,
  dismissAllToasts,
  dismissToast,
  pauseToasts,
  showToast,
} from "../../src/ui/toast-store";

const messages = () =>
  currentToasts()
    .filter((t) => !t.closing && !t.limited)
    .map((t) => (t.count > 1 ? `${t.message} ×${t.count}` : t.message));

test("notices stack newest first, count repeats, keep three, and last six seconds", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  assert.equal(TOAST_TIMEOUT_MS, 6000);
  assert.equal(TOAST_LIMIT, 3);

  showToast("Copied");
  showToast("Saved");
  assert.deepEqual(messages(), ["Saved", "Copied"]);
  // The same message again counts up on the one shown.
  showToast("Copied");
  assert.deepEqual(messages(), ["Saved", "Copied ×2"]);

  // A fourth is kept out of sight, not dismissed: its countdown waits until
  // the ones in front go (Base UI's `limited`).
  showToast("Exported");
  showToast("Moved");
  assert.deepEqual(messages(), ["Moved", "Exported", "Saved"]);
  const waiting = currentToasts().find((t) => t.message === "Copied");
  assert.equal(waiting?.limited, true);
  assert.equal(waiting?.closing, false);
  mock.timers.tick(TOAST_TIMEOUT_MS - 1);
  assert.equal(
    currentToasts().find((t) => t.message === "Copied")?.limited,
    true,
  );
  mock.timers.tick(1);
  // The three in front timed out; the waiting one shows and starts counting.
  assert.deepEqual(messages(), ["Copied ×2"]);
  // Its six seconds run from here, not from when it was raised.
  mock.timers.tick(TOAST_TIMEOUT_MS - 1);
  assert.deepEqual(messages(), ["Copied ×2"]);
  mock.timers.tick(1);
  mock.timers.tick(TOAST_EXIT_MS);
  assert.equal(currentToasts().length, 0);

  // A shorter time asked for is raised to six seconds.
  dismissAllToasts();
  mock.timers.tick(TOAST_EXIT_MS);
  showToast("Short", { timeout: 1000 });
  mock.timers.tick(5999);
  assert.deepEqual(messages(), ["Short"]);
  mock.timers.tick(1);
  assert.deepEqual(messages(), []);
  mock.timers.tick(TOAST_EXIT_MS);
  assert.equal(currentToasts().length, 0);
});

test("hovering the stack holds the countdown, and leaving resumes it", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const id = showToast("Held");
  mock.timers.tick(4000);
  pauseToasts(true);
  mock.timers.tick(10_000);
  assert.deepEqual(messages(), ["Held"]);
  pauseToasts(false);
  mock.timers.tick(1999);
  assert.deepEqual(messages(), ["Held"]);
  mock.timers.tick(1);
  assert.deepEqual(messages(), []);
  mock.timers.tick(TOAST_EXIT_MS);
  // Dismissing a notice already gone does nothing.
  dismissToast(id);
  assert.equal(currentToasts().length, 0);
});

test("a toast's onDismiss runs once when it goes, and such toasts never merge", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  dismissAllToasts();
  mock.timers.tick(TOAST_EXIT_MS);
  let gone = 0;
  const first = showToast("Unsharing “A”…", { onDismiss: () => gone++ });
  showToast("Unsharing “A”…", { onDismiss: () => gone++ });
  assert.deepEqual(messages(), ["Unsharing “A”…", "Unsharing “A”…"]);
  dismissToast(first);
  dismissToast(first);
  assert.equal(gone, 1);
  mock.timers.tick(TOAST_TIMEOUT_MS);
  assert.equal(gone, 2);
  mock.timers.tick(TOAST_EXIT_MS);
  assert.equal(currentToasts().length, 0);
});

test("dictation retry notices stay until dismissed, including when a timed notice is replaced", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  dismissAllToasts();
  mock.timers.tick(TOAST_EXIT_MS);
  let retried = 0;
  const id = showToast("Dictation lost its connection.");
  assert.equal(
    showToast("Dictation lost its connection.", {
      description: "Nothing was added to the message box.",
      timeout: Infinity,
      action: { label: "Dictate again", onSelect: () => retried++ },
    }),
    id,
  );
  pauseToasts(true);
  mock.timers.tick(60_000);
  pauseToasts(false);
  mock.timers.tick(60_000);
  const toast = currentToasts().find((toast) => !toast.closing)!;
  assert.equal(toast.description, "Nothing was added to the message box.");
  toast.action!.onSelect();
  assert.equal(retried, 1);
  dismissToast(id);
  mock.timers.tick(TOAST_EXIT_MS);
  assert.equal(currentToasts().length, 0);
});
