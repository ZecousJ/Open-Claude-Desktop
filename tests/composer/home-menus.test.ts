import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useRef, useState } from "react";
import { routineDom } from "../support/routine-dom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ConnectorReconnectRows } from "../../src/composer/ConnectorReconnectRows";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import {
  ComposerMenuPresentation,
  ComposerSheetBack,
  useComposerMenuPresentation,
  useComposerMenuSheet,
} from "../../src/composer/menu-sheet";
import { MicrophoneMenu } from "../../src/composer/MicrophoneMenu";
import { PreferredVoiceInput } from "../../src/composer/PreferredVoiceInput";
import { ModelMenu } from "../../src/composer/model/ModelMenu";
import HomeStarters from "../../src/starter-prompts/HomeStarters";
import { markExplicitFolderSelection } from "../../src/composer/explicit-folder-selection";
import { desktopHost } from "../../shared/host";
import { PlacePickerSurface } from "../../src/composer/PlacePickerSurface";
import type { McpServerState } from "../../shared/settings-desktop-api";
const ready: McpServerState = {
  name: "fixture",
  state: "ready",
  tools: 2,
  toolList: [
    { name: "allowed", description: "Allowed fixture", enabled: true },
    { name: "blocked", description: "Blocked fixture", enabled: false },
  ],
};
const noop = () => {};
let fixtureSequence = 0;
async function fixture(extra: Partial<Window["desktop"]> = {}) {
  const f = await routineDom(
    {
      mcpServers: async () => ({ servers: [ready], configPath: "" }),
      modelCatalog: async () => ({ defaultModel: "gpt-5", items: [] }),
      customizeSkills: async () => [],
      listDesignSystems: async () => [],
      ...extra,
    },
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1400,
    innerHeight: 900,
    addEventListener: f.window.addEventListener.bind(f.window),
    removeEventListener: f.window.removeEventListener.bind(f.window),
    dispatchEvent: f.window.dispatchEvent.bind(f.window),
    localStorage: f.window.localStorage,
    SpeechSynthesisUtterance: class {},
  };
  const old = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, v] of Object.entries(globals))
    Object.defineProperty(globalThis, k, {
      value: v,
      writable: true,
      configurable: true,
    });
  Object.defineProperty(f.window, "speechSynthesis", { value: {} });
  f.window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)",
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  let app = {
    accountId: `home35-account-${++fixtureSequence}`,
    controllerScope: {},
    draftSession: "a",
    mode: "chat",
    page: "home",
    snapshot: {
      settings: { mcpServers: { fixture: { enabled: true } }, providers: [] },
    },
    composerDraft: {
      draftConnectors: {},
      draftConnectorTools: {},
      setDraftConnectors: noop,
      setDraftConnectorTools: noop,
    },
    report: noop,
  } as unknown as AppController;
  app.currentController = { current: app };
  const render = (child: ReturnType<typeof h>) =>
    f.render(h(AppContext.Provider, { value: app }, child));
  return {
    ...f,
    render,
    get app() {
      return app;
    },
    replace(next: AppController) {
      app.currentController!.current = next;
      app = next;
    },
    async settle(check: () => boolean) {
      for (let i = 0; i < 40 && !check(); i++)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 5));
        });
      assert.ok(check());
    },
    async clean() {
      await f.clean();
      for (const [k, v] of old)
        if (v) Object.defineProperty(globalThis, k, v);
        else Reflect.deleteProperty(globalThis, k);
    },
  };
}
const addProps = {
  presentation: "web-chat" as const,
  platform: "darwin" as const,
  projects: [],
  webSearch: true,
  webSearchAvailable: true,
  onWebSearch: noop,
  onFiles: noop,
  onProject: noop,
  onCreateProject: noop,
  onSettings: noop,
  onUnavailable: noop,
  onClose: noop,
};

test("connector row reflects effective eligible session tools and one toggle cannot select globally disabled tools", async () => {
  const f = await fixture();
  const toggles: unknown[][] = [];
  try {
    await f.render(
      h(ConnectorReconnectRows, {
        servers: { fixture: { enabled: true } },
        toolOverrides: { fixture: { allowed: false, blocked: true } },
        onToggle: (...args) => toggles.push(args),
      }),
    );
    await f.settle(
      () =>
        !!f.document.querySelector('[role="menuitemcheckbox"]:not(:disabled)'),
    );
    const row = f.document.querySelector('[role="menuitemcheckbox"]')!;
    assert.equal(row.getAttribute("aria-checked"), "false");
    await f.event(row, "click");
    assert.equal(toggles.length, 1);
    assert.equal(toggles[0][1], true);
    assert.deepEqual(toggles[0][2], ready);
  } finally {
    await f.clean();
  }
});
test("composer saves one atomic server + eligible-tool patch and retires failure after changing session", async () => {
  let reject!: (e: Error) => void;
  const calls: unknown[] = [];
  const errors: unknown[] = [];
  const f = await fixture();
  try {
    const active = {
      id: "session-a",
      connectorOverrides: {},
      connectorToolOverrides: { fixture: { allowed: false, blocked: false } },
    };
    Object.assign(f.app, {
      activeId: active.id,
      active,
      patchConversation: (_c: unknown, p: unknown) => {
        calls.push(p);
        return new Promise((_r, no) => {
          reject = no;
        });
      },
      report: (e: unknown) => errors.push(e),
    });
    await f.render(h(ComposerAddMenu, addProps));
    await f.click('[data-add-branch="connectors"]');
    await f.settle(
      () =>
        !!f.document.querySelector('[role="menuitemcheckbox"]:not(:disabled)'),
    );
    await f.click('[role="menuitemcheckbox"]');
    assert.deepEqual(calls, [
      {
        connectorOverrides: { fixture: true },
        connectorToolOverrides: { fixture: { allowed: true, blocked: false } },
      },
    ]);
    assert.equal(
      f.document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!
        .disabled,
      true,
    );
    f.replace({
      ...f.app,
      activeId: "session-b",
      active: { ...active, id: "session-b" },
    } as unknown as AppController);
    await f.render(h(ComposerAddMenu, addProps));
    await act(async () => reject(Error("old session")));
    assert.deepEqual(errors, []);
  } finally {
    await f.clean();
  }
});
test("unresolved status and a connector with no globally eligible tools remain disabled", async () => {
  const f = await fixture({
    mcpServers: async () => ({
      servers: [
        {
          ...ready,
          toolList: [
            { name: "blocked", description: "Blocked fixture", enabled: false },
          ],
        },
      ],
      configPath: "",
    }),
  });
  try {
    await f.render(
      h(ConnectorReconnectRows, {
        servers: { fixture: {} },
        onToggle: () => assert.fail("unavailable connector toggled"),
      }),
    );
    await f.settle(() => f.document.body.textContent!.includes("fixture"));
    assert.equal(
      f.document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!
        .disabled,
      true,
    );
  } finally {
    await f.clean();
  }
});
function SheetProbe() {
  const root = useRef<HTMLDivElement>(null);
  const [child, setChild] = useState(false);
  const sheet = useComposerMenuPresentation();
  useComposerMenuSheet(root, {
    sheet,
    nested: child,
    panel: "[data-child]",
    trigger: "[data-trigger]",
    onBack: () => setChild(false),
  });
  return h(
    "div",
    { ref: root, className: "probe" },
    h(
      "button",
      { "data-trigger": true, onClick: () => setChild(true) },
      "Open",
    ),
    child &&
      h(
        "div",
        { "data-child": true, className: "child", role: "menu" },
        h(ComposerSheetBack, { sheet, onBack: () => setChild(false) }),
        h("input", { "aria-label": "Child search" }),
      ),
  );
}
for (const mode of ["coarse", "context", "fine"] as const)
  test(`sheet presentation obeys ${mode} without a phone-width condition`, async () => {
    const f = await fixture();
    if (mode !== "coarse")
      f.window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      })) as never;
    try {
      await f.render(
        h(
          ComposerMenuPresentation.Provider,
          { value: mode === "context" ? "sheet" : "auto" },
          h(SheetProbe),
        ),
      );
      const root = f.document.querySelector(".probe")!;
      assert.equal(
        root.getAttribute("data-composer-sheet"),
        mode === "fine" ? null : "true",
      );
      await f.click("[data-trigger]");
      if (mode === "fine") {
        assert.equal(root.getAttribute("data-composer-sheet-drilled"), null);
        return;
      }
      assert.equal(root.getAttribute("data-composer-sheet-drilled"), "true");
      assert.equal(
        f.document.querySelector("[data-trigger]")!.getAttribute("inert"),
        "",
      );
      await f.event(f.document.querySelector("input")!, "keydown", {
        key: "Escape",
      });
      assert.equal(f.document.querySelector("[data-child]"), null);
      assert.equal(
        f.document.querySelector("[data-trigger]")!.hasAttribute("inert"),
        false,
      );
      assert.equal(
        f.document.activeElement,
        f.document.querySelector("[data-trigger]"),
      );
    } finally {
      await f.clean();
    }
  });
test("actual microphone language sheet keeps Back visible while searching and restores parent", async () => {
  const f = await fixture();
  const anchor = { current: f.document.createElement("button") };
  f.document.body.append(anchor.current);
  try {
    await f.render(
      h(MicrophoneMenu, { anchor, onClose: noop, variant: "idle" }),
    );
    await f.click(".microphone-language-status");
    assert.equal(
      f.document
        .querySelector(".dictation-language-menu")!
        .getAttribute("data-composer-sheet-child"),
      "true",
    );
    await f.change('[aria-label="Search languages"]', "does-not-exist");
    assert.ok(f.document.querySelector('[aria-label="Back"]'));
    await f.click('[aria-label="Back"]');
    assert.equal(f.document.querySelector(".dictation-language-menu"), null);
    assert.equal(
      f.document.activeElement,
      f.document.querySelector(".microphone-language-status"),
    );
  } finally {
    await f.clean();
  }
});
test("actual project filter sheet backs out without choosing a project or losing its query", async () => {
  const f = await fixture();
  let picks = 0;
  try {
    await f.render(
      h(PlacePickerSurface, {
        label: "Project",
        chosen: false,
        collapsed: false,
        platform: "darwin",
        content: () => ({
          rows: [
            {
              key: "a",
              name: "Synthetic project",
              icon: "Folder" as const,
              onPick: () => picks++,
            },
          ],
          footer: [],
        }),
        controls: [{ key: "recent", label: "Recent", onPick: noop }],
      }),
    );
    await f.click("button");
    await f.change("input", "synthetic");
    await f.click('[aria-label="Filter and sort"]');
    assert.equal(
      f.document
        .querySelector(".project-picker-filter")!
        .getAttribute("data-composer-sheet-child"),
      "true",
    );
    await f.click('[aria-label="Back"]');
    assert.equal(f.document.querySelector(".project-picker-filter"), null);
    assert.equal(
      f.document.querySelector<HTMLInputElement>("input")!.value,
      "synthetic",
    );
    assert.equal(picks, 0);
  } finally {
    await f.clean();
  }
});
test("preferred voice input changes and persists only the primary action, without starting either action", async () => {
  const f = await fixture();
  let starts = 0;
  const props = {
    dictation: h(
      "button",
      { id: "dictation", onClick: () => starts++ },
      "Dictate",
    ),
    voice: h("button", { id: "voice", onClick: () => starts++ }, "Voice"),
  };
  try {
    await f.render(h(PreferredVoiceInput, props));
    assert.ok(f.document.querySelector("#dictation"));
    await f.click('[aria-label="Voice input"]');
    await f.settle(() => !!f.document.querySelector('[role="menuitemradio"]'));
    const radio = [
      ...f.document.querySelectorAll('[role="menuitemradio"]'),
    ].find((x) => x.textContent === "Voice mode")!;
    await f.event(radio, "click");
    assert.ok(f.document.querySelector("#voice"));
    assert.equal(starts, 0);
    await f.render(h("div"));
    await f.render(h(PreferredVoiceInput, props));
    assert.ok(f.document.querySelector("#voice"));
    f.replace({ ...f.app, accountId: "another-account" });
    await f.render(h(PreferredVoiceInput, props));
    assert.ok(f.document.querySelector("#dictation"));
    assert.equal(starts, 0);
  } finally {
    await f.clean();
  }
});
test("unavailable speech support offers no false voice preference", async () => {
  const f = await fixture();
  try {
    await f.render(
      h(PreferredVoiceInput, {
        dictation: h("button", { id: "dictation" }, "Dictate"),
        voice: h("button", { id: "voice" }, "Voice"),
        reason: "Unavailable",
      }),
    );
    assert.ok(f.document.querySelector("#dictation"));
    assert.equal(f.document.querySelector("#voice"), null);
    assert.equal(f.document.querySelector('[aria-haspopup="menu"]'), null);
  } finally {
    await f.clean();
  }
});

test("actual Add menu drills and backs without closing the menu or loading unsupported policy controls", async () => {
  const f = await fixture();
  let closes = 0;
  try {
    await f.render(
      h(ComposerAddMenu, { ...addProps, onClose: () => closes++ }),
    );
    await f.click('[data-add-branch="connectors"]');
    assert.equal(
      f.document
        .querySelector('[data-add-panel="connectors"]')!
        .getAttribute("data-composer-sheet-child"),
      "true",
    );
    await f.click('[aria-label="Back"]');
    assert.equal(
      f.document.querySelector('[data-add-panel="connectors"]'),
      null,
    );
    assert.equal(
      f.document.activeElement,
      f.document.querySelector('[data-add-branch="connectors"]'),
    );
    assert.equal(closes, 0);
  } finally {
    await f.clean();
  }
});
test("actual model menu keeps a nested effort sheet on a coarse desktop and returns to its trigger", async () => {
  const f = await fixture();
  let changes = 0;
  try {
    await f.render(
      h(ModelMenu, {
        providers: [],
        providerId: "codex",
        model: "gpt-5",
        effort: "medium",
        onSelect: noop,
        onEffort: () => changes++,
        onManage: noop,
        onClose: noop,
      }),
    );
    await f.settle(() => !!f.document.querySelector('[data-branch="effort"]'));
    const trigger = f.document.querySelector('[data-branch="effort"]');
    assert.ok(trigger);
    await f.event(trigger, "click");
    const panel = f.document.querySelector('[data-panel="effort"]')!;
    assert.equal(panel.getAttribute("data-composer-sheet-child"), "true");
    await f.event(panel, "keydown", { key: "ArrowLeft" });
    assert.equal(f.document.querySelector('[data-panel="effort"]'), null);
    assert.equal(f.document.activeElement, trigger);
    assert.equal(changes, 0);
  } finally {
    await f.clean();
  }
});
test("reused mounted Home starters hide the whole checklist for a project before forced-show or count overrides", async () => {
  const f = await fixture();
  try {
    Object.assign(f.app.snapshot.settings, {
      homeStarters: {
        chipsOverride: "show",
        prosumer_checklist_v2: { setup_project: true },
      },
    });
    const child = h(HomeStarters, {
      onPick: noop,
      conversationCount: 100,
      homeShaped: true,
      targetKind: "chat",
    });
    await f.render(child);
    assert.ok(f.document.querySelector(".home-checklist"));
    f.replace({
      ...f.app,
      projectId: "project",
      project: { id: "project", name: "Channel project" },
    } as unknown as AppController);
    await f.render(child);
    assert.equal(f.document.querySelector(".home-checklist"), null);
    f.replace({ ...f.app, projectId: undefined, project: undefined });
    await f.render(child);
    assert.ok(f.document.querySelector(".home-checklist"));
  } finally {
    await f.clean();
  }
});
test("reused mounted Home starters hide only after an authorized explicit local folder choice", async () => {
  const f = await fixture();
  try {
    Object.assign(f.app.snapshot.settings, {
      homeStarters: {
        chipsOverride: "show",
        prosumer_checklist_v2: { setup_project: true },
      },
    });
    Object.assign(f.app, { host: desktopHost, cwd: "/synthetic-folder" });
    const child = h(HomeStarters, {
      onPick: noop,
      conversationCount: 0,
      homeShaped: true,
      targetKind: "chat",
    });
    await f.render(child);
    assert.ok(f.document.querySelector(".home-checklist"));
    await act(async () => markExplicitFolderSelection(f.app));
    assert.equal(f.document.querySelector(".home-checklist"), null);
  } finally {
    await f.clean();
  }
});
for (const change of ["busy", "account", "bridge", "route"] as const)
  test(`voice preference rejects a ${change} owner before a retained menu action`, async () => {
    const f = await fixture();
    try {
      const props = {
        dictation: h("button", { id: "dictation" }, "Dictate"),
        voice: h("button", { id: "voice" }, "Voice"),
      };
      await f.render(h(PreferredVoiceInput, props));
      await f.click('[aria-label="Voice input"]');
      await f.settle(() =>
        [...f.document.querySelectorAll('[role="menuitemradio"]')].some(
          (x) => x.textContent === "Voice mode",
        ),
      );
      const radio = [
        ...f.document.querySelectorAll('[role="menuitemradio"]'),
      ].find((x) => x.textContent === "Voice mode")!;
      if (change === "busy")
        await f.render(h(PreferredVoiceInput, { ...props, busy: true }));
      else if (change === "bridge") f.window.desktop = { ...f.window.desktop };
      else
        f.app.currentController!.current = {
          ...f.app,
          ...(change === "account"
            ? { accountId: "retired-account" }
            : { page: "scheduled" }),
        } as AppController;
      await f.event(radio, "click");
      assert.ok(f.document.querySelector("#dictation"));
      assert.equal(f.document.querySelector("#voice"), null);
      assert.equal(f.window.localStorage.length, 0);
    } finally {
      await f.clean();
    }
  });

test("draft connector toggle writes session tool defaults without touching globally disabled tools", async () => {
  const f = await fixture();
  const servers: unknown[] = [];
  const tools: unknown[] = [];
  try {
    f.app.composerDraft.setDraftConnectors = (value) => servers.push(value);
    f.app.composerDraft.setDraftConnectorTools = (value) => tools.push(value);
    await f.render(h(ComposerAddMenu, addProps));
    await f.click('[data-add-branch="connectors"]');
    await f.settle(
      () =>
        !!f.document.querySelector('[role="menuitemcheckbox"]:not(:disabled)'),
    );
    await f.click('[role="menuitemcheckbox"]');
    assert.deepEqual(servers, [{ fixture: false }]);
    assert.deepEqual(tools, [{ fixture: { allowed: false } }]);
  } finally {
    await f.clean();
  }
});
test("service retirement suppresses a pending connector failure even before the controller is replaced", async () => {
  const listeners = new Set<Parameters<Window["desktop"]["onEvent"]>[0]>();
  const f = await fixture({
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  let reject!: (e: Error) => void;
  const errors: unknown[] = [];
  try {
    Object.assign(f.app, {
      activeId: "live",
      active: { id: "live" },
      patchConversation: () =>
        new Promise((_yes, no) => {
          reject = no;
        }),
      report: (e: unknown) => errors.push(e),
    });
    await f.render(h(ComposerAddMenu, addProps));
    await f.click('[data-add-branch="connectors"]');
    await f.settle(
      () =>
        !!f.document.querySelector('[role="menuitemcheckbox"]:not(:disabled)'),
    );
    await f.click('[role="menuitemcheckbox"]');
    await act(async () => {
      for (const listener of listeners) listener({ type: "service-changed" });
      reject(Error("old service"));
    });
    assert.deepEqual(errors, []);
  } finally {
    await f.clean();
  }
});
