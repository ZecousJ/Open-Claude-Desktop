/** Execute actual startApp continuation with inert direct dependencies. */
import fs from "node:fs";
import { registerHooks } from "node:module";
const source = fs.readFileSync(
  new URL("../../electron/app/start-app.ts", import.meta.url),
  "utf8",
);
const mocks: Record<string, Record<string, unknown>> = {};
// Stub direct dependencies, never rewrite/evaluate an extracted startup body.
// An unexpected real operation fails rather than starting a service.
for (const match of source.matchAll(
  /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
)) {
  const [, names, specifier] = match;
  if (specifier === "../official-ui/staged-window") continue;
  mocks[specifier] = Object.fromEntries(
    names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => [
        name,
        function () {
          throw Error(`Unexpected inert dependency ${specifier}:${name}`);
        },
      ]),
  );
}
const noop = () => {};
const state: any = {
  activeAccount: { id: "a" },
  store: {},
  accountRetirement: { accountActivationIdentity: 1, accountRetiring: false },
  started: false,
};
let ready: Promise<void>,
  quits = 0,
  dialogs: string[][] = [],
  createOperation: () => Promise<unknown>;
const listeners: (() => void)[] = [];
Object.assign(mocks.electron, {
  app: {
    on: noop,
    whenReady: () => ({
      then: (fn: () => Promise<void>) => (ready = Promise.resolve().then(fn)),
    }),
    getPath: () => "/inert-not-read",
    getVersion: () => "fixture",
    getLoginItemSettings: () => ({ wasOpenedAtLogin: false }),
    isPackaged: false,
    quit: () => {
      quits++;
    },
  },
  dialog: { showErrorBox: (...args: string[]) => dialogs.push(args) },
  safeStorage: {},
  powerMonitor: { on: noop },
  protocol: { handle: noop },
  session: { defaultSession: {} },
});
Object.assign(mocks["./main-state"], { mainState: state });
Object.assign(mocks["../main"], {
  dirname: "/inert-not-read",
  mainWindowFile: () => "/inert-not-read",
  captureSessionStacks: noop,
  integration: { start: noop },
  activatedListeners: {
    add: (fn: () => void) => {
      listeners.push(fn);
      return noop;
    },
  },
  deactivatingListeners: { add: noop },
  lifecycle: {},
  ctx: {},
  artifactPreviews: {},
  appWindows: {},
  emailLinkWindows: {},
});
Object.assign(mocks["../official-ui/window"], {
  officialUiE2e: () => false,
  createOfficialWindow: async () => {
    return createOperation();
  },
});
Object.assign(mocks["../official-ui/account-browser-storage"], {
  savedAccountUiPorts: () => [],
});
Object.assign(mocks["../main"], { desktopCredentials: {} });
Object.assign(mocks["../account/accounts"], { Accounts: class {} });
Object.assign(mocks["../account/remote-mode"], {
  remoteAccountsFor: () => ({ baseUrl: "https://fixture.invalid", file: { load: () => undefined } }),
});
Object.assign(mocks["./local-provider"], { restoreLocalProvider: async () => {} });
Object.assign(mocks["./main-window"], { deliverPendingDeepLink: async () => {} });
for (const [specifier, names] of Object.entries({
  "../support/support-log": ["installSupportLogging"],
  "./app-menu": ["installAppMenu"],
  "./main-window": ["bindPendingDeepLink"],
  "./find-in-page-main": ["startFindInPage"],
  "./main-window-state": ["readMainWindowState"],
  "../updates/launch": ["prepareLaunch", "startAppUpdates"],
  "../../server/operator-config": ["loadOperatorConfig"],
  "../remote/host": ["restoreRemoteAccount"],
  "./ipc-register": ["register"],
  "../extra-pages": ["setExtraPageUrl"],
  "../ui-pack/launch": [
    "startUiPacks",
    "migrateLocalStorage",
    "startIdleRefresh",
  ],
}))
  for (const name of names) mocks[specifier][name] = noop;
(globalThis as any).__startupStagingMocks = mocks;
registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.endsWith("/electron/app/start-app.ts") &&
      mocks[specifier]
    )
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `const m=globalThis.__startupStagingMocks[${JSON.stringify(specifier)}];` +
              Object.keys(mocks[specifier])
                .map((n) => `export const ${n}=m.${n};`)
                .join(""),
          ),
      };
    return next(specifier, context);
  },
});
const { startApp } = await import("../../electron/app/start-app");
export async function runInertStartup(
  create: () => Promise<unknown>,
  window: unknown,
) {
  createOperation = create;
  state.accountRetirement.accountRetiring = false;
  state.accountRetirement.accountActivationIdentity++;
  state.window = window;
  state.started = false;
  quits = 0;
  dialogs = [];
  listeners.length = 0;
  startApp();
  await ready!;
  return { started: state.started, window: state.window, quits, dialogs };
}

export function retireInertStartup() {
  state.accountRetirement.accountRetiring = true;
  state.accountRetirement.accountActivationIdentity++;
}
