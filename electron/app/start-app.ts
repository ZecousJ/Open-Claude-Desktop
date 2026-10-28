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
import { setExtraPageUrl } from "../extra-pages";
import {
  migrateLocalStorage,
  startIdleRefresh,
  startUiPacks,
  uiPacksActive,
  uiPageUrl,
} from "../ui-pack/launch";
import { steppedZoomLevel } from "./window-zoom";
import { startFindInPage } from "./find-in-page-main";
import {
  cancelRelaunchToUpdate,
  prepareLaunch,
  setUpdateQuitInProgress,
  startAppUpdates,
  updateRelaunchRequested,
} from "../updates/launch";
import {
  app,
  dialog,
  safeStorage,
  powerMonitor,
  protocol,
  session,
} from "electron";
import path from "node:path";
import { Accounts } from "../account/accounts";
import { loadOperatorConfig } from "../../server/operator-config";
import { restoreRemoteAccount } from "../remote/host";
import { mainState } from "./main-state";
import { register } from "./ipc-register";
import { setZoomLevel, showMainWindow, createWindow } from "./main-window";
import {
  artifactPreviews,
  dirname,
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

let waitingToRelaunch = false;
/**
 * Relaunch to update, answered with Wait for Claudex: the quit goes on by
 * itself once no task runs (the window's own dialog does the same; the
 * desktop client's restartToUpdateWhenIdle).
 */
function relaunchWhenIdle() {
  if (waitingToRelaunch) return;
  waitingToRelaunch = true;
  const timer = setInterval(() => {
    if (mainState.quitting || mainState.shutdownComplete) {
      clearInterval(timer);
      return;
    }
    if (mainState.engine?.isBusy()) return;
    clearInterval(timer);
    waitingToRelaunch = false;
    quitConfirmation.interrupt = true;
    app.quit();
  }, 1000);
}

/** The single instance: links, lifecycle and the first window. */
export function startApp() {
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
  /** Other claudex:// links (shared/deep-links.ts): a new chat, a conversation, a project. */
  const openDeepLink = async (href: string) => {
    const link = parseDeepLink(href);
    if (!link) return false;
    if (!app.isReady() || !mainState.window || mainState.window.isDestroyed()) {
      mainState.pendingDeepLink = href;
      if (app.isReady()) await showMainWindow();
    } else {
      await showMainWindow();
      if (mainState.activeAccount)
        sendTo(mainState.window, { type: "deep-link", link });
    }
    return true;
  };
  app.on("open-url", (event, href) => {
    event.preventDefault();
    if (openEmailLink(href)) return;
    if (desktopConnectorLink(href)) void openConnectorLink(href);
    else void openDeepLink(href);
  });
  app.on("second-instance", (_event, argv) => {
    if (argv.some(openEmailLink)) return;
    const href = argv.find((arg) => desktopConnectorLink(arg));
    const deep = argv.find((arg) => parseDeepLink(arg));
    if (href) void openConnectorLink(href);
    else if (deep) void openDeepLink(deep);
    else void showMainWindow();
  });
  app.whenReady().then(async () => {
    captureSessionStacks(session.defaultSession);
    installSupportLogging(app.getPath("logs"));
    try {
      // A misnamed bundle moves to Claudex.app, a staged update left from the
      // last run installs. An update's leftovers never keep
      // Claudex from starting.
      let handedOver = false;
      try {
        handedOver = await prepareLaunch();
      } catch (error) {
        console.warn("update check at launch:", (error as Error).message);
      }
      if (handedOver) return;
      if (app.isPackaged) app.setAsDefaultProtocolClient("claudex");
      protocol.handle("claudex-preview", (request) =>
        artifactPreviews.response(request.url, request.method),
      );
      integration.start();
      // The sleep band (src/code-sleep/SleepBand.tsx): windows learn when
      // the computer slept, and judge which session it interrupted.
      let suspendedAt: number | undefined;
      powerMonitor.on("suspend", () => {
        suspendedAt = Date.now();
      });
      powerMonitor.on("resume", () => {
        if (suspendedAt !== undefined)
          push({ type: "slept", suspendedAt, wakeAt: Date.now() });
        suspendedAt = undefined;
      });
      mainState.accounts = new Accounts(app.getPath("userData"));
      mainState.operatorConfig = loadOperatorConfig(app.getPath("userData"));
      mainState.remoteAccounts = remoteAccountsFor(
        app.getPath("userData"),
        safeStorage,
      );
      try {
        await restoreRemoteAccount(ctx, mainState.remoteAccounts, lifecycle);
      } catch (error) {
        console.error(
          "Saved account session could not be restored:",
          error instanceof Error ? error.message : String(error),
        );
      }
      register();
      installAppMenu(sendCommand, startFindInPage({ appWindows, dirname }), {
        level: () => mainState.zoomLevel,
        step: (delta) =>
          setZoomLevel(steppedZoomLevel(mainState.zoomLevel, delta)),
        reset: () => setZoomLevel(0),
      });
      try {
        startAppUpdates(ctx);
      } catch (error) {
        console.warn("updates:", (error as Error).message);
      }
      // The interface packs: serve the scheme, copy the old page's local
      // storage once, and refresh idle windows to a new pack.
      startUiPacks({
        userData: app.getPath("userData"),
        appVersion: app.getVersion(),
        bundledDir: path.join(dirname, "../dist"),
      });
      await migrateLocalStorage(app.getPath("userData"));
      setExtraPageUrl(
        (page) =>
          hostedUiUrl(page) ?? (uiPacksActive() ? uiPageUrl(page) : undefined),
      );
      startIdleRefresh(() => !!mainState.engine?.isBusy());
      await createWindow();
      mainState.started = true;
    } catch (error) {
      dialog.showErrorBox("Claudex couldn't start", (error as Error).message);
      app.quit();
    }
  });
  app.on("before-quit", (event) => {
    if (mainState.shutdownComplete) return;
    event.preventDefault();
    if (mainState.shuttingDown) return;
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
        // would leave the question out of sight.
        const parent = mainState.window.isVisible()
          ? mainState.window
          : undefined;
        const answer = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        const choice = quitBusyChoice(answer.response);
        if (choice !== "quit") {
          mainState.shuttingDown = false;
          // Relaunch to update + Wait: relaunch by itself once nothing runs.
          // Cancel calls the update's quit off: the next ordinary quit
          // neither installs nor reopens.
          if (choice === "wait" && updateRelaunchRequested())
            relaunchWhenIdle();
          else {
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
      const { timedOut } = await runShutdown([
        {
          name: "window layout",
          run: () => ctx.services.chatWindows?.preserveLayout?.(),
        },
        { name: "integration", run: () => integration.stop() },
        { name: "scheduler", run: () => mainState.scheduler?.stop() },
        {
          name: "terminals",
          run: () => {
            mainState.terminals?.reset();
            mainState.terminals = undefined;
          },
        },
        { name: "engine", run: () => mainState.engine?.stop() },
        {
          name: "artifact shares",
          run: () => mainState.artifactShares?.stop(),
        },
        { name: "store", run: () => mainState.store?.flush() },
      ]);
      if (timedOut.length)
        console.error(`Quit went on without: ${timedOut.join(", ")}`);
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
