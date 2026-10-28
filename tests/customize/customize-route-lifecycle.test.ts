import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import {
  act,
  createElement,
  StrictMode,
  type Context,
  type ReactElement,
} from "react";
import type { AppController } from "../../src/app/AppContext";
import type { CustomizePlace } from "../../src/web/customize-route";
import type { CustomizeSkill } from "../../shared/collections-api";
import type { Confirmation } from "../../src/dialogs/ConfirmationDialog";
import { desktopHost, webHost } from "../../shared/host";
import { locales, sourceLocale } from "../../shared/locales";

interface CustomizeProps {
  route?: CustomizePlace;
  onRouteChange?(place: CustomizePlace): void;
  onConfirmRemove(skill: CustomizeSkill, remove: () => Promise<void>): void;
}
interface Probe {
  capture(props: CustomizeProps): void;
  mounted?(props: CustomizeProps): void;
  cleanup?(): void;
}

/** Keep CustomizeRoute, its contexts, hooks and URL parser unchanged.
 * Only the collection child UI is replaced with a capture probe, so this
 * exercises the real parent callbacks without loading unrelated UI/data. */
const project = fileURLToPath(new URL("../../", import.meta.url));
const otherPages = new Set([
  "./ComposerHost",
  "../collections/routines/RoutinesPage",
  "../collections/projects/ProjectsPage",
  "../collections/api/ApiPage",
  "../collections/status/ServiceStatusPage",
  "../collections/shared/SharedChatPage",
  "../collections/history/HistoryPage",
]);
interface RouteModule {
  CustomizeRoute: () => ReactElement;
  AppContext: typeof import("../../src/app/AppContext").AppContext;
  HostContext: typeof import("../../src/host/HostContext").HostContext;
  ProbeContext: Context<Probe | null>;
  setLocale: typeof import("../../src/i18n").setLocale;
}

async function compileRoute(removeUnmountGuard = false): Promise<RouteModule> {
  const bundled = await build({
    stdin: {
      contents: [
        `export { CustomizeRoute } from ${JSON.stringify(path.join(project, "src/app/CollectionPages.tsx"))};`,
        `export { AppContext } from ${JSON.stringify(path.join(project, "src/app/AppContext.ts"))};`,
        `export { HostContext } from ${JSON.stringify(path.join(project, "src/host/HostContext.tsx"))};`,
        'export { ProbeContext } from "customize-route-probe";',
        `export { setLocale } from ${JSON.stringify(path.join(project, "src/i18n/index.ts"))};`,
      ].join("\n"),
      resolveDir: project,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    logLevel: "silent",
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "isolate-collection-page-ui",
        setup(plugin) {
          if (removeUnmountGuard) {
            // Deliberate negative control: remove only this route's guard in
            // memory. Its actual hooks, contexts and URL/history logic remain.
            // Production files are never written or replaced.
            plugin.onLoad(
              { filter: /CollectionPages\.tsx$/, namespace: "file" },
              (args) => {
                const source = readFileSync(args.path, "utf8");
                const start = source.indexOf(
                  "export function CustomizeRoute()",
                );
                const end = source.indexOf("\ninterface ScheduledPlace", start);
                assert.ok(
                  start >= 0 && end > start,
                  "locate the real CustomizeRoute",
                );
                const routeSource = source.slice(start, end);
                const guard = "if (!mounted.current) return;";
                assert.ok(
                  routeSource.includes(guard),
                  "negative control removes the existing unmount guard",
                );
                return {
                  contents:
                    source.slice(0, start) +
                    routeSource.replace(guard, "") +
                    source.slice(end),
                  loader: "tsx",
                  resolveDir: path.dirname(args.path),
                };
              },
            );
          }
          plugin.onResolve({ filter: /.*/ }, (args) => {
            if (otherPages.has(args.path))
              return { path: "other-pages", namespace: "route-test-ui" };
            if (
              args.path === "customize-route-probe" ||
              args.path === "../collections/customize/CustomizePage"
            )
              return { path: "customize-probe", namespace: "route-test-ui" };
          });
          plugin.onLoad(
            { filter: /^other-pages$/, namespace: "route-test-ui" },
            () => ({
              contents: [
                "ComposerHost",
                "RoutinesPage",
                "ProjectsPage",
                "ApiPage",
                "ServiceStatusPage",
                "SharedChatPage",
                "HistoryPage",
              ]
                .map((name) => `export function ${name}() { return null; }`)
                .join("\n"),
            }),
          );
          plugin.onLoad(
            { filter: /^customize-probe$/, namespace: "route-test-ui" },
            () => ({
              resolveDir: project,
              contents: `
          import { createContext, useContext, useEffect } from "react";
          export const ProbeContext = createContext(null);
          export function CustomizePage(props) {
            const probe = useContext(ProbeContext);
            probe.capture(props);
            useEffect(() => {
              probe.mounted?.(props);
              return () => probe.cleanup?.();
            }, []);
            return null;
          }
        `,
            }),
          );
        },
      },
    ],
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports as RouteModule;
}
const actualRoute = await compileRoute();

async function fixture(
  initial: string,
  options: {
    strict?: boolean;
    desktop?: boolean;
    implementation?: RouteModule;
    mounted?: Probe["mounted"];
    cleanup?: Probe["cleanup"];
  } = {},
) {
  const { CustomizeRoute, AppContext, HostContext, ProbeContext } =
    options.implementation ?? actualRoute;
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const address = new URL(initial, "http://customize.test");
  const initialState = {
    claudex: 1,
    settings: { tab: "privacy" },
    routeKey: "fixture",
  };
  const entries: { url: string; state: unknown }[] = [
    { url: address.href, state: initialState },
  ];
  const pushes: { url: string; state: unknown }[] = [];
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let index = 0;
  const url = () => `${address.pathname}${address.search}${address.hash}`;
  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(next: unknown, _unused: string, destination: string | URL) {
      address.href = new URL(destination, address).href;
      entries.splice(++index, entries.length, {
        url: address.href,
        state: next,
      });
      pushes.push({ url: url(), state: next });
    },
    replaceState(next: unknown, _unused: string, destination: string | URL) {
      address.href = new URL(destination, address).href;
      entries[index] = { url: address.href, state: next };
    },
  };
  const globals = {
    window,
    document,
    location: address,
    history,
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      const set =
        listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      set.add(listener);
      listeners.set(type, set);
      window.addEventListener(type, listener);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      listeners.get(type)?.delete(listener);
      window.removeEventListener(type, listener);
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
  let props: CustomizeProps | undefined;
  const captures: CustomizeProps[] = [];
  const probe: Probe = {
    capture(next) {
      props = next;
      captures.push(next);
    },
    mounted: options.mounted,
    cleanup: options.cleanup,
  };
  let confirmation: Confirmation | undefined;
  const setConfirm: AppController["setConfirm"] = (next) => {
    confirmation = typeof next === "function" ? next(confirmation) : next;
  };
  const app = {
    snapshot: { settings: {}, conversations: [], approvals: [], projects: [] },
    report() {},
    setConfirm,
  } as unknown as AppController;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const route = createElement(
    HostContext.Provider,
    { value: options.desktop ? desktopHost : webHost },
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(
        ProbeContext.Provider,
        { value: probe },
        createElement(CustomizeRoute),
      ),
    ),
  );
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    await act(async () => root.unmount());
    unmounted = true;
  };
  const dispose = async () => {
    await unmount();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  try {
    await act(async () =>
      root.render(
        options.strict ? createElement(StrictMode, null, route) : route,
      ),
    );
  } catch (error) {
    await dispose();
    throw error;
  }
  const emit = async (type: string) =>
    act(async () => {
      window.dispatchEvent(new window.Event(type));
    });
  return {
    get props() {
      assert.ok(props);
      return props;
    },
    get confirmation() {
      assert.ok(confirmation, "the actual route requested confirmation");
      return confirmation;
    },
    get url() {
      return url();
    },
    address,
    pushes,
    entries,
    initialState,
    captures,
    listeners,
    unmount,
    dispose,
    async go(delta: number) {
      const target = index + delta;
      assert.ok(
        target >= 0 && target < entries.length,
        "fixture history entry exists",
      );
      index = target;
      address.href = entries[index].url;
      await emit("popstate");
    },
    async hash(hash: string) {
      address.hash = hash;
      await emit("hashchange");
    },
    async externalPop(destination: string) {
      address.href = new URL(destination, address).href;
      await emit("popstate");
    },
  };
}

function assertLateCallbackIgnored(run: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(run.pushes, []);
  assert.equal(run.url, "/new");
  assert.equal(run.listeners.get("popstate")?.size, 0);
  assert.equal(run.listeners.get("hashchange")?.size, 0);
}

const deepLinks: [string, CustomizePlace][] = [
  ["/customize", { section: "skills", view: "discover" }],
  ["/customize/skills", { section: "skills", view: "discover" }],
  [
    "/customize/skills/yours/id/Skill%20%E4%B8%80",
    { section: "skills", view: "yours", detailId: "Skill 一" },
  ],
  [
    "/customize/plugins/discover/id/plugin-one",
    { section: "plugins", view: "discover", detailId: "plugin-one" },
  ],
  [
    "/customize/connectors/yours/id/google-drive#settings/data-privacy-controls",
    { section: "connectors", view: "yours", detailId: "google-drive" },
  ],
  [
    "/customize/skills/yours/id/Skill%20A/contents#settings/general",
    {
      section: "skills",
      view: "yours",
      detailId: "Skill A",
      detailView: "contents",
    },
  ],
];
for (const [address, expected] of deepLinks) {
  test(`CustomizeRoute passes the initial deep link to its child before effects: ${address}`, async () => {
    const run = await fixture(address);
    try {
      assert.deepEqual(run.captures[0].route, expected);
      assert.deepEqual(run.props.route, expected);
      assert.equal(typeof run.props.onRouteChange, "function");
      assert.deepEqual(
        run.pushes,
        [],
        "reading an initial URL does not add history",
      );
      assert.equal(run.url, address);
    } finally {
      await run.dispose();
    }
  });
}

test("the actual installed-skill removal callback preserves names through every locale and the real confirmation DOM", async () => {
  const run = await fixture("/customize/skills/yours/id/Settings/contents");
  const cases: {
    locale: string;
    name: string;
    confirmation: Confirmation;
    expected: string;
    buttons: string[];
  }[] = [];
  let removals = 0;
  const remove = async () => {
    removals++;
  };
  try {
    for (const { id: locale } of locales.filter(
      ({ id }) => id !== sourceLocale,
    )) {
      const catalog: Record<string, string> = (
        await import(`../../shared/i18n/catalogs/${locale}.ts`)
      ).default;
      assert.ok(Object.hasOwn(catalog, "Remove {x}?"));
      await actualRoute.setLocale(locale);
      for (const name of ["Settings", "Search", "Settings {x}", "{project}"]) {
        const skill: CustomizeSkill = {
          name,
          path: `/fixture/${name}/SKILL.md`,
          description: "Search",
          enabled: true,
          own: true,
          scope: "user",
        };
        run.props.onConfirmRemove(skill, remove);
        const actual = run.confirmation;
        const expected = catalog["Remove {x}?"].replace("{x}", name);
        assert.equal(actual.title, expected);
        assert.equal(actual.titleIsUserData, true);
        assert.equal(actual.action, remove);
        assert.equal(removals, 0, "requesting confirmation cannot remove it");
        cases.push({
          locale,
          name,
          confirmation: actual,
          expected,
          buttons: [catalog.Cancel, catalog.Delete],
        });
      }
    }
    // Keep the actual route payload, Modal and document translator. Isolate
    // only the translator's global observer and locale store in a child.
    const script = `
      import {readFileSync} from 'node:fs';
      import {parseHTML} from 'linkedom';
      import {createElement} from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {ConfirmationDialog} from './src/dialogs/ConfirmationDialog.tsx';
      import {setLocale} from './src/i18n/index.ts';
      import {startDomTranslation} from './src/i18n/dom.ts';
      const {window,document}=parseHTML('<html><body></body></html>');
      Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
      const cases=JSON.parse(readFileSync(0,'utf8'));
      const noop=()=>{};
      startDomTranslation();
      const snapshots=[];
      for(const item of [...cases,{locale:'zh-CN',confirmation:{title:'Settings',body:'Search'}},{locale:'zh-CN',confirmation:{title:'Remove Settings?',body:'Search'}}]){
        await setLocale('en-US');
        document.body.innerHTML=renderToStaticMarkup(createElement(ConfirmationDialog,{confirmation:{...item.confirmation,action:async()=>{}},onClose:noop,onError:noop}));
        await setLocale(item.locale);
        const dialog=document.querySelector('[role="alertdialog"]');
        const ids=dialog.getAttribute('aria-labelledby')?.trim().split(/\\s+/);
        if(ids?.some(id=>!document.getElementById(id))) throw new Error('Broken confirmation labelledby');
        const label=ids?.map(id=>document.getElementById(id).textContent).join(' ')??dialog.getAttribute('aria-label');
        snapshots.push({title:dialog.querySelector('h2').textContent,label,buttons:[...dialog.querySelectorAll('button')].map(node=>node.textContent)});
      }
      console.log(JSON.stringify(snapshots));
    `;
    const snapshots: { title: string; label: string; buttons: string[] }[] =
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            "./tests/support/css-stub.mjs",
            "--input-type=module",
            "-e",
            script,
          ],
          { cwd: project, input: JSON.stringify(cases), encoding: "utf8" },
        ),
      );
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index];
      assert.deepEqual(
        snapshots[index],
        { title: item.expected, label: item.expected, buttons: item.buttons },
        `${item.locale}: preserve ${item.name} in the actual confirmation`,
      );
    }
    assert.deepEqual(
      snapshots.at(-2),
      {
        title: "设置",
        label: "设置",
        buttons: ["取消", "删除"],
      },
      "legacy callers still translate interface titles and buttons",
    );
    const originalUnprotectedTitle = snapshots.at(-1);
    assert.ok(originalUnprotectedTitle);
    assert.equal(originalUnprotectedTitle.title, "移除 设置？");
    assert.throws(
      () => assert.equal(originalUnprotectedTitle.title, "移除 Settings？"),
      { code: "ERR_ASSERTION" },
      "the original raw title remains a detected negative control",
    );
    await run.confirmation.action();
    assert.equal(removals, 1, "the original remove action stays connected");
  } finally {
    await actualRoute.setLocale("en-US");
    await run.dispose();
  }
});

test("CustomizeRoute tab, view and detail callbacks push canonical URLs and retain the Settings background", async () => {
  const run = await fixture("/customize/skills#settings/data-privacy-controls");
  const next = async (place: CustomizePlace) => {
    await act(async () => run.props.onRouteChange!(place));
    assert.deepEqual(run.props.route, place);
  };
  try {
    await next({ section: "plugins", view: "discover" });
    await next({ section: "plugins", view: "yours" });
    await next({ section: "plugins", view: "yours", detailId: "plugin 一" });
    await next({ section: "plugins", view: "yours" });
    assert.deepEqual(
      run.pushes.map((entry) => entry.url),
      [
        "/customize/plugins#settings/data-privacy-controls",
        "/customize/plugins/yours#settings/data-privacy-controls",
        "/customize/plugins/yours/id/plugin%20%E4%B8%80#settings/data-privacy-controls",
        "/customize/plugins/yours#settings/data-privacy-controls",
      ],
    );
    for (const entry of run.pushes)
      assert.deepEqual(entry.state, run.initialState);
    const count = run.pushes.length;
    await next({ section: "plugins", view: "yours" });
    assert.equal(
      run.pushes.length,
      count,
      "same address does not duplicate its history entry",
    );
  } finally {
    await run.dispose();
  }
});

test("CustomizeRoute browser back/forward restores child state without writing history", async () => {
  const run = await fixture("/customize/skills#settings/general");
  try {
    await act(async () =>
      run.props.onRouteChange!({ section: "connectors", view: "yours" }),
    );
    await act(async () =>
      run.props.onRouteChange!({
        section: "connectors",
        view: "yours",
        detailId: "notion",
      }),
    );
    await run.go(-1);
    assert.deepEqual(run.props.route, { section: "connectors", view: "yours" });
    await run.go(-1);
    assert.deepEqual(run.props.route, { section: "skills", view: "discover" });
    await run.go(1);
    assert.deepEqual(run.props.route, { section: "connectors", view: "yours" });
    await run.go(1);
    assert.deepEqual(run.props.route, {
      section: "connectors",
      view: "yours",
      detailId: "notion",
    });
    assert.equal(run.pushes.length, 2);
    assert.equal(
      run.url,
      "/customize/connectors/yours/id/notion#settings/general",
    );
  } finally {
    await run.dispose();
  }
});

test("Settings hash changes retain Customize detail and do not push a new background", async () => {
  const run = await fixture("/customize/plugins/yours/id/plugin-one");
  try {
    const place = {
      section: "plugins",
      view: "yours",
      detailId: "plugin-one",
    } as const;
    await run.hash("#settings/data-privacy-controls");
    assert.deepEqual(run.props.route, place);
    await run.hash("#settings/general");
    assert.deepEqual(run.props.route, place);
    await run.hash("");
    assert.deepEqual(run.props.route, place);
    assert.deepEqual(run.pushes, []);
    assert.equal(run.url, "/customize/plugins/yours/id/plugin-one");
  } finally {
    await run.dispose();
  }
});

test("same-batch Customize detail close, tab/view changes and duplicate callbacks do not restore stale detail", async () => {
  const run = await fixture(
    "/customize/skills/yours/id/skill-one/contents#settings/data-privacy-controls",
  );
  try {
    const callback = run.props.onRouteChange!;
    await act(async () => {
      callback({ section: "skills", view: "yours" });
      callback({ section: "plugins", view: "yours" });
      callback({ section: "plugins", view: "discover" });
      callback({ section: "plugins", view: "discover" });
    });
    assert.deepEqual(run.props.route, { section: "plugins", view: "discover" });
    assert.deepEqual(
      run.pushes.map((entry) => entry.url),
      [
        "/customize/skills/yours#settings/data-privacy-controls",
        "/customize/plugins/yours#settings/data-privacy-controls",
        "/customize/plugins#settings/data-privacy-controls",
      ],
    );
    assert.ok(run.pushes.every((entry) => !entry.url.includes("/id/")));
  } finally {
    await run.dispose();
  }
});

for (const strict of [false, true]) {
  test(`a late Customize callback cannot rewrite history after unmount${strict ? " in StrictMode" : ""}`, async () => {
    const run = await fixture(
      "/customize/skills/yours/id/skill-one#settings/data-privacy-controls",
      { strict },
    );
    const retained = run.props.onRouteChange!;
    let complete!: () => void;
    let invoked = 0;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    }).then(() => {
      invoked++;
      retained({ section: "skills", view: "yours" });
    });
    try {
      await run.unmount();
      run.address.href = "http://customize.test/new";
      await act(async () => {
        complete();
        await pending;
      });
      assert.equal(
        invoked,
        1,
        "the operation actually completes after unmount",
      );
      assertLateCallbackIgnored(run);
    } finally {
      await run.dispose();
    }
  });
}

test("negative control detects history pollution when only the real CustomizeRoute unmount guard is removed", async () => {
  const unguarded = await compileRoute(true);
  for (const strict of [false, true]) {
    const run = await fixture(
      "/customize/skills/yours/id/skill-one#settings/data-privacy-controls",
      {
        strict,
        implementation: unguarded,
      },
    );
    const retained = run.props.onRouteChange!;
    try {
      await run.unmount();
      run.address.href = "http://customize.test/new";
      await act(async () => {
        retained({ section: "skills", view: "yours" });
      });
      assert.throws(() => assertLateCallbackIgnored(run), {
        code: "ERR_ASSERTION",
      });
      assert.deepEqual(
        run.pushes.map((entry) => entry.url),
        ["/customize/skills/yours"],
      );
      assert.equal(run.url, "/customize/skills/yours");
    } finally {
      await run.dispose();
    }
  }
});

test("StrictMode replay accepts second-setup navigation and keeps exactly one live URL listener", async () => {
  let setups = 0,
    cleanups = 0;
  const run = await fixture("/customize/skills", {
    strict: true,
    mounted(props) {
      setups++;
      if (setups === 2)
        props.onRouteChange!({ section: "connectors", view: "yours" });
    },
    cleanup() {
      cleanups++;
    },
  });
  try {
    assert.equal(setups, 2);
    assert.equal(cleanups, 1);
    assert.deepEqual(run.props.route, { section: "connectors", view: "yours" });
    assert.deepEqual(
      run.pushes.map((entry) => entry.url),
      ["/customize/connectors/yours"],
    );
    assert.equal(run.listeners.get("popstate")?.size, 1);
    assert.equal(run.listeners.get("hashchange")?.size, 1);
    await run.externalPop("/customize/plugins/yours/id/plugin-one");
    assert.deepEqual(run.props.route, {
      section: "plugins",
      view: "yours",
      detailId: "plugin-one",
    });
    assert.equal(run.pushes.length, 1);
  } finally {
    await run.dispose();
  }
  assert.equal(cleanups, 2);
  assert.equal(run.listeners.get("popstate")?.size, 0);
  assert.equal(run.listeners.get("hashchange")?.size, 0);
});

test("desktop Customize has no web route callbacks or URL listeners", async () => {
  const run = await fixture("/customize/plugins/yours/id/plugin-one", {
    desktop: true,
  });
  try {
    assert.equal(run.props.route, undefined);
    assert.equal(run.props.onRouteChange, undefined);
    assert.equal(run.listeners.size, 0);
    assert.deepEqual(run.pushes, []);
  } finally {
    await run.dispose();
  }
});
