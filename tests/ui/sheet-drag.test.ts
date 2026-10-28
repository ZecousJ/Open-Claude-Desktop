import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef } from "react";
import { parseHTML } from "linkedom";
import { useSheetDrag } from "../../src/ui/sheet-drag";

async function withSheet(
  run: (sheet: {
    element(): HTMLElement;
    closed: string[];
    render(identity?: string, enabled?: boolean): Promise<void>;
    unmount(): Promise<void>;
    drag(distance?: number, duration?: number): Promise<void>;
    tick(milliseconds: number): Promise<void>;
    pending(): number[];
    clickAbove(): Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: () => ({ position: "fixed" }),
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++sequence;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const dateNow = Date.now;
  Date.now = () => now;
  const closed: string[] = [];
  function Harness({
    identity,
    enabled,
  }: {
    identity: string;
    enabled: boolean;
  }) {
    const ref = useRef<HTMLElement>(null);
    useSheetDrag(ref, () => closed.push(identity), enabled, identity);
    return createElement(
      "section",
      { ref },
      createElement("header", null, identity),
    );
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const element = () => document.querySelector<HTMLElement>("section")!;
  let unmounted = false;
  const render = async (identity = "conversation-a:file-a", enabled = true) => {
    await act(async () =>
      root.render(createElement(Harness, { identity, enabled })),
    );
    Object.defineProperty(element(), "offsetHeight", {
      configurable: true,
      value: 600,
    });
    Object.assign(element(), { getAnimations: () => [] });
  };
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
  };
  const touch = (type: string, y: number) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", {
      value: type === "touchend" ? [] : [{ clientX: 100, clientY: y }],
    });
    element().querySelector("header")!.dispatchEvent(event);
  };
  try {
    await render();
    await run({
      element,
      closed,
      render,
      unmount,
      drag: async (distance = 200, duration = 600) => {
        await act(() => {
          touch("touchstart", 100);
          now += duration;
          touch("touchmove", 100 + distance);
          touch("touchend", 100 + distance);
        });
      },
      tick: async (milliseconds) => {
        const until = now + milliseconds;
        await act(() => {
          for (;;) {
            const next = [...timers.entries()]
              .filter(([, timer]) => timer.at <= until)
              .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            timers.delete(next[0]);
            now = next[1].at;
            next[1].callback();
          }
          now = until;
        });
      },
      pending: () => [...timers.values()].map((timer) => timer.at - now),
      clickAbove: async () => {
        const event = new window.Event("click", { bubbles: true });
        Object.defineProperty(event, "clientY", { value: -10 });
        await act(() => element().dispatchEvent(event));
      },
    });
  } finally {
    await unmount();
    Date.now = dateNow;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function assertReset(element: HTMLElement) {
  assert.equal(element.dataset.dismissed, undefined);
  assert.equal(element.style.transform, "");
  assert.equal(element.style.transition, "");
  assert.equal(element.style.getPropertyValue("--sheet-dim") ?? "", "");
}

test("phone sheet keeps the existing 190ms dismissal and 240ms snap-back timings", async () => {
  await withSheet(async (sheet) => {
    await sheet.drag(200, 600);
    assert.equal(sheet.element().dataset.dismissed, "true");
    assert.equal(sheet.element().style.transform, "translateY(600px)");
    assert.deepEqual(sheet.pending(), [190]);
    await sheet.tick(189);
    assert.deepEqual(sheet.closed, []);
    await sheet.tick(1);
    assert.deepEqual(sheet.closed, ["conversation-a:file-a"]);
  });
  await withSheet(async (sheet) => {
    await sheet.drag(60, 600);
    assert.equal(sheet.element().dataset.dismissed, undefined);
    assert.equal(sheet.element().style.transform, "");
    assert.match(sheet.element().style.transition, /0.22s/);
    assert.deepEqual(sheet.pending(), [240]);
    await sheet.tick(239);
    assert.match(sheet.element().style.transition, /0.22s/);
    await sheet.tick(1);
    assert.equal(sheet.element().style.transition, "");
    assert.deepEqual(sheet.closed, []);
  });
});

for (const identity of ["conversation-a:file-b", "conversation-b:file-a"]) {
  test(`a pending dismissal cannot close the reused sheet for ${identity}`, async () => {
    await withSheet(async (sheet) => {
      await sheet.drag();
      assert.deepEqual(sheet.pending(), [190]);
      await sheet.render(identity);
      await sheet.tick(500);
      assert.deepEqual(sheet.closed, []);
      assertReset(sheet.element());
      assert.deepEqual(sheet.pending(), []);
      await sheet.drag();
      await sheet.tick(190);
      assert.deepEqual(sheet.closed, [identity]);
    });
  });
}

test("unmount cancels a pending dismissal without calling a stale close callback", async () => {
  await withSheet(async (sheet) => {
    await sheet.drag();
    const old = sheet.element();
    await sheet.unmount();
    assert.deepEqual(sheet.pending(), []);
    assertReset(old);
    await sheet.tick(500);
    assert.deepEqual(sheet.closed, []);
  });
});

test("a completed, removed sheet keeps the marker that prevents a second spring exit", async () => {
  await withSheet(async (sheet) => {
    await sheet.drag();
    await sheet.tick(190);
    const old = sheet.element();
    await sheet.unmount();
    assert.equal(old.dataset.dismissed, "true");
    assert.equal(old.style.transform, "translateY(600px)");
    assert.deepEqual(sheet.pending(), []);
    assert.deepEqual(sheet.closed, ["conversation-a:file-a"]);
  });
});

test("a reused node resets even after its prior dismissal completed", async () => {
  await withSheet(async (sheet) => {
    await sheet.drag();
    await sheet.tick(190);
    await sheet.render("conversation-a:file-b");
    assertReset(sheet.element());
    await sheet.drag();
    await sheet.tick(190);
    assert.deepEqual(sheet.closed, [
      "conversation-a:file-a",
      "conversation-a:file-b",
    ]);
  });
});

test("expanding or disabling the phone sheet cancels its pending close and styles", async () => {
  await withSheet(async (sheet) => {
    await sheet.drag();
    await sheet.render("conversation-a:file-a", false);
    assertReset(sheet.element());
    assert.deepEqual(sheet.pending(), []);
    await sheet.tick(500);
    assert.deepEqual(sheet.closed, []);
    await sheet.drag();
    assert.deepEqual(sheet.pending(), []);
  });
});

test("switching during snap-back resets styles and cancels the old transition timer", async () => {
  await withSheet(async (sheet) => {
    await sheet.drag(60, 600);
    assert.deepEqual(sheet.pending(), [240]);
    await sheet.render("conversation-a:file-b");
    assertReset(sheet.element());
    assert.deepEqual(sheet.pending(), []);
    await sheet.drag();
    await sheet.tick(240);
    assert.deepEqual(sheet.closed, ["conversation-a:file-b"]);
  });
});

test("a backdrop dismissal belongs to its own document too", async () => {
  await withSheet(async (sheet) => {
    await sheet.clickAbove();
    assert.equal(sheet.element().dataset.dismissed, "true");
    await sheet.render("conversation-a:file-b");
    assertReset(sheet.element());
    await sheet.tick(190);
    assert.deepEqual(sheet.closed, []);
  });
});
