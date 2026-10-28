import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { ReplyToolbarButton } from "../../src/transcript/ReplyToolbarButton";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost, webHost } from "../../shared/host";
import { UnavailableDictationButton } from "../../src/composer/voice/DictationButton";
import { CopyButton } from "../../src/ui/Controls";
import {
  ConversationServicesContext,
  desktopConversationServices,
} from "../../src/conversation/ConversationServices";
import { readSource } from "../support/read-source";

const css = readSource(
  new URL("../../src/transcript/chat-transcript.css", import.meta.url),
  "utf8",
);
function hiddenContract(source: string) {
  const rule = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selector, body]) =>
      selector.includes(".app.web:not(.mobile-conversation)") &&
      selector.includes('.copy-tooltip:not([data-open="true"])') &&
      /display:\s*none/.test(body),
  );
  assert.ok(rule, "hidden web reply tooltips must not have an overflow box");
  return rule[1].trim();
}
test("closed tooltip CSS excludes its box, retains accessible label, and leaves native/open states alone", () => {
  const selector = hiddenContract(css);
  const { document } = parseHTML(
    '<html><body><div class="app web"><button aria-label="More options"><span id="closed" class="copy-tooltip" data-open="false">More options</span><span id="open" class="copy-tooltip" data-open="true">More options</span></button></div><div class="app web mobile-conversation"><span class="copy-tooltip" data-open="false" id="native"></span></div></body></html>',
  );
  assert.deepEqual(
    [...document.querySelectorAll(selector)].map((node) => node.id),
    ["closed"],
  );
  assert.equal(
    document.querySelector("button")?.getAttribute("aria-label"),
    "More options",
  );
  assert.throws(
    () =>
      hiddenContract(
        css.replace(
          /(\.app\.web:not\(\.mobile-conversation\) \.copy-tooltip:not\(\[data-open="true"\]\)\s*\{)\s*display:\s*none;/,
          "$1 visibility:hidden;",
        ),
      ),
    /overflow box/,
  );
});

async function environment() {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.innerWidth = 390;
  window.innerHeight = 844;
  let client = 374,
    naturalWidth = 96.048,
    center = 350.98,
    authoredMaxWidth = "none";
  class Resize {
    static all: Resize[] = [];
    disconnected = false;
    constructor(readonly callback: ResizeObserverCallback) {
      Resize.all.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    unobserve() {}
    emit() {
      this.callback([], this as unknown as ResizeObserver);
    }
  }
  const oldRect = window.HTMLElement.prototype.getBoundingClientRect;
  const oldClient = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "clientWidth",
  );
  const oldClientLeft = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "clientLeft",
  );
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.classList.contains("messages-scroll") ? client : 390;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientLeft", {
    configurable: true,
    get: () => 0,
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width =
      this.classList.contains("copy-tooltip") ||
      this.classList.contains("dictation-tooltip")
        ? Math.min(naturalWidth, parseFloat(this.style.maxWidth) || Infinity)
        : 390;
    const left =
      this.classList.contains("copy-tooltip") ||
      this.classList.contains("dictation-tooltip")
        ? center - width / 2 + (parseFloat(this.style.translate) || 0)
        : 0;
    return {
      left,
      right: left + width,
      top: 100,
      bottom: 124,
      width,
      height: 24,
      x: left,
      y: 100,
      toJSON: () => ({}),
    };
  };
  const globals = {
    window,
    document,
    ResizeObserver: Resize,
    getComputedStyle: (node: HTMLElement) => ({
      maxWidth: authoredMaxWidth,
      overflowX: node.classList.contains("messages-scroll")
        ? "auto"
        : "visible",
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
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
  window.getComputedStyle =
    globals.getComputedStyle as unknown as typeof getComputedStyle;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  function View({
    label = "More options",
    copy = false,
  }: {
    label?: string;
    copy?: boolean;
  }) {
    return createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(
        "div",
        { className: "app web" },
        createElement(
          "div",
          { className: "messages-scroll" },
          copy
            ? createElement(
                ConversationServicesContext.Provider,
                {
                  value: {
                    ...desktopConversationServices,
                    copyText: async () => {
                      throw new Error("Synthetic copy failure");
                    },
                  },
                },
                createElement(CopyButton, {
                  text: "const a = 1",
                  iconOnly: true,
                  codeBlock: true,
                  rich: false,
                }),
              )
            : createElement(ReplyToolbarButton, {
                label,
                onClick() {},
                children: "…",
              }),
        ),
      ),
    );
  }
  return {
    document,
    window,
    Resize,
    width: (value: number) => {
      client = value;
    },
    maxWidth: (value: string) => {
      authoredMaxWidth = value;
    },
    textWidth: (value: number) => {
      naturalWidth = value;
    },
    center: (value: number) => {
      center = value;
    },
    render: (label?: string) =>
      act(async () => root.render(createElement(View, { label }))),
    renderMic: (native = false) =>
      act(async () =>
        root.render(
          createElement(
            HostContext.Provider,
            { value: native ? desktopHost : webHost },
            createElement(
              "div",
              { className: "messages-scroll" },
              createElement(UnavailableDictationButton, {
                reason: "fixture",
                containTooltip: true,
              }),
            ),
          ),
        ),
      ),
    renderCopy: () =>
      act(async () => root.render(createElement(View, { copy: true }))),
    click: () =>
      act(async () =>
        document
          .querySelector("button")!
          .dispatchEvent(new window.Event("click", { bubbles: true })),
      ),
    async open() {
      await act(async () => {
        document
          .querySelector("button")!
          .dispatchEvent(new window.Event("focusin", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
    },
    async key(key: string) {
      const event = new window.Event("keydown", { bubbles: true });
      Object.assign(event, { key });
      await act(async () =>
        document.querySelector("button")!.dispatchEvent(event),
      );
    },
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.getBoundingClientRect = oldRect;
      if (oldClient)
        Object.defineProperty(
          window.HTMLElement.prototype,
          "clientWidth",
          oldClient,
        );
      else Reflect.deleteProperty(window.HTMLElement.prototype, "clientWidth");
      if (oldClientLeft)
        Object.defineProperty(
          window.HTMLElement.prototype,
          "clientLeft",
          oldClientLeft,
        );
      else Reflect.deleteProperty(window.HTMLElement.prototype, "clientLeft");
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("real More options opens at the existing delay, clamps to the scroll client edge, and Escape cleans up", async () => {
  const env = await environment();
  try {
    await env.render();
    const tip = env.document.querySelector<HTMLElement>(".copy-tooltip")!;
    assert.equal(tip.getAttribute("data-open"), "false");
    await env.open();
    assert.equal(tip.getAttribute("data-open"), "true");
    assert.ok(Math.abs(tip.getBoundingClientRect().right - 374) < 0.001);
    assert.equal(
      env.document.querySelector("button")?.getAttribute("aria-describedby"),
      tip.id,
    );
    env.width(320);
    env.Resize.all[0].emit();
    assert.ok(Math.abs(tip.getBoundingClientRect().right - 320) < 0.001);
    env.center(100);
    env.window.dispatchEvent(new env.window.Event("scroll"));
    assert.equal(tip.style.getPropertyValue("translate"), undefined);
    env.textWidth(500);
    await env.render("A long translated tooltip");
    assert.equal(tip.style.whiteSpace, "normal");
    assert.ok(tip.getBoundingClientRect().left >= 8);
    assert.ok(tip.getBoundingClientRect().right <= 320);
    await env.key("Escape");
    assert.equal(tip.getAttribute("data-open"), "false");
    assert.equal(
      env.document.querySelector("button")?.getAttribute("aria-describedby"),
      null,
    );
    assert.ok(env.Resize.all.every((observer) => observer.disconnected));
    assert.equal(tip.style.getPropertyValue("translate"), undefined);
  } finally {
    await env.restore();
  }
});

test("actual code-block Copy failed tooltip shares the clamp without changing its accessible action", async () => {
  const env = await environment();
  try {
    env.center(365);
    env.textWidth(140);
    await env.renderCopy();
    await env.click();
    const button = env.document.querySelector("button")!;
    const tip = button.querySelector<HTMLElement>(".copy-tooltip")!;
    assert.equal(button.getAttribute("data-testid"), "code-block-copy");
    assert.equal(button.getAttribute("aria-label"), "Copy to clipboard");
    assert.equal(tip.textContent, "Copy failed");
    assert.equal(tip.getAttribute("data-open"), "true");
    assert.ok(
      tip.getBoundingClientRect().right <= 374,
      "Copy failed must not extend the scroll client width",
    );
    assert.equal(button.getAttribute("aria-describedby"), tip.id);
    await env.key("Escape");
    assert.equal(tip.getAttribute("data-open"), "false");
    assert.equal(button.getAttribute("aria-label"), "Copy to clipboard");
    assert.ok(env.Resize.all.every((observer) => observer.disconnected));
  } finally {
    await env.restore();
  }
});

test("Code home microphone hints stay clamped while hidden, focused and blurred on web and desktop without changing opacity timing", async () => {
  for (const native of [false, true]) {
    const env = await environment();
    try {
      env.center(365);
      env.maxWidth("240px");
      env.textWidth(199);
      await env.renderMic(native);
      const tip =
        env.document.querySelector<HTMLElement>(".dictation-tooltip")!;
      assert.equal(tip.getAttribute("data-open"), "false");
      assert.ok(tip.getBoundingClientRect().right <= 374);
      await act(async () =>
        env.document
          .querySelector("button")!
          .dispatchEvent(new env.window.Event("focusin", { bubbles: true })),
      );
      assert.equal(tip.getAttribute("data-open"), "true");
      assert.ok(tip.getBoundingClientRect().right <= 374);
      await act(async () =>
        env.document
          .querySelector("button")!
          .dispatchEvent(new env.window.Event("focusout", { bubbles: true })),
      );
      assert.equal(tip.getAttribute("data-open"), "false");
      assert.ok(tip.getBoundingClientRect().right <= 374);
      env.width(320);
      env.textWidth(500);
      env.Resize.all[env.Resize.all.length - 1].emit();
      assert.ok(tip.getBoundingClientRect().right <= 320);
      assert.equal(tip.style.whiteSpace, "normal");
      assert.equal(tip.style.maxWidth, "240px");
    } finally {
      await env.restore();
    }
  }
  const mic = readSource("src/composer/voice/DictationButton.tsx", "utf8"),
    composer = readSource("src/composer/Composer.tsx", "utf8");
  assert.match(mic, /ref=\{tooltipRef\}/);
  assert.match(composer, /containTooltip=\{codeHomeDraft\}/);
  const style = readSource("src/composer/voice/dictation.css", "utf8");
  assert.match(style, /opacity 35ms/);
  assert.match(style, /transition-duration: 50ms/);
});
