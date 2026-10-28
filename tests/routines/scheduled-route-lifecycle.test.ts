import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
import { webHost } from "../../shared/host";

interface ScheduledProps {
  view?: "yours" | "templates";
  detailId?: string;
  onViewChange?(view: "yours" | "templates"): void;
  onDetailChange?(id?: string): void;
}
interface Probe {
  capture(props: ScheduledProps): void;
  mounted?(props: ScheduledProps): void;
  cleanup?(): void;
}

/** Bundle the real module without mounting the unrelated collection pages.
 * The probe replaces only the child UI; ScheduledRoute and its hooks/URLs
 * are compiled unchanged from CollectionPages.tsx, with their real contexts. */
const project = fileURLToPath(new URL("../../", import.meta.url));
const otherPages = new Set([
  "./ComposerHost",
  "../collections/customize/CustomizePage",
  "../collections/projects/ProjectsPage",
  "../collections/api/ApiPage",
  "../collections/status/ServiceStatusPage",
  "../collections/shared/SharedChatPage",
  "../collections/history/HistoryPage",
]);
const bundled = await build({
  stdin: {
    contents: [
      `export { ScheduledRoute } from ${JSON.stringify(path.join(project, "src/app/CollectionPages.tsx"))};`,
      `export { AppContext } from ${JSON.stringify(path.join(project, "src/app/AppContext.ts"))};`,
      `export { HostContext } from ${JSON.stringify(path.join(project, "src/host/HostContext.tsx"))};`,
      'export { ProbeContext } from "scheduled-route-probe";',
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
        plugin.onResolve({ filter: /.*/ }, (args) => {
          if (otherPages.has(args.path))
            return { path: "other-pages", namespace: "route-test-ui" };
          if (
            args.path === "scheduled-route-probe" ||
            args.path === "../collections/routines/RoutinesPage"
          )
            return { path: "scheduled-probe", namespace: "route-test-ui" };
        });
        plugin.onLoad(
          { filter: /^other-pages$/, namespace: "route-test-ui" },
          () => ({
            contents: [
              "ComposerHost",
              "CustomizePage",
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
          { filter: /^scheduled-probe$/, namespace: "route-test-ui" },
          () => ({
            resolveDir: project,
            contents: `
          import { createContext, useContext, useEffect } from "react";
          export const ProbeContext = createContext(null);
          export function RoutinesPage(props) {
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
const { ScheduledRoute, AppContext, HostContext, ProbeContext } =
  compiledModule.exports as {
    ScheduledRoute: () => ReactElement;
    AppContext: typeof import("../../src/app/AppContext").AppContext;
    HostContext: typeof import("../../src/host/HostContext").HostContext;
    ProbeContext: Context<Probe | null>;
  };

async function fixture(
  initial: string,
  options: {
    strict?: boolean;
    mounted?: Probe["mounted"];
    cleanup?: Probe["cleanup"];
  } = {},
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const address = new URL(initial, "http://scheduled.test");
  const initialState = { claudex: 1, settings: true };
  let state: unknown = initialState;
  const pushes: { url: string; state: unknown }[] = [];
  const globals = {
    window,
    document,
    location: address,
    history: {
      get state() {
        return state;
      },
      pushState(next: unknown, _unused: string, url: string | URL) {
        state = next;
        const destination = new URL(url, address);
        pushes.push({
          url: `${destination.pathname}${destination.search}${destination.hash}`,
          state: next,
        });
        address.href = destination.href;
      },
    },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
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
  let props: ScheduledProps | undefined;
  const probe: Probe = {
    capture: (next) => {
      props = next;
    },
    ...options,
  };
  const app = {
    snapshot: { settings: {}, conversations: [], approvals: [], projects: [] },
    report() {},
    setConfirm() {},
  } as unknown as AppController;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const route = createElement(
    HostContext.Provider,
    { value: webHost },
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(
        ProbeContext.Provider,
        { value: probe },
        createElement(ScheduledRoute),
      ),
    ),
  );
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    await act(async () => root.unmount());
    unmounted = true;
  };
  await act(async () =>
    root.render(
      options.strict ? createElement(StrictMode, null, route) : route,
    ),
  );
  return {
    get props() {
      assert.ok(props);
      return props;
    },
    address,
    pushes,
    initialState,
    unmount,
    async dispose() {
      await unmount();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const operation of ["save", "delete"] as const) {
  test(`a pending ${operation} callback cannot rewrite the address after ScheduledRoute unmounts`, async () => {
    const run = await fixture(
      operation === "save"
        ? "/scheduled-task?view=templates"
        : "/scheduled-task/task-one",
    );
    // Retain the callback exactly as an in-flight save/delete does.
    const retained =
      operation === "save"
        ? run.props.onViewChange!
        : run.props.onDetailChange!;
    let complete!: () => void;
    let invoked = 0;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    }).then(() => {
      invoked++;
      if (operation === "save")
        (retained as NonNullable<ScheduledProps["onViewChange"]>)("yours");
      else
        (retained as NonNullable<ScheduledProps["onDetailChange"]>)(undefined);
    });
    try {
      await run.unmount();
      run.address.href = "http://scheduled.test/new";
      await act(async () => {
        complete();
        await pending;
      });
      assert.equal(invoked, 1, "the operation really completes after unmount");
      assert.deepEqual(run.pushes, []);
      assert.equal(
        `${run.address.pathname}${run.address.search}${run.address.hash}`,
        "/new",
      );
    } finally {
      await run.dispose();
    }
  });
}

test("active ScheduledRoute changes view/detail and retains the Settings hash and entry state", async () => {
  const run = await fixture("/scheduled-task?view=templates#settings/general");
  try {
    assert.equal(run.props.view, "templates");
    await act(async () => run.props.onDetailChange!("task-one"));
    assert.equal(run.props.view, "yours");
    assert.equal(run.props.detailId, "task-one");
    await act(async () => run.props.onViewChange!("templates"));
    assert.equal(run.props.view, "templates");
    assert.equal(run.props.detailId, undefined);
    assert.deepEqual(
      run.pushes.map((entry) => entry.url),
      [
        "/scheduled-task/task-one#settings/general",
        "/scheduled-task?view=templates#settings/general",
      ],
    );
    for (const entry of run.pushes) assert.equal(entry.state, run.initialState);
  } finally {
    await run.dispose();
  }
});

test("same-batch detail close and Yours selection cannot restore the previous task id", async () => {
  const run = await fixture("/scheduled-task/task-one");
  try {
    const current = run.props;
    await act(async () => {
      current.onDetailChange!(undefined);
      current.onViewChange!("yours");
    });
    assert.equal(run.props.detailId, undefined);
    assert.equal(run.props.view, "yours");
    assert.deepEqual(
      run.pushes.map((entry) => entry.url),
      ["/scheduled-task"],
    );
  } finally {
    await run.dispose();
  }
});

test("StrictMode effect replay allows the initial request arriving in its second setup", async () => {
  let setups = 0,
    cleanups = 0;
  const run = await fixture("/scheduled-task?view=templates", {
    strict: true,
    mounted(props) {
      setups++;
      if (setups === 2) props.onViewChange!("yours");
    },
    cleanup() {
      cleanups++;
    },
  });
  try {
    assert.equal(setups, 2);
    assert.equal(cleanups, 1);
    assert.equal(run.props.view, "yours");
    assert.deepEqual(
      run.pushes.map((entry) => entry.url),
      ["/scheduled-task"],
    );
  } finally {
    await run.dispose();
  }
});
