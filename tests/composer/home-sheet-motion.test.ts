import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useRef, useState } from "react";
import { routineDom } from "../support/routine-dom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import {
  ComposerSheetBack,
  useComposerMenuSheet,
} from "../../src/composer/menu-sheet";
import { MenuSheetScrim } from "../../src/composer/MenuSheetScrim";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { MicrophoneMenu } from "../../src/composer/MicrophoneMenu";

async function fixture({ motion = true, topLayer = true } = {}) {
  const f = await routineDom({}, { jsdom: true });
  f.document.documentElement.dataset.motion = motion ? "normal" : "reduced";
  f.window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)",
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const globals = {
    innerWidth: 900,
    innerHeight: 900,
    HTMLInputElement: f.window.HTMLInputElement,
    addEventListener: f.window.addEventListener.bind(f.window),
    removeEventListener: f.window.removeEventListener.bind(f.window),
    dispatchEvent: f.window.dispatchEvent.bind(f.window),
  };
  const old = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, v] of Object.entries(globals))
    Object.defineProperty(globalThis, k, { value: v, configurable: true });
  const proto = f.window.HTMLElement.prototype;
  const popover = Object.getOwnPropertyDescriptor(proto, "showPopover"),
    hide = Object.getOwnPropertyDescriptor(proto, "hidePopover");
  if (topLayer) {
    Object.defineProperty(proto, "showPopover", {
      configurable: true,
      value: function (this: HTMLElement) {
        this.dataset.fixtureTopLayer = "true";
      },
    });
    Object.defineProperty(proto, "hidePopover", {
      configurable: true,
      value: function (this: HTMLElement) {
        delete this.dataset.fixtureTopLayer;
      },
    });
  }
  let app = {
    accountId: "sheet-account",
    controllerScope: {},
    activeId: "chat-a",
    page: "home",
    draftSession: "draft-a",
    snapshot: { settings: { mcpServers: {}, providers: [] } },
    composerDraft: { draftConnectors: {}, draftConnectorTools: {} },
  } as unknown as AppController;
  app.currentController = { current: app };
  const render = (child: ReturnType<typeof h>) =>
    f.render(h(AppContext.Provider, { value: app }, child));
  return {
    ...f,
    render,
    replace(patch: Partial<AppController>) {
      const next = { ...app, ...patch };
      app.currentController!.current = next;
      app = next;
    },
    async clean() {
      await f.clean();
      for (const [k, v] of old)
        if (v) Object.defineProperty(globalThis, k, v);
        else Reflect.deleteProperty(globalThis, k);
      if (popover) Object.defineProperty(proto, "showPopover", popover);
      else Reflect.deleteProperty(proto, "showPopover");
      if (hide) Object.defineProperty(proto, "hidePopover", hide);
      else Reflect.deleteProperty(proto, "hidePopover");
    },
  };
}
function Probe({ closed = () => {} }: { closed?(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [nested, setNested] = useState(false);
  const [open, setOpen] = useState(true);
  const motion = useComposerMenuSheet(root, {
    sheet: open,
    nested,
    panel: ".motion-child",
    trigger: ".motion-trigger",
    onBack: () => setNested(false),
  });
  return h(
    "div",
    null,
    open &&
      h(MenuSheetScrim, {
        onClose: () => {
          closed();
          setOpen(false);
        },
      }),
    open &&
      h(
        "div",
        { ref: root, className: "motion-root" },
        h(
          "button",
          { className: "motion-trigger", onClick: () => setNested(true) },
          "Open child",
        ),
        h(
          "button",
          {
            className: "motion-close",
            onClick: () =>
              motion.dismiss(() => {
                closed();
                setOpen(false);
              }),
          },
          "Close",
        ),
        nested &&
          h(
            "div",
            { className: "motion-child", role: "menu" },
            h(ComposerSheetBack, { sheet: true, onBack: motion.back }),
            h("input", { "aria-label": "Search child" }),
          ),
      ),
  );
}
const root = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.document.querySelector<HTMLElement>(".motion-root")!;
const child = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.document.querySelector<HTMLElement>(".motion-child")!;
const end = (
  f: Awaited<ReturnType<typeof fixture>>,
  node: HTMLElement,
  propertyName = "translate",
) => f.event(node, "transitionend", { propertyName });

test("covered sheet uses a separate top layer, keeps the child interactive and restores original parent accessibility", async () => {
  const f = await fixture();
  try {
    await f.render(h(Probe));
    const trigger = f.document.querySelector<HTMLElement>(".motion-trigger")!;
    trigger.setAttribute("aria-hidden", "false");
    await f.event(trigger, "click");
    assert.equal(root(f).dataset.composerSheetCovered, "true");
    assert.equal(root(f).dataset.composerSheetLayered, "true");
    assert.equal(trigger.hasAttribute("inert"), true);
    assert.equal(child(f).hasAttribute("inert"), false);
    assert.equal(child(f).getAttribute("popover"), "manual");
    assert.equal(child(f).dataset.fixtureTopLayer, "true");
    await f.click('[aria-label="Back"]');
    assert.equal(child(f).dataset.composerSheetPeeling, "true");
    assert.equal(child(f).dataset.composerSheetEnding, "true");
    assert.equal(child(f).hasAttribute("inert"), true);
    assert.equal(root(f).hasAttribute("data-composer-sheet-covered"), false);
    assert.equal(trigger.getAttribute("aria-hidden"), "false");
    await end(f, child(f));
    assert.equal(child(f), null);
    assert.equal(f.document.activeElement, trigger);
    assert.equal(root(f).hasAttribute("data-composer-sheet-drilled"), false);
  } finally {
    await f.clean();
  }
});
test("peeling responds to Escape, waits for its own translate transition and ignores repeated Back and descendant transitions", async () => {
  const f = await fixture();
  try {
    await f.render(h(Probe));
    await f.click(".motion-trigger");
    const outgoing = child(f);
    await f.event(outgoing, "keydown", { key: "Escape" });
    assert.equal(outgoing.dataset.composerSheetPeeling, "true");
    await f.event(outgoing.querySelector("input")!, "transitionend", {
      propertyName: "translate",
    });
    await end(f, outgoing, "opacity");
    assert.ok(child(f));
    await f.click('[aria-label="Back"]');
    await end(f, outgoing);
    assert.equal(child(f), null);
    await f.click(".motion-trigger");
    assert.ok(child(f));
    assert.equal(child(f).hasAttribute("inert"), false);
  } finally {
    await f.clean();
  }
});
test("a nested scrim close marks the whole tree down, never peel, and completes exactly once", async () => {
  const f = await fixture();
  let closes = 0;
  try {
    await f.render(h(Probe, { closed: () => closes++ }));
    await f.click(".motion-trigger");
    const parent = root(f),
      nested = child(f);
    await f.click(".composer-menu-scrim");
    assert.equal(
      f.document.querySelector<HTMLElement>(".composer-menu-scrim")!.dataset
        .composerSheetEnding,
      "true",
    );
    assert.equal(parent.dataset.composerSheetTreeClosing, "true");
    assert.equal(nested.dataset.composerSheetTreeClosing, "true");
    assert.equal(parent.dataset.composerSheetEnding, "true");
    assert.equal(nested.dataset.composerSheetEnding, "true");
    assert.equal(nested.hasAttribute("data-composer-sheet-peeling"), false);
    assert.equal(closes, 0);
    await f.click(".composer-menu-scrim");
    await end(f, nested);
    assert.equal(closes, 0);
    await end(f, parent);
    assert.equal(closes, 1);
    assert.equal(root(f), null);
    await end(f, parent);
    assert.equal(closes, 1);
  } finally {
    await f.clean();
  }
});
test("root close without a child shares the same ending lifecycle", async () => {
  const f = await fixture();
  let closes = 0;
  try {
    await f.render(h(Probe, { closed: () => closes++ }));
    await f.click(".motion-close");
    assert.equal(root(f).dataset.composerSheetEnding, "true");
    assert.equal(root(f).dataset.composerSheetTreeClosing, "true");
    await end(f, root(f));
    assert.equal(closes, 1);
  } finally {
    await f.clean();
  }
});
for (const retirement of [
  "account",
  "controller",
  "route",
  "session",
  "bridge",
] as const)
  test(`a ${retirement} replacement retires an unfinished close without closing the new owner's menu`, async () => {
    const f = await fixture();
    let closes = 0;
    try {
      const node = h(Probe, { closed: () => closes++ });
      await f.render(node);
      await f.click(".motion-trigger");
      await f.click(".composer-menu-scrim");
      if (retirement === "bridge") f.window.desktop = { ...f.window.desktop };
      else
        f.replace(
          retirement === "account"
            ? { accountId: "new-account" }
            : retirement === "controller"
              ? { controllerScope: {} }
              : retirement === "route"
                ? { page: "scheduled" }
                : { activeId: "chat-b" },
        );
      await f.render(h(Probe, { closed: () => closes++ }));
      assert.equal(root(f).hasAttribute("data-composer-sheet-ending"), false);
      await end(f, root(f));
      assert.equal(closes, 0);
      await f.click('[aria-label="Back"]');
      await end(f, child(f));
      assert.equal(child(f), null);
    } finally {
      await f.clean();
    }
  });
test("reduced motion closes and backs immediately without queued motion or stale layers", async () => {
  const f = await fixture({ motion: false });
  let closes = 0;
  try {
    await f.render(h(Probe, { closed: () => closes++ }));
    await f.click(".motion-trigger");
    await f.click('[aria-label="Back"]');
    assert.equal(child(f), null);
    await f.click(".composer-menu-scrim");
    assert.equal(root(f), null);
    assert.equal(closes, 1);
  } finally {
    await f.clean();
  }
});
test("an old host without top-layer support keeps functional sheets without claiming a transformed independent child", async () => {
  const f = await fixture({ topLayer: false });
  try {
    await f.render(h(Probe));
    await f.click(".motion-trigger");
    assert.equal(root(f).dataset.composerSheetLayered, "false");
    assert.equal(child(f).hasAttribute("popover"), false);
    await f.click('[aria-label="Back"]');
    await end(f, child(f));
    assert.equal(child(f), null);
  } finally {
    await f.clean();
  }
});
test("real Add root retains its mounted controls until closing ends and does not close twice", async () => {
  const f = await fixture();
  let closed = 0;
  try {
    Object.assign(f.window.desktop, {
      customizeSkills: async () => [],
      listDesignSystems: async () => [],
    });
    const noop = () => {};
    await f.render(
      h(ComposerAddMenu, {
        presentation: "web-chat",
        platform: "darwin",
        projects: [],
        webSearch: true,
        webSearchAvailable: true,
        onWebSearch: noop,
        onClose: () => closed++,
        onFiles: noop,
        onProject: noop,
        onCreateProject: noop,
        onSettings: noop,
        onUnavailable: noop,
      }),
    );
    const menu = f.document.querySelector<HTMLElement>(".composer-add-menu")!;
    await f.event(menu, "keydown", { key: "Escape" });
    assert.equal(closed, 0);
    assert.equal(menu.dataset.composerSheetTreeClosing, "true");
    await end(f, menu);
    assert.equal(closed, 1);
  } finally {
    await f.clean();
  }
});

test("a bridge replacement without a renderer commit still refuses the old transition completion", async () => {
  const f = await fixture();
  let closed = 0;
  try {
    await f.render(h(Probe, { closed: () => closed++ }));
    await f.click(".motion-close");
    const outgoing = root(f);
    f.window.desktop = { ...f.window.desktop };
    await end(f, outgoing);
    assert.equal(closed, 0);
    assert.ok(root(f));
  } finally {
    await f.clean();
  }
});
test("a reduced-motion stale controller cannot close the replacement route", async () => {
  const f = await fixture({ motion: false });
  let closed = 0;
  try {
    await f.render(h(Probe, { closed: () => closed++ }));
    f.replace({ page: "scheduled" });
    await f.click(".motion-close");
    assert.equal(closed, 0);
    assert.ok(root(f));
  } finally {
    await f.clean();
  }
});

test("fine-pointer language Back retains popup focus restoration without a sheet transition", async () => {
  const f = await fixture();
  try {
    f.window.matchMedia = (() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })) as never;
    const anchor = { current: f.document.createElement("button") };
    f.document.body.append(anchor.current);
    await f.render(
      h(MicrophoneMenu, { anchor, variant: "idle", onClose() {} }),
    );
    await f.click(".microphone-language-status");
    const menu = f.document.querySelector<HTMLElement>(
      ".dictation-language-menu",
    )!;
    assert.equal(menu.hasAttribute("data-composer-sheet-child"), false);
    await f.event(menu, "keydown", { key: "Escape" });
    assert.equal(f.document.querySelector(".dictation-language-menu"), null);
    assert.equal(
      f.document.activeElement,
      f.document.querySelector(".microphone-language-status"),
    );
  } finally {
    await f.clean();
  }
});
