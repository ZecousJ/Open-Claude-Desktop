import test from "node:test";
import assert from "node:assert/strict";
import { watchComposerWidth } from "../../src/composer/composer-fit";
import type { ComposerField } from "../../src/composer/composer-field";

function environment(maxHeight: string) {
  const observers: { callback: () => void; targets: unknown[] }[] = [];
  class Observer {
    entry = { callback: () => {}, targets: [] as unknown[] };
    constructor(callback: () => void) {
      this.entry.callback = callback;
      observers.push(this.entry);
    }
    observe(target: unknown) {
      this.entry.targets.push(target);
    }
    disconnect() {
      this.entry.targets.length = 0;
    }
  }
  const saved = {
    ResizeObserver: (globalThis as any).ResizeObserver,
    getComputedStyle: (globalThis as any).getComputedStyle,
  };
  Object.assign(globalThis, {
    ResizeObserver: Observer,
    getComputedStyle: () => ({ maxHeight }),
  });
  const field = (state: Partial<Record<string, unknown>> = {}) =>
    ({
      isConnected: true,
      clientWidth: 600,
      scrollHeight: 100,
      style: { height: "" },
      ...state,
    }) as unknown as ComposerField;
  return {
    observers,
    field,
    restore: () => Object.assign(globalThis, saved),
  };
}

test("a draft box is measured again when its width changes, and when it mounts", () => {
  const env = environment("380px");
  try {
    const box = env.field();
    watchComposerWidth(box);
    watchComposerWidth(box);
    // Watched once, however often the ref is set.
    assert.equal(env.observers.length, 1);
    // The first callback is the mount: a fresh textarea gets its height.
    env.observers[0].callback();
    assert.equal(box.style.height, "100px");
    // The same width is not measured again (our own height change fires it).
    (box as any).scrollHeight = 250;
    env.observers[0].callback();
    assert.equal(box.style.height, "100px");
    // A side panel narrows the box: more lines, up to the Code cap.
    (box as any).clientWidth = 300;
    env.observers[0].callback();
    assert.equal(box.style.height, "250px");
    (box as any).scrollHeight = 900;
    (box as any).clientWidth = 200;
    env.observers[0].callback();
    assert.equal(box.style.height, "380px");
  } finally {
    env.restore();
  }
});

test("a removed box stops being watched and the rich field is left alone", () => {
  const env = environment("370px");
  try {
    const gone = env.field();
    watchComposerWidth(gone);
    (gone as any).isConnected = false;
    env.observers[0].callback();
    assert.equal(env.observers[0].targets.length, 0);
    assert.equal(gone.style.height, "");
    const rich = env.field({ resizeToContent() {} });
    watchComposerWidth(rich);
    env.observers[1].callback();
    assert.equal(rich.style.height, "");
    watchComposerWidth(null);
    assert.equal(env.observers.length, 2);
  } finally {
    env.restore();
  }
});
