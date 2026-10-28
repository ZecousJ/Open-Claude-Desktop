import { ConnectorsTab } from "../../src/settings/tabs/Connectors";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Conversation } from "../../shared/types";
import { webHost } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import { HostContext } from "../../src/host/HostContext";
import { CodeModelTrigger } from "../../src/composer/CodeModelTrigger";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { ActivityPanel } from "../../src/cowork/ActivityPanel";
import type { CustomizePlace } from "../../src/web/customize-route";
import { readSource } from "../support/read-source";

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const markup = (element: ReturnType<typeof createElement>) =>
  parseHTML(
    renderToStaticMarkup(
      createElement(HostContext.Provider, { value: webHost }, element),
    ),
  ).document;

// These tests check first-render markup and stylesheet dependency conditions.
// SSR has no layout engine or paint clock; a pass is not browser-frame proof.
test("startup: combined Code trigger layout sheets precede app rendering and are independent of its lazy popup", () => {
  const main = source("src/main.tsx");
  for (const sheet of [
    "code-home/code-home.css",
    "composer/code/code-composer-footer.css",
    "composer/code/code-effort-slider.css",
  ])
    assert.ok(main.includes(`import "./${sheet}";`));
  assert.ok(
    main.indexOf("await loadSlots();") < main.indexOf("renderer.root.render("),
  );
  const composer = readSource("src/composer/Composer.tsx");
  assert.match(
    composer,
    /import \{ CodeModelTrigger \} from "\.\/CodeModelTrigger"/,
  );
  assert.match(composer, /const CodeModelMenu = lazyPiece\(/);
  const style = source("src/code-home/code-home.css");
  assert.match(
    style,
    /\.app :is\(\.code-home-composer, \.code-live-composer\) \.model-button,[^{]+\{[^}]*height:\s*24px;[^}]*font-size:\s*13px;[^}]*line-height:\s*20px;/,
  );
  const popup = source("src/composer/model/code-session-model-menu.css");
  assert.doesNotMatch(popup, /web-code-model-trigger|web-code-model-effort/);
  assert.doesNotMatch(
    source("src/composer/CodeModelTrigger.tsx"),
    /import\s*\(/,
  );
});

test("startup: the initial Code trigger already contains its model and effort before a menu is opened", () => {
  const document = markup(
    createElement(CodeModelTrigger, {
      model: "actual-model-id",
      effort: "high",
      "aria-expanded": false,
      "aria-haspopup": "menu",
    }),
  );
  const trigger = document.querySelector(".web-code-model-trigger")!;
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.match(trigger.textContent!, /actual-model-id/);
  assert.equal(
    trigger.querySelector(".web-code-model-effort")?.textContent,
    "High",
  );
  assert.equal(document.querySelector('[role="menu"]'), null);
});

test("startup: Customize initializes its route synchronously and unresolved detail data never renders a different list or missing-detail error", () => {
  const route = source("src/app/CollectionPages.tsx");
  assert.match(route, /\[place, setPlace\] = useState\(readCustomizePlace\)/);
  const page = readSource("src/collections/customize/CustomizePage.tsx");
  assert.match(page, /useState<Tab>\(route\?\.section \?\? "skills"\)/);
  assert.match(page, /useState<View>\(route\?\.view \?\? "discover"\)/);
  for (const section of ["skills", "plugins"] as const) {
    const route: CustomizePlace = {
      section,
      view: "yours",
      detailId: "not-loaded-yet",
    };
    const document = markup(
      createElement(CustomizePage, {
        settings: defaultSettings,
        route,
        onUseSkill() {},
        onOpenSettings() {},
        onConfirmRemove() {},
        onError(error: unknown) {
          throw error;
        },
      }),
    );
    const pending = document.querySelector('[role="status"]');
    assert.match(
      pending?.textContent ?? "",
      section === "skills" ? /Loading skills/ : /Loading plugins/,
    );
    assert.doesNotMatch(pending?.textContent ?? "", /not found|Couldn’t load/);
    assert.equal(document.querySelector(".customize-head"), null);
    assert.equal(document.querySelector(".customize-rows"), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  }
  const connectors = markup(
    createElement(ConnectorsTab, {
      settings: defaultSettings,
      onError(error: unknown) {
        throw error;
      },
      goTo() {},
      save: async () => true,
      customize: {
        view: "yours",
        detailId: "requested-unresolved-connector",
        onOpen() {},
        onBack() {},
        renderBrowse: () => "SHOULD_NOT_RENDER_ANOTHER_LIST",
      },
    }),
  );
  assert.ok(
    !connectors.body.textContent?.includes("SHOULD_NOT_RENDER_ANOTHER_LIST"),
  );
  assert.ok(!connectors.body.textContent?.includes("Connector not found"));
  assert.equal(connectors.querySelector(".customize-rows"), null);
});

test("startup: Activity loads with its own sheet and an empty web session never passes through the old Progress shell", () => {
  const host = source("src/conversation/ToolSidePanel.tsx");
  assert.match(
    host,
    /const ActivityPanel = lazyPiece\(\s*\(\) => import\("\.\.\/cowork\/ActivityPanel"\)/,
  );
  assert.match(host, /<Suspense fallback=\{null\}>\s*<ActivityPanel/);
  assert.match(
    source("src/cowork/ActivityPanel.tsx"),
    /import "\.\/activity-panel\.css"/,
  );
  const conversation = {
    id: "startup-empty",
    mode: "chat",
    turns: [],
  } as unknown as Conversation;
  const document = markup(
    createElement(ActivityPanel, {
      conversation,
      onArtifact() {},
      onClose() {},
    }),
  );
  assert.ok(document.querySelector(".session-activity-panel"));
  assert.match(
    document.querySelector("h3")?.textContent ?? "",
    /Nothing here yet/,
  );
  assert.equal(document.querySelector(".progress-panel"), null);
  assert.doesNotMatch(
    document.querySelector("aside")?.textContent ?? "",
    /Progress|Approvals|Working folder/,
  );
});

test("startup: a rejected skills request on a direct detail link must stay a retryable load error", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let rejectSkills!: (reason: Error) => void;
  const pendingSkills = new Promise<never>((_, reject) => {
    rejectSkills = reject;
  });
  window.desktop = {
    customizeSkills: () => pendingSkills,
    mcpServers: async () => ({ servers: [] }),
  } as never;
  const globals = {
    window,
    document,
    navigator: { userAgent: "node-test", language: "en-US" },
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const errors: unknown[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: webHost },
          createElement(CustomizePage, {
            settings: defaultSettings,
            route: {
              section: "skills",
              view: "yours",
              detailId: "known-skill",
            },
            onUseSkill() {},
            onOpenSettings() {},
            onConfirmRemove() {},
            onError: (error) => errors.push(error),
          }),
        ),
      ),
    );
    assert.match(document.body.textContent!, /Loading skills/);
    assert.equal(document.querySelector(".customize-head"), null);
    await act(async () => {
      rejectSkills(new Error("inventory offline"));
      await pendingSkills.catch(() => {});
    });
    assert.equal(errors.length, 1, "the real bridge request was rejected");
    assert.doesNotMatch(
      document.body.textContent!,
      /Skill not found/,
      "a failed inventory cannot establish that the requested skill is absent",
    );
    assert.ok(
      [...document.querySelectorAll("button")].some((button) =>
        /Retry|Try again/.test(button.textContent ?? ""),
      ),
      "the failed direct detail request offers an actual retry",
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("startup: microphone styles load with the lazy menu before it renders, and pending/empty rows keep the same height", () => {
  const menu = source("src/composer/MicrophoneMenu.tsx");
  assert.doesNotMatch(
    source("src/main.tsx"),
    /import "\.\/composer\/microphone-menu\.css"/,
  );
  assert.match(menu, /import "\.\/microphone-menu\.css"/);
  assert.ok(
    menu.indexOf('import "./microphone-menu.css"') <
      menu.indexOf("export function MicrophoneMenu"),
  );
  const styles = source("src/composer/microphone-menu.css");
  assert.match(
    styles,
    /\.microphone-menu-idle\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*165px;[^}]*padding:\s*4px 4px 5px;/,
  );
  assert.match(
    styles,
    /\.microphone-menu\.microphone-menu-idle button\s*\{[^}]*height:\s*32px;/,
  );
  assert.match(menu, /t\(devices \? "No devices found" : "Loading\.\.\."\)/);
  assert.match(menu, /variant = "legacy"/);
  assert.match(menu, /useInputLevel\(device, !idle\)/);
  assert.match(menu, /createPortal\([\s\S]*document\.body/);
});

test("startup: home retains the reserved square while the actual preferred reply loading is covered by rendered voice tests", () => {
  const composer = readSource("src/composer/Composer.tsx");
  assert.match(
    composer,
    /fallback=\{\s*<span\s+className="composer-home-voice-placeholder"/,
  );
  assert.match(
    source("src/composer/composer-core.css"),
    /\.composer-home-voice-placeholder\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/,
  );
});

test("startup: the real synchronous caret keeps its node and geometry while voice mode is blocked, without starting audio", async () => {
  const gateName = "__claudexStartupCaretGate";
  const taskGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const savedGate = Object.getOwnPropertyDescriptor(globalThis, gateName);
  let release!: () => void;
  let voiceRequests = 0,
    voiceLoaded = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  taskGlobal[gateName] = {
    wait,
    loaded: () => {
      voiceLoaded = true;
    },
  };
  const actual = new URL(
    "../../src/composer/VoiceModeButton.tsx",
    import.meta.url,
  ).href;
  // Hold the real voice module behind a closed gate. The production caret
  // must render without requesting it. A separate import below exercises the
  // hook so an ineffective interception cannot make this assertion pass.
  const delayed =
    "data:text/javascript," +
    encodeURIComponent(
      [
        `import { VoiceOptionsButton } from ${JSON.stringify(actual)};`,
        `await globalThis[${JSON.stringify(gateName)}].wait;`,
        `globalThis[${JSON.stringify(gateName)}].loaded();`,
        "export { VoiceOptionsButton };",
      ].join("\n"),
    );
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.includes("pcm-capture-worklet.js?"))
        return {
          shortCircuit: true,
          url: "data:text/javascript,export default 'worklet.js'",
        };
      if (
        specifier.includes("VoiceModeButton") &&
        (context.parentURL?.includes("CoworkVoiceControls") ||
          specifier.endsWith("?startup-blocked-voice-probe"))
      ) {
        voiceRequests++;
        return { shortCircuit: true, url: delayed };
      }
      return next(specifier, context);
    },
  });
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let audioCalls = 0;
  const globals = {
    window,
    document,
    navigator: {
      userAgent: "node-test",
      language: "en-US",
      mediaDevices: {
        async getUserMedia() {
          audioCalls++;
          throw Error("unexpected recording");
        },
        async enumerateDevices() {
          audioCalls++;
          return [];
        },
      },
    },
    AudioContext: class {
      constructor() {
        audioCalls++;
        throw Error("unexpected audio context");
      }
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
  const { createRoot } = await import("react-dom/client");
  const { CoworkVoiceControls } = await import(
    new URL(
      "../../src/composer/voice/CoworkVoiceControls.tsx?startup-synchronous-caret",
      import.meta.url,
    ).href
  );
  const root = createRoot(document.querySelector("main")!);
  const cases = [
    {
      name: "native",
      path: ["app", "chat-home", "composer-wrap"],
      extra: "",
      size: [15, 32],
    },
    {
      name: "code-native",
      path: ["app", "composer-wrap code-composer"],
      extra: "code-voice-controls",
      size: [14, 19],
    },
    {
      name: "web-home",
      path: ["app web", "chat-home", "composer-wrap", "composer-idle-slot"],
      extra: "",
      size: [20, 32],
    },
    {
      name: "web-reply",
      path: ["app web", "composer-wrap conversation-composer", "composer-chin"],
      extra: "chin-voice-controls",
      size: [14, 24],
    },
    // These verify the phone DOM scopes, not a simulated CSS viewport. The
    // browser owner must still sample actual fine/coarse phone rectangles.
    {
      name: "phone-home",
      path: [
        "app web sidebar-hidden",
        "chat-home",
        "composer-wrap",
        "composer-idle-slot",
      ],
      extra: "",
      size: [20, 32],
    },
    {
      name: "phone-reply",
      path: [
        "app web sidebar-hidden",
        "composer-wrap conversation-composer",
        "composer-chin",
      ],
      extra: "chin-voice-controls",
      size: [14, 24],
    },
  ];
  const sheets = [
    "src/composer/voice/cowork-voice.css",
    "src/home/chat-home.css",
    "src/composer/composer-core.css",
    "src/composer/code/code-composer-footer.css",
    "src/live-web/composer.css",
  ];
  const rules = sheets.flatMap((file) =>
    [
      ...source(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ]
      .filter(
        ([, selector, body]) =>
          selector.includes("cowork-voice-options") &&
          /(?:width|height|margin|padding|flex)\s*:/.test(body) &&
          !selector.includes("@"),
      )
      .map(([, selector, body]) => ({ file, selector: selector.trim(), body })),
  );
  const matchingGeometry = (element: Element) =>
    rules.filter((rule) => element.matches(rule.selector));
  const controls = () =>
    createElement(
      "div",
      null,
      cases.map(({ name, path, extra }) => {
        let child: ReactElement = createElement(CoworkVoiceControls, {
          options: true,
          menuVariant: name.includes("native") ? "legacy" : "idle",
          className: extra,
          microphone: createElement(
            "button",
            { className: "dictation-button" },
            "Dictate",
          ),
        });
        for (const className of [...path].reverse())
          child = createElement("div", { className }, child);
        return createElement(
          "section",
          { key: name, "data-case": name },
          child,
        );
      }),
    );
  let voiceProbe: Promise<unknown> | undefined;
  try {
    await act(async () => root.render(controls()));
    const initial = new Map<
      string,
      {
        group: Element;
        control: Element;
        selectors: ReturnType<typeof matchingGeometry>;
      }
    >();
    for (const { name, size } of cases) {
      const scope = document.querySelector(`[data-case="${name}"]`)!;
      const control = scope.querySelector(".cowork-voice-options")!;
      assert.equal(
        control.tagName,
        "BUTTON",
        `${name}: caret exists on first render`,
      );
      assert.equal(control.getAttribute("aria-hidden"), null);
      assert.equal(control.getAttribute("aria-label"), "Microphone");
      assert.equal(control.getAttribute("aria-haspopup"), "menu");
      assert.equal(control.getAttribute("aria-expanded"), "false");
      assert.equal(control.getAttribute("tabindex"), null);
      assert.equal(
        scope.querySelectorAll('button[aria-label="Microphone"]').length,
        1,
      );
      assert.ok(
        control.querySelector('[data-icon="CaretDown"]'),
        "the real caret glyph is present instead of a loading placeholder",
      );
      const selectors = matchingGeometry(control);
      assert.ok(
        selectors.some(
          ({ body }) =>
            body.includes(`width: ${size[0]}px`) &&
            body.includes(`height: ${size[1]}px`),
        ),
        name,
      );
      initial.set(name, {
        group: scope.querySelector(".cowork-voice-controls")!,
        control,
        selectors,
      });
    }
    assert.equal(
      voiceRequests,
      0,
      "rendering the caret never requests voice mode",
    );
    assert.equal(voiceLoaded, false);
    assert.equal(audioCalls, 0);

    voiceProbe = import(actual + "?startup-blocked-voice-probe");
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      root.render(controls());
    });
    assert.equal(
      voiceRequests,
      1,
      "the independent probe reached the closed gate",
    );
    assert.equal(
      voiceLoaded,
      false,
      "voice mode is still blocked during the second caret render",
    );
    await act(async () => {
      release();
      await voiceProbe;
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(
      voiceLoaded,
      true,
      "the probe completes only after releasing voice mode",
    );
    assert.equal(
      voiceRequests,
      1,
      "the caret did not add a voice-module request",
    );
    for (const { name } of cases) {
      const scope = document.querySelector(`[data-case="${name}"]`)!;
      const control = scope.querySelector('button[aria-label="Microphone"]')!;
      assert.ok(control, `${name} keeps the actual microphone trigger`);
      assert.equal(control.getAttribute("aria-hidden"), null);
      assert.equal(scope.querySelector("span.cowork-voice-options"), null);
      assert.equal(
        control,
        initial.get(name)!.control,
        `${name}: the synchronous button is never replaced`,
      );
      assert.equal(
        scope.querySelector(".cowork-voice-controls"),
        initial.get(name)!.group,
      );
      assert.deepEqual(
        matchingGeometry(control),
        initial.get(name)!.selectors,
        `${name}: releasing voice mode never changes the caret's geometry rules`,
      );
    }
    assert.equal(
      audioCalls,
      0,
      "rendering the caret and importing voice mode never enumerates or records audio",
    );
  } finally {
    release();
    await voiceProbe?.catch(() => {});
    await act(() => root.unmount());
    hooks.deregister();
    if (savedGate) Object.defineProperty(globalThis, gateName, savedGate);
    else Reflect.deleteProperty(globalThis, gateName);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
