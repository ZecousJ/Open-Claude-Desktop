import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  createElement,
  StrictMode,
  Suspense,
  startTransition,
  useState,
} from "react";
import { parseHTML } from "linkedom";
import { Modal } from "../../src/ui/Controls";

async function environment(reduced = true) {
  const { window, document } = parseHTML(
    '<html><body><button id="opener">Open</button><main></main></body></html>',
  );
  if (reduced) document.documentElement.dataset.motion = "reduced";
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
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
  const prototype = window.HTMLElement.prototype;
  const focus = Object.getOwnPropertyDescriptor(prototype, "focus");
  let focused: HTMLElement | undefined;
  prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const add = document.addEventListener.bind(document),
    remove = document.removeEventListener.bind(document);
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let registrations = 0,
    removals = 0;
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "keydown") {
      listeners.add(listener);
      registrations++;
    }
    add(type, listener, options);
  }) as Document["addEventListener"];
  document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "keydown") {
      listeners.delete(listener);
      removals++;
    }
    remove(type, listener, options);
  }) as Document["removeEventListener"];
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const render = async (element: ReturnType<typeof createElement> | null) => {
    await act(async () => {
      root.render(element);
    });
  };
  const event = async (
    target: Element | Document,
    type: string,
    values: Record<string, unknown> = {},
  ) => {
    const next = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(next, values);
    await act(async () => {
      target.dispatchEvent(next);
    });
    return next;
  };
  const escape = () => event(document, "keydown", { key: "Escape" });
  const clean = async () => {
    await act(async () => root.unmount());
    if (focus) Object.defineProperty(prototype, "focus", focus);
    else Reflect.deleteProperty(prototype, "focus");
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    document,
    render,
    event,
    escape,
    clean,
    stats: () => ({ registrations, removals, active: listeners.size }),
  };
}

const modal = (
  onClose: () => void,
  extra: Partial<Parameters<typeof Modal>[0]> = {},
) =>
  createElement(Modal, {
    title: "Callback dialog",
    onClose,
    children: createElement("input", { id: "field" }),
    ...extra,
  });

test("Modal Escape and backdrop use the latest committed callback without rebinding the focus trap", async () => {
  const page = await environment();
  const calls: string[] = [];
  const show = (value: string) =>
    page.render(
      modal(() => calls.push(value), {
        title: "Literal {title}",
        titleIsUserData: true,
      }),
    );
  try {
    page.document.querySelector<HTMLElement>("#opener")!.focus();
    await show("A");
    const dialog = page.document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.getAttribute("aria-label"), null);
    assert.equal(
      dialog.getAttribute("aria-labelledby"),
      dialog.querySelector("h2")!.id,
    );
    assert.equal(dialog.querySelector("h2")!.textContent, "Literal {title}");
    const before = page.stats();
    await show("B");
    assert.deepEqual(
      page.stats(),
      before,
      "a new callback must not tear down focus or the key listener",
    );
    await page.escape();
    await page.event(page.document.querySelector(".overlay")!, "mousedown");
    assert.deepEqual(calls, ["B", "B"]);
    assert.ok(
      page.document.activeElement === page.document.querySelector("#field"),
    );
    await page.render(null);
    assert.equal(page.stats().active, 0);
    assert.ok(
      page.document.activeElement === page.document.querySelector("#opener"),
    );
    await page.escape();
    assert.deepEqual(calls, ["B", "B"]);
  } finally {
    await page.clean();
  }
});

test("Modal Escape respects the latest state-based busy guard just as its backdrop does", async () => {
  const page = await environment();
  let closes = 0;
  const show = (busy: boolean) =>
    page.render(
      modal(
        () => {
          if (!busy) closes++;
        },
        { disablePointerDismissal: busy },
      ),
    );
  try {
    await show(false);
    await show(true);
    await page.escape();
    await page.event(page.document.querySelector(".overlay")!, "mousedown");
    assert.equal(
      closes,
      0,
      "a newly committed busy state must gate keyboard and pointer dismissal",
    );
    await show(false);
    await page.escape();
    assert.equal(closes, 1);
  } finally {
    await page.clean();
  }
});

test("Modal never exposes an uncommitted suspended render's callback", async () => {
  const page = await environment();
  const calls: string[] = [];
  let update!: (value: string) => void, resume!: () => void;
  let pending = true;
  const pause = new Promise<void>((done) => {
    resume = () => {
      pending = false;
      done();
    };
  });
  function Block({ value }: { value: string }) {
    if (value === "B" && pending) throw pause;
    return null;
  }
  function App() {
    const [value, setValue] = useState("A");
    update = setValue;
    return createElement(
      Suspense,
      { fallback: createElement("p", {}, "Loading") },
      modal(() => calls.push(value)),
      createElement(Block, { value }),
    );
  }
  try {
    await page.render(createElement(App));
    await act(async () => {
      startTransition(() => update("B"));
    });
    await page.escape();
    await page.event(page.document.querySelector(".overlay")!, "mousedown");
    assert.deepEqual(
      calls,
      ["A", "A"],
      "the visible A dialog must retain A for keyboard and pointer while B has not committed",
    );
    await act(async () => resume());
    await page.escape();
    assert.deepEqual(calls, ["A", "A", "B"]);
  } finally {
    await page.clean();
  }
});

test("Modal StrictMode retains exactly one active listener and latest callback after an update", async () => {
  const page = await environment();
  const calls: string[] = [];
  const show = (value: string) =>
    page.render(
      createElement(
        StrictMode,
        {},
        modal(() => calls.push(value)),
      ),
    );
  try {
    await show("A");
    assert.equal(page.stats().active, 1);
    const before = page.stats();
    await show("B");
    await page.escape();
    assert.deepEqual(calls, ["B"]);
    assert.deepEqual(page.stats(), before);
    await page.render(null);
    assert.equal(page.stats().active, 0);
  } finally {
    await page.clean();
  }
});

test("Modal exit nodes cannot receive old keyboard callbacks after listener cleanup", async () => {
  const page = await environment(false);
  let closed = 0;
  try {
    page.document.querySelector<HTMLElement>("#opener")!.focus();
    await page.render(modal(() => closed++));
    await page.render(null);
    const exiting = page.document.querySelector('[data-state="closed"]');
    assert.ok(exiting);
    assert.equal(page.stats().active, 0);
    assert.equal(exiting.getAttribute("aria-hidden"), "true");
    await page.escape();
    assert.equal(closed, 0);
    assert.ok(
      page.document.activeElement === page.document.querySelector("#opener"),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    assert.equal(page.document.querySelector('[data-state="closed"]'), null);
  } finally {
    await page.clean();
  }
});

test("nested Modal Escape, Tab, exit and reopen keep only the top committed dialog active", async () => {
  const page = await environment(false);
  const calls: string[] = [];
  function Nested() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(0);
    const [opened, setOpened] = useState(false);
    return outer
      ? createElement(Modal, {
          title: "Outer",
          onClose: () => {
            calls.push("outer");
            setOuter(false);
          },
          children: [
            createElement("input", { id: "outer-field", key: "field" }),
            createElement(
              "button",
              {
                id: "open-inner",
                key: "trigger",
                onClick: () => {
                  setInner((value) => value + 1);
                  setOpened(true);
                },
              },
              "Open inner",
            ),
            opened &&
              createElement(Modal, {
                key: "inner",
                title: "Inner",
                onClose: () => {
                  calls.push(`inner-${inner}`);
                  setOpened(false);
                },
                children: createElement("button", { id: "inner-last" }, "Last"),
              }),
          ],
        })
      : null;
  }
  const openInner = async () => {
    await act(async () => {
      const trigger = page.document.querySelector<HTMLElement>("#open-inner")!;
      trigger.focus();
      trigger.click();
    });
  };
  try {
    page.document.querySelector<HTMLElement>("#opener")!.focus();
    await page.render(createElement(Nested));
    await openInner();
    assert.equal(page.stats().active, 2);
    page.document.querySelector<HTMLElement>("#inner-last")!.focus();
    await page.event(page.document, "keydown", { key: "Tab" });
    assert.equal(
      page.document.activeElement
        ?.closest('[role="dialog"]')
        ?.getAttribute("aria-label"),
      "Inner",
      "the covered outer trap cannot steal Tab from the inner dialog",
    );
    await page.escape();
    assert.deepEqual(calls, ["inner-1"]);
    assert.equal(page.stats().active, 1);
    assert.ok(
      page.document.activeElement ===
        page.document.querySelector("#open-inner"),
    );
    assert.ok(
      page.document.querySelector('[data-state="closed"]'),
      "the closed inner may remain for its exit, without a key listener",
    );
    await openInner();
    assert.equal(page.stats().active, 2);
    await page.escape();
    assert.deepEqual(calls, ["inner-1", "inner-2"]);
    await page.escape();
    assert.deepEqual(calls, ["inner-1", "inner-2", "outer"]);
    assert.equal(page.stats().active, 0);
    assert.ok(
      page.document.activeElement === page.document.querySelector("#opener"),
    );
    await page.escape();
    assert.equal(calls.length, 3);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    assert.equal(page.document.querySelector('[data-state="closed"]'), null);
  } finally {
    await page.clean();
  }
});
