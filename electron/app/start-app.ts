import { localEdition } from "./edition";
import { restoreLocalProvider } from "./local-provider";
import { reserveLoopbackPort } from "../loopback-ports";
import { savedAccountUiPorts } from "../official-ui/account-browser-storage";
import { createIncognitoRetirement } from "./incognito-retirement";
import {
  finishOfficialWindowActivation,
  OfficialWindowCreationCancelled,
} from "../official-ui/staged-window";
import { installSupportLogging } from "../support/support-log";
import { desktopConnectorLink } from "../../shared/connector-links";
import { parseDeepLink } from "../../shared/deep-links";
import { parseEmailLink } from "../../shared/email-link";
import { hostedUiUrl } from "./hosted-ui";
import { remoteAccountsFor } from "../account/remote-mode";
import { installAppMenu, menuLocale } from "./app-menu";
import { nativeTranslator } from "./native-i18n";
import { quitBusyChoice, quitBusyDialog } from "./quit-dialog";
import { quitConfirmation } from "./quit-confirmation";
import { runShutdown } from "./shutdown";
import { hostPowerHistory } from "./host-power";
import { setExtraPageUrl } from "../extra-pages";
import {
  migrateLocalStorage,
  startIdleRefresh,
  startUiPacks,
  uiPacksActive,
  uiPageUrl,
} from "../ui-pack/launch";
import { steppedZoomLevel } from "./window-zoom";
import { readMainWindowState } from "./main-window-state";
import { savedOfficialTheme, showOfficialStartupShell, writeOfficialBootSurface } from "./official-startup-shell";
import { takeStealthWindow } from "../updates/stealth-window";
import { startFindInPage } from "./find-in-page-main";
import {
  cancelRelaunchToUpdate,
  prepareLaunch,
  setUpdateQuitInProgress,
  startAppUpdates,
} from "../updates/launch";
import {
  app,
  dialog,
  nativeTheme,
  powerMonitor,
  protocol,
  session,
} from "electron";
import path from "node:path";
import { officialLocaleMessages } from "../official-ui/locale";
import { Accounts } from "../account/accounts";
import { loadOperatorConfig } from "../../server/operator-config";
import { restoreRemoteAccount } from "../remote/host";
import { mainState } from "./main-state";
import { register } from "./ipc-register";
import {
  bindPendingDeepLink,
  createWindow,
  deliverPendingDeepLink,
  setZoomLevel,
  showMainWindow,
} from "./main-window";
import {
  createOfficialWindow,
  officialAppWindows,
  showOfficialRecoveryWindow,
  officialUiE2e,
  officialUiEnabled,
  officialUiRoot,
  prepareOfficialUiQuit,
  requestOfficialSupportBundle,
} from "../official-ui/window";
import {
  activatedListeners,
  deactivatingListeners,
  desktopCredentials,
  artifactPreviews,
  dirname,
  mainWindowFile,
  captureSessionStacks,
  integration,
  emailLinkWindows,
  sendTo,
  appWindows,
  sendCommand,
  push,
  ctx,
  lifecycle,
} from "../main";

/** The single instance: links, lifecycle and the first window. */
export function startApp() {
  let quitWhenIdle: ReturnType<typeof setInterval> | undefined;
  const openEmailLink = (href: string) => {
    const link = parseEmailLink(href);
    if (!link) return false;
    const owner = emailLinkWindows.owner(link.request_id);
    if (owner && !owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
      sendTo(owner, { type: "email-sign-in-link", link });
    } else if (!mainState.activeAccount) {
      if (
        !app.isReady() ||
        !mainState.window ||
        mainState.window.isDestroyed()
      ) {
        mainState.pendingEmailLink = href;
        if (app.isReady()) void showMainWindow();
      } else {
        void showMainWindow().then(() => {
          if (mainState.window && !mainState.window.isDestroyed())
            sendTo(mainState.window, { type: "email-sign-in-link", link });
        });
      }
    }
    return true;
  };
  const openConnectorLink = async (href: string) => {
    const connector = desktopConnectorLink(href);
    if (!connector) return;
    if (!app.isReady() || !mainState.window || mainState.window.isDestroyed()) {
      mainState.pendingConnectorLink = connector;
      if (app.isReady()) await showMainWindow();
    } else {
      await showMainWindow();
      sendTo(mainState.window, { type: "connector-link", connector });
    }
  };
  const deliverDeepLink = () =>
    deliverPendingDeepLink().catch(() => {
      console.warn("The desktop link could not be opened.");
    });
  const openDeepLink = (href: string) => {
    const link = parseDeepLink(href);
    if (!link) return false;
    const activation = mainState.activeAccount
      ? mainState.accountRetirement.accountActivationIdentity
      : undefined;
    mainState.pendingDeepLink = { href, link, activation };
    if (mainState.started && (activation === undefined || !mainState.accountRetirement.accountRetiring))
      void showMainWindow().then(deliverDeepLink, () => {
        console.warn("The desktop link window could not be opened.");
      });
    return true;
  };
  app.on("open-url", (event, href) => {
    event.preventDefault();
    if (openEmailLink(href)) return;
    if (desktopConnectorLink(href)) void openConnectorLink(href);
    else openDeepLink(href);
  });
  app.on("second-instance", (_event, argv) => {
    if (argv.some(openEmailLink)) return;
    const href = argv.find((arg) => desktopConnectorLink(arg));
    if (href) void openConnectorLink(href);
    else if (!argv.some(openDeepLink)) void showMainWindow();
  });
  app.whenReady().then(async () => {
    // An e2e run stays in the background: no Dock icon, never the active app.
    if (officialUiE2e() && process.platform === "darwin") {
      app.setActivationPolicy("accessory");
      app.dock?.hide();
    }
    captureSessionStacks(session.defaultSession);
    installSupportLogging(app.getPath("logs"));
    let startupShell: ReturnType<typeof showOfficialStartupShell>;
    try {
      // Package OTA: a misnamed bundle moves to Claudex.app, a staged
      // update left from the last run installs, ZecousAI hands off.
      // An update's leftovers never keep Claudex from starting (owner,
      // 2026-10-22: a staged installer still in use failed the start).
      let handedOver = false;
      try {
        handedOver = !localEdition && await prepareLaunch();
      } catch (error) {
        console.warn("update check at launch:", (error as Error).message);
      }
      if (handedOver) return;
      const savedWindow = readMainWindowState(mainWindowFile());
      mainState.zoomLevel = savedWindow?.zoomLevel ?? 0;
      if (officialUiEnabled())
        for (const port of savedAccountUiPorts(app.getPath("userData"))) reserveLoopbackPort(port);
      if (!localEdition && app.isPackaged && !officialUiE2e() && !process.env.CLAUDEX_DATA_DIR)
        app.setAsDefaultProtocolClient("claudex");
      protocol.handle("claudex-preview", (request) =>
        artifactPreviews.response(request.url, request.method),
      );
      integration.start();
      powerMonitor.on("suspend", () => hostPowerHistory.suspend());
      powerMonitor.on("resume", () => {
        const sleep = hostPowerHistory.resume();
        if (sleep) push({ type: "slept", suspendedAt: sleep.fromMs, wakeAt: sleep.toMs });
      });
      mainState.accounts = new Accounts(app.getPath("userData"));
      mainState.operatorConfig = loadOperatorConfig(app.getPath("userData"));
      const remoteAccounts = localEdition ? undefined : remoteAccountsFor(
        app.getPath("userData"),
        desktopCredentials.cipher,
        desktopCredentials.root,
      );
      mainState.remoteAccounts = remoteAccounts;
      const savedSession = officialUiEnabled() && !officialUiE2e()
        ? remoteAccounts?.file.load()
        : undefined;
      const restoredVisibility = savedSession && savedSession.baseUrl === remoteAccounts?.baseUrl
        ? takeStealthWindow(app.getPath("userData")) : undefined;
      const loginLaunch = process.platform === "darwin" &&
        app.getLoginItemSettings().wasOpenedAtLogin;
      const hiddenAtLogin = loginLaunch && !mainState.pendingDeepLink &&
        !mainState.pendingEmailLink && !mainState.pendingConnectorLink;
      const visibility = hiddenAtLogin
        ? { visible: false, minimized: false }
        : restoredVisibility;
      let retryOfficialWindow = () => {};
      if (remoteAccounts && savedSession?.baseUrl === remoteAccounts.baseUrl && remoteAccounts.hasAccounts) {
        const profile = path.join(app.getPath("userData"), "profiles", savedSession.accountId);
        nativeTheme.themeSource = savedOfficialTheme(profile) ?? "dark";
        const root = officialUiRoot();
        startupShell = showOfficialStartupShell({
          root,
          state: savedWindow,
          profile,
          locale: () => ({ locale: "en-US", messages: officialLocaleMessages(root, "en-US") }),
          zoom: mainState.zoomLevel,
          visibility,
          retry: () => retryOfficialWindow(),
          quit: () => app.quit(),
        });
      }
      try {
        if (remoteAccounts) await restoreRemoteAccount(ctx, remoteAccounts, lifecycle);
        else await restoreLocalProvider();
      } catch (error) {
        console.error(
          "Saved account session could not be restored:",
          error instanceof Error ? error.message : String(error),
        );
      }
      register();
      bindPendingDeepLink();
      deactivatingListeners.add(() => {
        if (mainState.pendingDeepLink?.activation !== undefined)
          mainState.pendingDeepLink = undefined;
      });
      activatedListeners.add(() => {
        const pending = bindPendingDeepLink();
        const official = officialUiEnabled();
        if (!official && !pending) return;
        const signIn = mainState.window;
        const account = mainState.activeAccount;
        const store = mainState.store;
        const generation = mainState.accountRetirement.accountActivationIdentity;
        const current = () =>
          !!account &&
          mainState.activeAccount?.id === account.id &&
          mainState.store === store &&
          mainState.accountRetirement.accountActivationIdentity === generation &&
          mainState.accountRetirement.accountRetiring === false;
        void finishOfficialWindowActivation({
          create: () => official ? createOfficialWindow() : createWindow({ stage: { current } }),
          previous: signIn,
          main: () => mainState.window,
          current,
          close: (win) => win.close(),
          reportFailure: () => {
            if (!official) {
              console.warn("The desktop link window could not be opened.");
              return;
            }
            console.error("Official interface could not be opened.");
            dialog.showErrorBox(
              "Claudex couldn't open the interface",
              "The interface could not be loaded. Please try again.",
            );
            void showOfficialRecoveryWindow().then(deliverDeepLink).catch(() => {
              console.error("The classic interface recovery could not be confirmed.");
            });
          },
        }).then(deliverDeepLink);
      });
      const findWindows = () => [...appWindows.all(), ...officialAppWindows()];
      const find = startFindInPage({
        appWindows: {
          all: findWindows,
          focused: () => findWindows().find((win) => win.isFocused()),
          main: appWindows.main,
        },
        dirname,
      });
      installAppMenu(sendCommand, find, {
        level: () => mainState.zoomLevel,
        step: (delta) =>
          setZoomLevel(steppedZoomLevel(mainState.zoomLevel, delta)),
        reset: () => setZoomLevel(0),
      }, requestOfficialSupportBundle);
      try {
        if (!localEdition) startAppUpdates(ctx);
      } catch (error) {
        console.warn("updates:", (error as Error).message);
      }
      // The interface packs: serve the scheme, copy the old page's local
      // storage once, and refresh idle windows to a new pack.
      if (!localEdition)
        startUiPacks({
          userData: app.getPath("userData"),
          appVersion: app.getVersion(),
          bundledDir: path.join(dirname, "../dist"),
        });
      const legacyStorage = localEdition ? undefined : migrateLocalStorage(app.getPath("userData"));
      setExtraPageUrl(
        (page) =>
          hostedUiUrl(page) ?? (uiPacksActive() ? uiPageUrl(page) : undefined),
      );
      if (!localEdition) startIdleRefresh(() => !!mainState.engine?.isBusy());
      if (officialUiEnabled() && mainState.activeAccount) {
        const startupAccount = mainState.activeAccount;
        const startupStore = mainState.store;
        const startupGeneration =
          mainState.accountRetirement.accountActivationIdentity;
        const open = async () => {
          if (mainState.shuttingDown) return;
          try {
            await createOfficialWindow({
              startup: {
                position: startupShell?.frame() ?? savedWindow,
                visibility,
              },
            });
            startupShell?.close();
            startupShell = undefined;
            if (mainState.started) await deliverDeepLink();
          } catch (error) {
            const retired =
              mainState.activeAccount?.id !== startupAccount.id ||
              mainState.store !== startupStore ||
              mainState.accountRetirement.accountActivationIdentity !== startupGeneration ||
              mainState.accountRetirement.accountRetiring ||
              mainState.shuttingDown;
            if (error instanceof OfficialWindowCreationCancelled) {
              startupShell?.close();
              return;
            }
            if (retired) {
              startupShell?.close();
              console.error("Retired official window cleanup was not confirmed.");
              return;
            }
            if (startupShell) {
              startupShell.failed();
              console.warn("Initial interface failed to open:", error);
              return;
            }
            throw Error("The interface could not be loaded. Please try again.", { cause: error });
          }
        };
        retryOfficialWindow = () => {
          void open().catch(error => console.warn("Initial interface retry failed:", error));
        };
        await open();
      } else if (officialUiE2e()) {
        // An e2e run never shows the sign-in window (nothing typed there by chance).
        console.error(
          "[official-ui] e2e: no signed-in account; sign in to the test profile first.",
        );
        app.exit(3);
        return;
      } else {
        await legacyStorage;
        if (!hiddenAtLogin || mainState.pendingEmailLink || mainState.pendingConnectorLink || mainState.pendingDeepLink)
          await createWindow();
        startupShell?.close();
      }
      mainState.started = true;
      if (hiddenAtLogin && mainState.pendingDeepLink) await showMainWindow();
      await deliverDeepLink();
    } catch (error) {
      startupShell?.close();
      dialog.showErrorBox("Claudex couldn't start", (error as Error).message);
      app.quit();
    }
  });
  app.on("before-quit", (event) => {
    if (mainState.shutdownComplete) return;
    event.preventDefault();
    if (mainState.shuttingDown) return;
    clearInterval(quitWhenIdle);
    quitWhenIdle = undefined;
    mainState.shuttingDown = true;
    setUpdateQuitInProgress(true);
    void (async () => {
      if (
        !mainState.quitting &&
        !quitConfirmation.interrupt &&
        mainState.engine?.isBusy() &&
        mainState.window &&
        !mainState.window.isDestroyed()
      ) {
        // (live Claude desktop bundle, 2026-10-14, index.chunk-BWk6pVUt.js)
        const sessionCount = Math.max(
          1,
          mainState.store?.conversations.filter((conversation) =>
            conversation.turns.some((turn) => turn.status === "inProgress"),
          ).length ?? 1,
        );
        const options = quitBusyDialog(
          await nativeTranslator(menuLocale()),
          sessionCount,
        );
        // The window is the dialog's parent only while it shows; a hidden one
        // would leave the question out of sight (index.chunk-BWk6pVUt.js).
        const parent = mainState.window.isVisible()
          ? mainState.window
          : undefined;
        const answer = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        const choice = quitBusyChoice(answer.response);
        if (choice !== "quit") {
          mainState.shuttingDown = false;
          if (choice === "wait") {
            quitWhenIdle = setInterval(() => {
              if (!mainState.engine?.isBusy()) app.quit();
            }, 1000);
            quitWhenIdle.unref();
          } else {
            setUpdateQuitInProgress(false);
            cancelRelaunchToUpdate();
          }
          return;
        }
      }
      mainState.quitting = true;
      // Every step has a time limit and the whole shutdown 15 s, so a hung
      // engine can't keep Claudex running; the quit then goes on through
      // will-quit, which installs a staged update (app.exit would skip it).
      const store = mainState.store, engine = mainState.engine;
      const activation = mainState.accountRetirement.accountActivationIdentity;
      const incognitoRetirement = createIncognitoRetirement({
        store, engine, selected: ctx.selectedAttachments, feedback: mainState.replyFeedback,
        current: (ownedStore, ownedEngine) => mainState.store === ownedStore && mainState.engine === ownedEngine &&
          mainState.accountRetirement.accountActivationIdentity === activation,
        stop: () => engine?.stop(),
      });
      const { timedOut, failed } = await runShutdown([
        {
          name: "window layout",
          run: () => {
            if (store) writeOfficialBootSurface(store.root);
            return ctx.services.chatWindows?.preserveLayout?.();
          },
        },
        { name: "integration", run: () => integration.stop() },
        { name: "scheduler", run: () => mainState.scheduler?.stop() },
        {
          name: "official auxiliary windows",
          run: () => prepareOfficialUiQuit(),
        },
        {
          name: "browser previews",
          run: () => ctx.services.browser?.dispose?.(),
        },
        {
          name: "terminals",
          run: async () => {
            const terminals = mainState.terminals;
            mainState.terminals = undefined;
            await terminals?.reset();
          },
        },
        { name: "engine and temporary chats", run: () => incognitoRetirement.run(),
          cancel: () => incognitoRetirement.cancel() },
        {
          name: "artifact shares",
          run: () => mainState.artifactShares?.stop(),
        },
        { name: "store", run: () => mainState.store?.flush() },
      ]);
      // Revoke the cleanup even when the overall shutdown limit returned
      // before this step started. A late stop cannot delete anything afterward.
      incognitoRetirement.cancel();
      const incomplete = [...new Set([...timedOut, ...failed])];
      if (incomplete.length)
        console.error(`Quit went on without: ${incomplete.join(", ")}`);
      mainState.shutdownComplete = true;
      app.quit();
    })();
  });
  // The app stays in the background when its last window is closed.
  app.on("window-all-closed", () => {});
  // The dock icon brings the hidden window back (macOS).
  app.on("activate", () => {
    if (!mainState.quitting && app.isReady()) void showMainWindow();
  });
}
