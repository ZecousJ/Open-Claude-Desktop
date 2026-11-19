import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { mountCodeLandingTexture } from "../../src/code-home/CodeLandingTexture";
import type { TextureTouchFrame } from "../../src/code-home/landing-texture-model";

test("the actual texture lifecycle delays startup, excludes controls, pauses, resumes and cleans up", async () => {
  const { window, document } = parseHTML(
    '<html><body><main><div id="texture"></div><button id="control">Control</button></main></body></html>',
  );
  const host = document.querySelector<HTMLDivElement>("#texture")!;
  host.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 480,
    height: 320,
    left: 0,
    top: 0,
    right: 480,
    bottom: 320,
    toJSON() {},
  });
  let now = 0,
    sequence = 0,
    hidden = false,
    focus = true,
    reduced = false,
    contrast = false,
    destroyed = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const later = (fn: () => void, delay = 0) => {
    const id = ++sequence;
    tasks.set(id, { at: now + delay, fn });
    return id;
  };
  const media = new Map<string, () => void>(),
    observers = new Set<object>();
  class Observer {
    constructor(readonly callback: () => void) {
      observers.add(this);
    }
    observe() {}
    disconnect() {
      observers.delete(this);
    }
  }
  const draws: { time: number; reveal: number; touch?: TextureTouchFrame }[] =
    [];
  const originalCreate = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const e = originalCreate(tag);
    if (tag === "canvas")
      Object.assign(e, {
        getContext: () => ({
          fillStyle: "",
          fillRect() {},
          getImageData: () => ({ data: new Uint8Array([137, 135, 129, 255]) }),
        }),
      });
    return e;
  }) as typeof document.createElement;
  Object.defineProperties(document, {
    hidden: { configurable: true, get: () => hidden },
    hasFocus: { configurable: true, value: () => focus },
    fonts: { configurable: true, value: { load: async () => [] } },
  });
  const globals = {
    window,
    document,
    Element: window.Element,
    performance: { now: () => now },
    ResizeObserver: Observer,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({
      color: "rgb(137,135,129)",
      fontFamily: "monospace",
    }),
    matchMedia: (query: string) => ({
      get matches() {
        return query.includes("contrast") ? contrast : reduced;
      },
      addEventListener(_type: string, fn: () => void) {
        media.set(query, fn);
      },
      removeEventListener() {
        media.delete(query);
      },
    }),
    setTimeout: later,
    clearTimeout: (id: number) => tasks.delete(id),
    requestAnimationFrame: (fn: (at: number) => void) =>
      later(() => fn(now), 16),
    cancelAnimationFrame: (id: number) => tasks.delete(id),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const renderer = {
    canvas: document.createElement("canvas"),
    resize: () => true,
    setInk() {},
    setGlow() {},
    draw(frame: { time: number; reveal: number; touch?: TextureTouchFrame }) {
      draws.push(frame);
    },
    fellBehind: () => false,
    destroy() {
      destroyed++;
      this.canvas.remove();
    },
  };
  const load = async () => ({
    createTextureRenderer: async () => {
      host.append(renderer.canvas);
      return renderer;
    },
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      tasks.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const click = (target: Element) => {
    const e = new window.Event("pointerdown", { bubbles: true });
    Object.assign(e, { button: 0, clientX: 200, clientY: 120 });
    target.dispatchEvent(e);
  };
  let cleanup = () => {};
  try {
    cleanup = mountCodeLandingTexture(host, load);
    await advance(2999);
    assert.equal(draws.length, 0);
    await advance(1);
    assert.ok(draws.length > 0);
    assert.equal(host.dataset.textureState, "moving");
    click(document.querySelector("#control")!);
    await advance(100);
    assert.equal(draws.at(-1)?.touch?.tapCount, 0);
    click(host);
    await advance(100);
    assert.equal(draws.at(-1)?.touch?.tapCount, 1);
    click(host);
    click(host);
    await advance(100);
    assert.ok((draws.at(-1)?.touch?.taps[11] ?? 0) < 0);
    reduced = true;
    media.forEach((fn) => fn());
    const count = draws.length;
    await advance(1000);
    assert.equal(draws.length, count);
    assert.equal(host.dataset.textureState, "still");
    assert.equal(draws.at(-1)?.touch, undefined);
    reduced = false;
    media.forEach((fn) => fn());
    await advance(100);
    assert.ok(draws.length > count);
    hidden = true;
    document.dispatchEvent(new window.Event("visibilitychange"));
    const unseen = draws.length;
    await advance(1000);
    assert.equal(draws.length, unseen);
    assert.equal(host.dataset.textureState, "unseen");
    hidden = false;
    document.dispatchEvent(new window.Event("visibilitychange"));
    await advance(100);
    assert.ok(draws.length > unseen);
    focus = false;
    window.dispatchEvent(new window.Event("blur"));
    const blurred = draws.length;
    await advance(100);
    assert.equal(draws.length, blurred);
    focus = true;
    window.dispatchEvent(new window.Event("focus"));
    await advance(100);
    assert.ok(draws.length > blurred);
    await advance(190000);
    assert.equal(host.dataset.textureState, "calm");
    assert.equal(tasks.size, 0);
    click(host);
    await advance(100);
    assert.equal(host.dataset.textureState, "moving");
    assert.ok(tasks.size > 0);
    contrast = true;
    media.forEach((fn) => fn());
    const hiddenContrast = draws.length;
    await advance(100);
    assert.equal(draws.length, hiddenContrast);
    assert.equal(renderer.canvas.style.visibility, "hidden");
    cleanup();
    cleanup = () => {};
    assert.equal(tasks.size, 0);
    assert.equal(observers.size, 0);
    assert.equal(media.size, 0);
    assert.equal(destroyed, 1);
  } finally {
    cleanup();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
