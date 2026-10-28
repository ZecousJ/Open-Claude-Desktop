import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  act,
  createElement,
  createRef,
  Fragment,
  type ComponentProps,
  type ReactElement,
  useState,
} from "react";
import { JSDOM } from "jsdom";
import type { ComposerField } from "../../src/composer/composer-field";
import {
  createFixtureDesktop,
  fixtureSettings,
} from "../../scripts/preview/app-fixture";
import type { Conversation, Settings } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { setLocale } from "../../src/i18n";
import { chatComposerPlaceholder } from "../../src/composer/chat-placeholder";
import { FolderAccessHost } from "../../src/cowork/FolderAccessDialog";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { useSettingsSkillsNavigation } from "../../src/settings/skills-navigation";

registerHooks({
  load(url, context, next) {
    if (url.includes("?url"))
      return {
        format: "module",
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
type Props = ComponentProps<
  typeof import("../../src/composer/Composer").Composer
>;
const noop = () => {};
const catalog: ModelCatalog = {
  defaultModel: "fixture-model",
  items: [
    {
      id: "fixture-model",
      displayName: "Actual fixture model",
      description: "",
      badges: [],
      sort: 0,
      hidden: false,
      isDefault: true,
      usageHint: "",
    },
    {
      id: "fixture-other",
      displayName: "Other actual model",
      description: "",
      badges: [],
      sort: 1,
      hidden: false,
      isDefault: false,
      usageHint: "",
    },
  ],
};
const active = (mode: Conversation["mode"]): Conversation => ({
  id: "integration-session",
  title: "Fixture",
  mode,
  providerId: "fixture",
  model: "fixture-model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
});
const cloudHost: HostInfo = {
  ...webHost,
  cloud: { environments: [], permissionModes: ["manual", "auto", "bypass"] },
};

async function withComposer(
  options: {
    host?: HostInfo;
    native?: boolean;
    props?: Partial<Props>;
    locale?: string;
    bridge?: Partial<ReturnType<typeof createFixtureDesktop>>;
    stateful?: boolean;
    appContext?: Partial<AppController>;
    sibling?: ReactElement;
  },
  check: (env: {
    document: Document;
    click(selector: string): Promise<void>;
    settle(): Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM(
    '<html><body><div class="app web"><main></main></div></body></html>',
    { url: "https://fixture.invalid/new", pretendToBeVisual: true },
  );
  const { window } = dom,
    { document } = window;
  (document as unknown as { oninput: null }).oninput = null;
  const createRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = createRange();
    // Linkedom has no text layout. Existing input/IME tests need a known
    // single-line contract; narrow geometry is separately controlled.
    range.getClientRects = () =>
      [
        { left: 110, right: 160, top: 500, bottom: 521, width: 50, height: 21 },
      ] as unknown as DOMRectList;
    return range;
  };
  const nativeController = Object.getOwnPropertyDescriptor(
    window,
    "ClaudexConversation",
  );
  const bridge = createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams("fonts=system"),
  );
  bridge.modelCatalog = async () => catalog;
  bridge.coworkFolders = async () => ({ extra: [] });
  bridge.listCoworkDevices = async () => [];
  Object.assign(bridge, options.bridge);
  Object.assign(window, {
    desktop: bridge,
    innerWidth: 1440,
    innerHeight: 900,
  });
  if (options.native)
    Object.defineProperty(window, "ClaudexConversation", {
      configurable: true,
      value: Object.freeze({
        render() {},
        document() {},
        result() {
          return true;
        },
        dispose() {},
      }),
    });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  const element = window.HTMLElement.prototype;
  const bounds = Object.getOwnPropertyDescriptor(
    element,
    "getBoundingClientRect",
  );
  element.getBoundingClientRect = () => ({
    x: 100,
    y: 500,
    left: 100,
    top: 500,
    right: 300,
    bottom: 524,
    width: 200,
    height: 24,
    toJSON() {},
  });
  const clientWidth = Object.getOwnPropertyDescriptor(element, "clientWidth");
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    get() {
      // jsdom has no layout. Match the explicitly supplied 200px field rect
      // so placeholder-fit checks are not accidentally testing a zero width.
      return this.matches("textarea, .composer-atomic-input") ? 200 : 0;
    },
  });
  const editorStyles = document.createElement("style");
  editorStyles.textContent = ".ProseMirror { white-space: pre-wrap }";
  document.head.append(editorStyles);
  const computed = window.getComputedStyle.bind(window);
  Object.assign(window, { getComputedStyle: computed });
  const globals = {
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: computed,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    localStorage: {
      getItem: (key: string) =>
        key === "claudex.microphone.hold" ? "off" : null,
      setItem() {},
      removeItem() {},
    },
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
  const { Composer } = await import("../../src/composer/Composer");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const settings: Settings = {
    ...fixtureSettings(),
    effort: "high",
    codeEffort: "ultra",
    providers: [
      {
        id: "fixture",
        name: "Fixture",
        protocol: "responses",
        baseUrl: "",
        model: "fixture-model",
        models: ["fixture-model", "fixture-other"],
      },
    ],
  };
  const props: Props = {
    settings,
    platform: "darwin",
    projects: [],
    mode: "cowork",
    draftIdentity: "integration",
    onProject: noop,
    onCreateProject: noop,
    openSettingsTab: noop,
    onNavigate: noop,
    onOpenUsage: noop,
    onCompact: noop,
    webSearch: true,
    webSearchAvailable: true,
    onWebSearch: noop,
    research: false,
    researchAvailable: true,
    onResearch: noop,
    setMode: noop,
    providerId: "fixture",
    setProviderId: noop,
    model: "fixture-model",
    setModel: noop,
    text: "",
    setText: noop,
    attachments: [],
    setAttachments: noop,
    setCwd: noop,
    recentFolders: [],
    running: false,
    sending: false,
    composer: createRef<ComposerField>(),
    pickFiles: async () => {},
    pickFolder: async () => {},
    updatePreference: async () => {},
    send: async () => {},
    interrupt: async () => {},
    report(error: unknown) {
      throw error;
    },
    notify: noop,
    setSettingsOpen: noop,
    ...options.props,
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
  };
  function StatefulComposer() {
    const draft = useSkillDraft(props.text);
    return createElement(Composer, { ...props, ...draft });
  }
  try {
    await setLocale(options.locale ?? "en-US");
    // React 19 act can spin Suspense retry lanes while Node dynamic-import
    // I/O is pending. Mount cold on the real scheduler, then use act for
    // ready-state assertions and all interactions. No editor is preloaded.
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    root.render(
      createElement(
        HostContext.Provider,
        { value: options.host ?? cloudHost },
        createElement(
          Fragment,
          null,
          options.appContext
            ? createElement(
                AppContext.Provider,
                { value: options.appContext as AppController },
                options.stateful
                  ? createElement(StatefulComposer)
                  : createElement(Composer, props),
              )
            : options.stateful
              ? createElement(StatefulComposer)
              : createElement(Composer, props),
          options.sibling,
          createElement(FolderAccessHost, { platform: "darwin" }),
        ),
      ),
    );
    const unified =
      props.mode !== "code" &&
      ((options.host ?? cloudHost).kind === "desktop" || !options.native);
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (
        (!unified || document.querySelector(".composer-atomic-input")) &&
        !document.querySelector(".composer-home-voice-placeholder")
      )
        break;
    }
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await settle();
    await check({
      document,
      settle,
      click: async (selector) => {
        const target = document.querySelector<HTMLButtonElement>(selector);
        assert.ok(target, selector);
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
        target.click();
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        if (
          target.getAttribute("aria-expanded") === "true" &&
          target.getAttribute("aria-haspopup")
        )
          for (
            let attempt = 0;
            !document.querySelector(
              '[role="menu"], [role="listbox"], [role="dialog"], [data-chunk-error]',
            ) && attempt < 200;
            attempt++
          )
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        await settle();
      },
    });
  } finally {
    await act(async () => root.unmount());
    await setLocale("en-US");
    if (options.native) {
      if (nativeController)
        Object.defineProperty(window, "ClaudexConversation", nativeController);
      else Reflect.deleteProperty(window, "ClaudexConversation");
    }
    if (bounds) Object.defineProperty(element, "getBoundingClientRect", bounds);
    else Reflect.deleteProperty(element, "getBoundingClientRect");
    if (clientWidth) Object.defineProperty(element, "clientWidth", clientWidth);
    else Reflect.deleteProperty(element, "clientWidth");
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.close();
  }
}

test("actual Composer marks only the unified Chat editor for transcript-independent text size", async () => {
  for (const host of [desktopHost, cloudHost]) {
    for (const mode of ["chat", "cowork"] as const) {
      await withComposer(
        { host, props: { mode, active: active(mode) } },
        async ({ document }) => {
          const wrap = document.querySelector(".composer-wrap")!;
          assert.equal(wrap.getAttribute("data-presentation"), "chat");
          assert.ok(wrap.querySelector('.composer-input-row [role="textbox"]'));
          assert.equal(wrap.classList.contains("code-composer"), false);
        },
      );
    }
  }
  await withComposer(
    {
      host: desktopHost,
      props: { mode: "code", active: active("code") },
      appContext: {
        accountId: "text-size-code",
        mode: "code",
        snapshot: {
          settings: { remoteControl: false },
          conversations: [],
        } as never,
      },
    },
    async ({ document }) => {
      const wrap = document.querySelector(".composer-wrap")!;
      assert.equal(wrap.getAttribute("data-presentation"), null);
      assert.equal(wrap.classList.contains("code-composer"), true);
    },
  );
  await withComposer(
    {
      host: cloudHost,
      native: true,
      props: { mode: "cowork", active: active("cowork") },
    },
    async ({ document }) => {
      assert.equal(
        document
          .querySelector(".composer-wrap")
          ?.getAttribute("data-presentation"),
        null,
      );
    },
  );
});

test("actual web reply Composer keeps the pinned Dictate/caret group and uses effective model/effort", async () => {
  await withComposer(
    { props: { active: active("cowork") } },
    async ({ document, click }) => {
      // Dictate, then voice mode as the reply split button with the microphone
      // caret.
      const group = document.querySelector(".composer-chin-voice")!;
      assert.ok(
        group.querySelector(".chin-voice-controls [aria-label=Dictate]"),
      );
      assert.ok(group.querySelector(".chin-voice-controls .reply-voice-mode"));
      assert.ok(group.querySelector(".reply-voice-mode .voice-mode-chevron"));
      assert.equal(
        document.querySelector(".model-button")?.getAttribute("aria-label"),
        "Model: Actual fixture model High",
      );
      await click(".task-permission-trigger");
      assert.ok(document.querySelector(".task-permission-web-chat"));
      assert.equal(
        document.querySelectorAll(
          '.task-permission-web-chat [role="menuitemradio"]',
        ).length,
        2,
      );
    },
  );
});

test("actual ordinary model caller preserves its button through pending, settled-null and catalog readiness", async () => {
  for (const result of [null, catalog]) {
    let resolve!: (value: ModelCatalog | null) => void;
    const pending = new Promise<ModelCatalog | null>((done) => {
      resolve = done;
    });
    await withComposer(
      { bridge: { modelCatalog: () => pending } },
      async ({ document, settle }) => {
        const button = document.querySelector(".model-button")!;
        assert.equal(button.getAttribute("aria-label"), "Select model");
        assert.equal(button.getAttribute("aria-busy"), "true");
        assert.equal(
          button.querySelector(".model-button-name, .model-button-effort"),
          null,
        );
        assert.doesNotMatch(button.textContent!, /Loading/);
        await act(async () => resolve(result));
        await settle();
        assert.equal(document.querySelector(".model-button"), button);
        assert.equal(button.getAttribute("aria-busy"), null);
        assert.match(button.getAttribute("aria-label")!, /^Model: .+ High$/);
        assert.ok(button.querySelector(".model-button-name"));
      },
    );
  }
});

test("actual model caller retains empty initial-error naming until the real menu retries, while Code stays named", async () => {
  let calls = 0;
  await withComposer(
    {
      bridge: {
        modelCatalog: async () => {
          calls++;
          if (calls === 1) throw Error("Private transport detail");
          return catalog;
        },
      },
    },
    async ({ document, click, settle }) => {
      const button = document.querySelector(".model-button")!;
      assert.equal(button.getAttribute("aria-label"), "Select model");
      assert.equal(button.getAttribute("aria-busy"), null);
      assert.equal(button.querySelector(".model-button-name"), null);
      await click(".model-button");
      const retry = [
        ...document.querySelectorAll<HTMLButtonElement>(".model-menu button"),
      ].find((row) => /Try again|Retry/.test(row.textContent!));
      assert.ok(retry, "the actual service error menu exposes its real retry");
      await act(async () => retry.click());
      await settle();
      assert.equal(document.querySelector(".model-button"), button);
      assert.match(
        button.getAttribute("aria-label")!,
        /^Model: Actual fixture model High$/,
      );
      assert.equal(calls, 2);
    },
  );
  await withComposer(
    {
      props: { mode: "code" },
      bridge: { modelCatalog: () => new Promise(() => {}) },
    },
    async ({ document }) => {
      const button = document.querySelector(".web-code-model-trigger")!;
      assert.ok(button);
      assert.notEqual(button.getAttribute("aria-label"), "Select model");
      assert.equal(button.getAttribute("aria-busy"), null);
      assert.ok(button.textContent!.trim());
    },
  );
});

test("actual Composer inserts a real enabled skill at the selection without submitting, then selects it atomically for deletion", async () => {
  for (const incognito of [false, true])
    await withComposer(
      {
        stateful: true,
        props: {
          mode: "chat",
          text: "Before chosen after",
          incognito,
          send: async () => assert.fail("A skill menu choice must not submit"),
        },
        bridge: {
          customizeSkills: async () => [
            {
              name: "actual",
              description: "Actual skill",
              path: "/runtime/actual/SKILL.md",
              scope: "user",
              enabled: true,
              own: true,
            },
            {
              name: "off",
              description: "",
              path: "/runtime/off/SKILL.md",
              scope: "user",
              enabled: false,
              own: true,
            },
          ],
          setSkillEnabled: async () =>
            assert.fail("Invocation must not change global installation"),
        },
      },
      async ({ document, click, settle }) => {
        const field =
          document.querySelector<ComposerField>('[role="textbox"]')!;
        await act(async () => field.setSelectionRange(7, 13));
        await click(".composer-add-trigger");
        await click('[data-add-branch="skills"]');
        assert.doesNotMatch(
          document.querySelector('[data-add-panel="skills"]')!.textContent!,
          /\boff\b/,
        );
        await click('[data-add-panel="skills"] button');
        await settle();
        assert.equal(
          document.querySelector('[role="textbox"]'),
          field,
          "selecting a token must preserve the real input node",
        );
        assert.equal(field.value, "Before $actual  after");
        assert.equal(
          document.querySelector("[data-skill-token=actual]")?.textContent,
          "/actual",
        );
        assert.equal(
          document
            .querySelector("[data-skill-token=actual]")
            ?.getAttribute("contenteditable"),
          "false",
        );
        await act(async () => {
          field.focus();
          field.setSelectionRange(14, 14);
        });
        const composing = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(composing, { key: "Backspace", isComposing: true });
        await act(async () => field.dispatchEvent(composing));
        assert.equal(
          composing.defaultPrevented,
          false,
          "IME composition keeps native editing behavior",
        );
        const key = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(key, { key: "Backspace", isComposing: false });
        await act(async () => field.dispatchEvent(key));
        assert.equal(key.defaultPrevented, true);
        assert.equal(field.selectionStart, 7);
        assert.equal(field.selectionEnd, 14);
        assert.equal(field.value, "Before $actual  after");
        const remove = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(remove, { key: "Backspace", keyCode: 8 });
        await act(async () => field.dispatchEvent(remove));
        await settle();
        assert.equal(document.querySelector("[data-skill-token]"), null);
        assert.equal(field.value, "Before   after");
      },
    );
});

test("synthetic DOM IME reaches the actual atomic Composer without sending and a changed raw skill name loses its old reference", async () => {
  await withComposer(
    {
      stateful: true,
      props: {
        mode: "chat",
        send: async () => assert.fail("Composition must not submit"),
      },
      bridge: {
        customizeSkills: async () => [
          {
            name: "review",
            description: "Actual runtime skill",
            path: "/runtime/review/SKILL.md",
            scope: "user",
            enabled: true,
            own: true,
          },
        ],
      },
    },
    async ({ document, click, settle }) => {
      const field = document.querySelector<ComposerField>('[role="textbox"]')!;
      await act(async () => field.setSelectionRange(0, 0));
      await click(".composer-add-trigger");
      await click('[data-add-branch="skills"]');
      await click('[data-add-panel="skills"] button');
      await act(async () => {
        field.focus();
        field.setSelectionRange(8, 8);
      });
      const dispatch = (type: string, extra: Record<string, unknown> = {}) => {
        const event = new window.Event(type, {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, extra);
        field.dispatchEvent(event);
        return event;
      };
      await act(async () => dispatch("compositionstart", { data: "" }));
      for (const data of ["n", "你", "中文"])
        await act(async () => {
          const node = field.querySelector("p")!.lastChild!;
          node.textContent = ` ${data}`;
          document.getSelection()!.collapse(node, data.length + 1);
          dispatch("compositionupdate", { data });
          dispatch("input", { data, isComposing: true });
        });
      await act(async () =>
        dispatch("keydown", { key: "Enter", isComposing: true, keyCode: 229 }),
      );
      await act(async () => {
        dispatch("compositionend", { data: "中文" });
        dispatch("input", { data: "中文", isComposing: false });
      });
      await settle();
      assert.equal(document.querySelector('[role="textbox"]'), field);
      assert.equal(field.value, "$review 中文");
      assert.ok(document.querySelector('[data-skill-token="review"]'));
      await act(async () => field.setSelectionRange(0, 7));
      assert.equal(
        field.value.slice(field.selectionStart, field.selectionEnd),
        "$review",
        "native selection/copy spelling remains the real protocol",
      );
      await act(async () => {
        field.setSelectionRange(7, 7);
        field.insertText!("er");
      });
      await settle();
      assert.equal(field.value, "$reviewer 中文");
      assert.equal(document.querySelector("[data-skill-token]"), null);
    },
  );
});

test("actual Composer Manage and Browse request the precise account's Settings Skills view before opening", async () => {
  let open!: (value: boolean) => void;
  const tabs: string[] = [];
  function SettingsHostWitness() {
    const [shown, setShown] = useState(false);
    open = setShown;
    const navigation = useSettingsSkillsNavigation("footer-account", shown);
    return createElement("div", {
      "data-settings-open": shown,
      "data-skills-view": navigation.view,
    });
  }
  await withComposer(
    {
      appContext: {
        accountId: "footer-account",
        controllerScope: {},
        draftSession: "footer-draft",
        mode: "chat",
        snapshot: { settings: {} } as never,
      },
      props: {
        mode: "chat",
        openSettingsTab: (tab) => {
          tabs.push(tab);
          open(true);
        },
      },
      sibling: createElement(SettingsHostWitness),
    },
    async ({ document, click, settle }) => {
      await click(".composer-add-trigger");
      await click('[data-add-branch="skills"]');
      const manage = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-add-panel="skills"] button',
        ),
      ].find(
        (button) =>
          button.querySelector("span:not([aria-hidden])")?.textContent ===
          "Manage skills",
      )!;
      await act(async () => manage.click());
      await settle();
      assert.equal(
        document
          .querySelector("[data-skills-view]")
          ?.getAttribute("data-skills-view"),
        "yours",
      );
      assert.equal(
        document
          .querySelector("[data-settings-open]")
          ?.getAttribute("data-settings-open"),
        "true",
      );
      await act(async () => open(false));
      await click(".composer-add-trigger");
      await click('[data-add-branch="skills"]');
      const browse = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-add-panel="skills"] button',
        ),
      ].find((button) => button.textContent?.endsWith("Browse skills"))!;
      assert.ok(browse);
      await act(async () => browse.click());
      await settle();
      assert.equal(
        document
          .querySelector("[data-skills-view]")
          ?.getAttribute("data-skills-view"),
        "discover",
      );
      assert.deepEqual(tabs, ["skills", "skills"]);
    },
  );
});

test("actual web home/reply Add roots select the private web presentation", async () => {
  for (const conversation of [undefined, active("cowork")]) {
    await withComposer(
      { props: { active: conversation } },
      async ({ document, click }) => {
        await click(".composer-add-trigger");
        const menu = document.querySelector('.composer-add-menu[role="menu"]')!;
        assert.ok(menu);
        assert.doesNotMatch(
          menu.textContent ?? "",
          /Add to project|Web search|Thinking/,
        );
        assert.match(menu.textContent ?? "", /Research/);
      },
    );
  }
});

test("stored plain Chat uses the unified permission presentation and Code announces its actual effort", async () => {
  await withComposer(
    { props: { mode: "chat", active: active("chat") } },
    async ({ document, click }) => {
      await click(".task-permission-trigger");
      assert.ok(document.querySelector(".task-permission-web-chat"));
      assert.equal(
        document.querySelectorAll(
          '.task-permission-web-chat [role="menuitemradio"]',
        ).length,
        2,
      );
    },
  );
  await withComposer({ props: { mode: "code" } }, async ({ document }) => {
    assert.equal(
      document.querySelector(".model-button")?.getAttribute("aria-label"),
      "Model: Actual fixture model Ultracode",
    );
    assert.equal(document.querySelector(".reply-voice-mode"), null);
  });
});

test("desktop Chat uses current permission topology while the separate native controller stays legacy", async () => {
  for (const options of [
    { host: desktopHost },
    { host: cloudHost, native: true },
  ]) {
    await withComposer(
      { ...options, props: { active: active("cowork") } },
      async ({ document, click }) => {
        assert.equal(document.querySelector(".reply-voice-mode"), null);
        assert.ok(
          document.querySelector(".chin-voice-controls .cowork-voice-options"),
        );
        await click(".task-permission-trigger");
        if (options.host.kind === "desktop") {
          assert.equal(
            document.querySelectorAll(
              '.task-permission-web-chat [role="menuitemradio"]',
            ).length,
            2,
          );
          assert.doesNotMatch(
            document.querySelector(".task-permission-web-chat")?.textContent ??
              "",
            /Skip all approvals/,
          );
        } else {
          assert.equal(
            document.querySelector(".task-permission-web-chat"),
            null,
          );
        }
        await click(".composer-add-trigger");
        const menu = document.querySelector('.composer-add-menu[role="menu"]')!;
        if (options.host.kind === "desktop") {
          assert.ok(menu.classList.contains("composer-add-native-chat"));
          assert.doesNotMatch(menu.textContent ?? "", /Add to project/);
        } else assert.match(menu.textContent ?? "", /Add to project/);
      },
    );
  }
});

test("actual desktop Chat and Cowork replies offer the same model menu as a new chat", async () => {
  for (const mode of ["chat", "cowork"] as const) {
    await withComposer(
      { host: desktopHost, props: { mode, active: active(mode) } },
      async ({ document, click }) => {
        await click(".model-button");
        const menu = document.querySelector(".model-menu")!;
        assert.ok(menu);
        assert.ok(menu.querySelectorAll('[role="menuitemradio"]').length >= 1);
        const disclaimer = document.querySelector(".conversation-disclaimer");
        assert.equal(
          disclaimer?.textContent,
          "Claudex is AI and can make mistakes.",
        );
        await click(".task-permission-trigger");
        assert.equal(
          document.querySelectorAll(
            '.task-permission-web-chat [role="menuitemradio"]',
          ).length,
          2,
        );
      },
    );
  }
});

test("independent incognito renderer keeps its single Dictate/options capability and project names are interpolated once", async () => {
  await withComposer(
    { native: true, props: { incognito: true, active: active("cowork") } },
    async ({ document }) => {
      assert.equal(document.querySelector(".reply-voice-mode"), null);
      assert.equal(
        document.querySelector(".composer-chin-voice .voice-mode-button"),
        null,
      );
      assert.ok(
        document.querySelector(".chin-voice-controls .cowork-voice-options"),
      );
    },
  );
  await withComposer(
    {
      locale: "zh-CN",
      props: {
        projectOverview: true,
        project: {
          id: "project",
          name: "{project}",
          description: "",
          instructions: "",
          createdAt: 1,
        },
      },
    },
    async ({ document }) => {
      const placeholder =
        document
          .querySelector('[role="textbox"]')
          ?.getAttribute("data-placeholder") ??
        document.querySelector("textarea")?.placeholder ??
        "";
      assert.match(placeholder, /\{project\}/);
      assert.equal(
        placeholder,
        chatComposerPlaceholder("cowork", false, true, "{project}"),
      );
    },
  );
});

test("ordinary unified home announces Send message for nonempty Chat and Cowork drafts", async () => {
  for (const host of [cloudHost, desktopHost]) {
    for (const mode of ["chat", "cowork"] as const) {
      await withComposer(
        { host, props: { mode, text: "Unsent acceptance draft" } },
        async ({ document }) => {
          const send = document.querySelector<HTMLButtonElement>(
            '.composer-send-slot[data-shown="true"] button[aria-label="Send message"]',
          );
          assert.ok(send);
          assert.equal(send.disabled, false);
          assert.equal(
            document.querySelector('[aria-label="Start task"]'),
            null,
          );
        },
      );
    }
  }
});

test("main web and native incognito homes retain ordinary voice, project and permission controls", async () => {
  for (const host of [cloudHost, desktopHost]) {
    await withComposer(
      { host, props: { mode: "chat", incognito: true } },
      async ({ document, click }) => {
        // Dictate and its options stay beside Send; voice mode is the idle
        // control Send replaces.
        const voice = document.querySelector(".composer-home-voice")!;
        assert.ok(voice.querySelector(".cowork-voice-options"));
        const controls = document.querySelector(".composer-idle-slot")!;
        assert.ok(controls.querySelector(".voice-mode-button"));
        assert.ok(document.querySelector(".composer-chin .model-button"));
        const project = document.querySelector(
          ".composer-chin-leading .cowork-options > button",
        )!;
        assert.equal(
          project.querySelector(":scope > span:not([data-icon])")?.textContent,
          host.kind === "desktop" ? "Project or folder" : "Project",
        );
        assert.equal(
          document.querySelector('[data-picker-surface="desktop-chat"]'),
          null,
        );
        await click(".task-permission-trigger");
        assert.equal(
          document.querySelectorAll(
            '.task-permission-web-chat [role="menuitemradio"]',
          ).length,
          2,
        );
        await click(".composer-add-trigger");
        assert.doesNotMatch(
          document.querySelector(".composer-add-menu")!.textContent!,
          /Add folder|Record a skill/,
        );
      },
    );
    await withComposer(
      { host, props: { mode: "chat", incognito: true, text: "Unsent draft" } },
      async ({ document }) => {
        assert.ok(
          document.querySelector(
            '.composer-send-slot[data-shown="true"] button[aria-label="Send message"]',
          ),
        );
        assert.equal(
          document
            .querySelector(".composer-idle-slot")
            ?.getAttribute("data-shown"),
          null,
        );
        assert.ok(
          document.querySelector(".composer-idle-slot")?.hasAttribute("inert"),
        );
        assert.ok(document.querySelector(".task-permission-trigger"));
        assert.ok(
          document.querySelector(".composer-chin-leading .cowork-options"),
        );
      },
    );
  }
});

test("main incognito replies preserve host voice composition and the two real permission choices", async () => {
  for (const host of [cloudHost, desktopHost]) {
    await withComposer(
      {
        host,
        props: {
          mode: "chat",
          incognito: true,
          active: { ...active("chat"), incognito: true },
        },
      },
      async ({ document, click }) => {
        // Both keep voice mode beside Dictate; the web's is the reply split
        // button.
        assert.ok(
          document.querySelector(".composer-chin-voice .voice-mode-button"),
        );
        assert.equal(
          Boolean(document.querySelector(".reply-voice-mode")),
          host.kind === "web",
        );
        // The microphone caret: the web's sits in the reply split button.
        assert.ok(
          document.querySelector(
            ".chin-voice-controls :is(.cowork-voice-options, .voice-mode-chevron)",
          ),
        );
        await click(".task-permission-trigger");
        assert.equal(
          document.querySelectorAll(
            '.task-permission-web-chat [role="menuitemradio"]',
          ).length,
          2,
        );
      },
    );
  }
});

test("incognito does not expose the main Chat controls in independent or Code projections", async () => {
  for (const host of [webHost, desktopHost])
    await withComposer(
      { host, native: true, props: { mode: "chat", incognito: true } },
      async ({ document }) => {
        assert.equal(
          document.querySelector(".composer-idle-slot .voice-mode-button"),
          null,
        );
        assert.equal(
          document.querySelector(".composer-chin-leading .cowork-options"),
          null,
        );
        assert.equal(document.querySelector(".task-permission-trigger"), null);
      },
    );
  await withComposer(
    { host: desktopHost, props: { mode: "code", incognito: true } },
    async ({ document }) => {
      assert.equal(
        document.querySelector(".composer-idle-slot .voice-mode-button"),
        null,
      );
      assert.equal(
        document.querySelector(".composer-chin-leading .cowork-options"),
        null,
      );
      assert.equal(document.querySelector(".task-permission-trigger"), null);
    },
  );
});

test("native Code home places Add/mic inside its field and hides empty Send", async () => {
  await withComposer(
    { host: desktopHost, props: { mode: "code" } },
    async ({ document }) => {
      const home = document.querySelector(".code-home-composer")!;
      assert.ok(home);
      assert.ok(
        home.querySelector(
          ".composer-input-row > .popover-anchor > .icon-button",
        ),
      );
      assert.ok(home.querySelector(".composer-input-row .dictation-button"));
      assert.equal(
        home.querySelector(".composer-input-row .send-button"),
        null,
      );
      assert.equal(home.querySelector(".code-voice-controls"), null);
      assert.ok(home.querySelector(".composer-toolbar .model-button"));
      assert.equal(home.querySelector(".code-effort-trigger"), null);
    },
  );
  for (const props of [
    { text: "Draft" },
    {
      attachments: [
        {
          id: "file",
          name: "a.txt",
          path: "/a.txt",
          kind: "text" as const,
          size: 2,
        },
      ],
    },
  ]) {
    await withComposer(
      { host: desktopHost, props: { mode: "code", ...props } },
      async ({ document }) => {
        assert.ok(
          document.querySelector(
            ".code-home-composer .composer-input-row .send-button",
          ),
        );
        assert.equal(
          document.querySelector(".code-home-composer .dictation-button"),
          null,
        );
        assert.ok(
          document.querySelector(
            '.code-permission-trigger[aria-label^="Permissions:"]',
          ),
        );
      },
    );
  }
});

test("native main Chat Add has the captured available rows and delegates a draft folder to the authorized callback", async () => {
  let picked = 0;
  await withComposer(
    {
      host: desktopHost,
      props: {
        mode: "chat",
        pickFolder: async () => {
          picked++;
        },
      },
    },
    async ({ document, click }) => {
      await click(".composer-add-trigger");
      const menu = document.querySelector(".composer-add-native-chat")!;
      assert.ok(menu);
      const labels = [
        ...menu.querySelectorAll(
          ":scope > button, :scope > .composer-add-branch > button",
        ),
      ].map((node) => node.querySelector("span:not([data-icon])")?.textContent);
      assert.deepEqual(labels, [
        "Upload or add files",
        "Add folder",
        "Skills",
        "Add connector",
        "Design system",
        "Add plugins",
        "Research",
      ]);
      assert.doesNotMatch(
        menu.textContent ?? "",
        /Record a skill|Add to project|GitHub|Web search|Thinking/,
      );
      assert.ok(menu.querySelector('[data-icon="FolderPlus"]'));
      await click(".composer-add-native-chat > button:nth-child(2)");
      assert.equal(picked, 1);
      assert.equal(document.querySelector(".composer-add-menu"), null);
    },
  );
});

test("native stored ordinary Chat disables folder addition honestly without mutating a draft or calling folder APIs", async () => {
  let picks = 0,
    nativePicks = 0;
  await withComposer(
    {
      host: desktopHost,
      props: {
        mode: "chat",
        active: active("chat"),
        pickFolder: async () => {
          picks++;
        },
      },
      bridge: {
        chooseFolder: async () => {
          nativePicks++;
          return "/tmp/unexpected";
        },
      },
    },
    async ({ document, click }) => {
      await click(".composer-add-trigger");
      const folder = document.querySelector<HTMLButtonElement>(
        ".composer-add-native-chat > button:nth-child(2)",
      )!;
      assert.equal(folder.disabled, true);
      assert.equal(
        folder.title,
        "This session doesn't support adding folders yet.",
      );
      await click(".composer-add-native-chat > button:nth-child(2)");
      assert.equal(picks, 0);
      assert.equal(nativePicks, 0);
    },
  );
});

test("native stored Cowork Add folder uses the real task grant, supports cancellation, and keeps its conversation target", async () => {
  const conversation = active("cowork");
  const before = structuredClone(conversation);
  const grants: unknown[][] = [];
  let draftPicks = 0;
  const folder = "/tmp/claudex-native-add-menu-synthetic";
  await withComposer(
    {
      host: desktopHost,
      props: {
        mode: "cowork",
        active: conversation,
        pickFolder: async () => {
          draftPicks++;
        },
      },
      bridge: {
        chooseFolder: async () => folder,
        coworkFolderAccess: async () => ({
          state: "ask",
          folder,
          name: "synthetic",
        }),
        grantCoworkFolder: async (...args) => {
          grants.push(args);
          return { state: "granted", folder, name: "synthetic" };
        },
      },
    },
    async ({ document, click }) => {
      await click(".composer-add-trigger");
      await click(".composer-add-native-chat > button:nth-child(2)");
      assert.ok(document.querySelector(".cowork-access-dialog"));
      assert.match(
        document.querySelector(".cowork-access-dialog")?.textContent ?? "",
        /add this folder to the session/,
      );
      await click(
        ".cowork-access-dialog footer button:not(.cowork-access-allow)",
      );
      assert.deepEqual(grants, []);
      assert.deepEqual(conversation, before);
      await click(".composer-add-trigger");
      await click(".composer-add-native-chat > button:nth-child(2)");
      await click(".cowork-access-allow");
      assert.deepEqual(grants, [
        [folder, "session", { conversationId: conversation.id }],
      ]);
      assert.equal(draftPicks, 0);
      assert.equal(conversation.mode, "cowork");
      assert.deepEqual(conversation, before);
    },
  );
});

test("web, independent embedded Chat, and Code retain their existing Add projections", async () => {
  for (const options of [
    { host: cloudHost, props: { mode: "chat" as const } },
    {
      host: webHost,
      native: true,
      props: { mode: "chat" as const, active: active("chat") },
    },
    { host: desktopHost, props: { mode: "code" as const } },
    {
      host: {
        ...desktopHost,
        capabilities: { ...desktopHost.capabilities, localFolders: false },
      },
      props: { mode: "chat" as const },
    },
  ])
    await withComposer(options, async ({ document, click }) => {
      await click(
        options.props.mode === "code"
          ? 'button[aria-label="Add"]'
          : ".composer-add-trigger",
      );
      assert.equal(
        document.querySelector(
          '.composer-add-native-chat [data-icon="FolderPlus"]',
        ),
        null,
      );
      if (options.props.mode === "code")
        assert.equal(document.querySelector(".composer-add-native-chat"), null);
      if (options.native) {
        assert.equal(document.querySelector(".composer-add-native-chat"), null);
        assert.match(
          document.querySelector(".composer-add-menu")?.textContent ?? "",
          /Add to project/,
        );
      }
      if (options.host.kind === "web" && !options.native) {
        assert.ok(document.querySelector(".composer-add-web-chat"));
        assert.doesNotMatch(
          document.querySelector(".composer-add-menu")?.textContent ?? "",
          /Add folder|Record a skill/,
        );
      }
    });
});

test("the bound project overview retains its context without repeating the home project picker", async () => {
  const project = {
    id: "bound-project",
    name: "Bound project",
    description: "",
    instructions: "",
    createdAt: 1,
  };
  for (const projectOverview of [true, false]) {
    await withComposer(
      {
        props: { mode: "chat", project, projects: [project], projectOverview },
      },
      async ({ document }) => {
        const frame = document.querySelector(".composer-wrap")!;
        assert.equal(
          frame.getAttribute("data-project-overview"),
          projectOverview ? "true" : null,
        );
        assert.equal(
          Boolean(
            document.querySelector(
              '.composer-chin[data-place="home"] .cowork-options',
            ),
          ),
          !projectOverview,
        );
        assert.ok(
          document.querySelector(
            '.composer-chin[data-place="home"] .model-effort-pill',
          ),
        );
        assert.ok(
          document.querySelector(
            '.composer-chin[data-place="home"] .task-permission-trigger',
          ),
        );
        if (projectOverview)
          assert.match(
            document.querySelector(".composer-placeholder")?.textContent ??
              document
                .querySelector("[data-placeholder]")
                ?.getAttribute("data-placeholder") ??
              "",
            /New session in Bound project/,
          );
      },
    );
  }
});
