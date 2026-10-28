import test from "node:test";
import assert from "node:assert/strict";
import { artifactToolReadiness } from "../../shared/artifact-tool-readiness";

test("tool approvals wait 500ms, defer while the frame or a held pointer has focus, and rearm on unmatched input", () => {
  const document = Object.assign(new EventTarget(), {
    activeElement: { tagName: "IFRAME" },
    hidden: false,
  });
  const timers = new Map<number, () => void>();
  const states: boolean[] = [];
  let sequence = 0;
  const release = artifactToolReadiness(
    document as unknown as Document,
    (ready) => states.push(ready),
    {
      set(callback, delay) {
        assert.equal(delay, 500);
        const id = ++sequence;
        timers.set(id, callback);
        return id;
      },
      clear(timer) {
        timers.delete(timer as number);
      },
    },
  );
  const advance = () => {
    const current = [...timers];
    timers.clear();
    for (const [, callback] of current) callback();
  };
  const pointer = (type: string, pointerId: number) =>
    document.dispatchEvent(Object.assign(new Event(type), { pointerId }));
  assert.deepEqual(states, []);
  advance();
  assert.deepEqual(states, []);
  document.activeElement = { tagName: "DIV" };
  pointer("pointerdown", 1);
  advance();
  assert.equal(states.at(-1), false);
  pointer("pointerup", 1);
  advance();
  assert.equal(states.at(-1), true);
  pointer("pointerup", 2);
  assert.equal(states.at(-1), false);
  advance();
  assert.equal(states.at(-1), true);
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(states.at(-1), false);
  release();
  assert.equal(timers.size, 0);
  pointer("pointerup", 3);
  assert.equal(timers.size, 0);
});
