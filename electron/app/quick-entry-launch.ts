import { storeAttachment } from "../engine/composer-files";
import { quickWindowFor } from "./quick-window-main";
import { openOfficialQuickWindow } from "./official-quick-window";
import {
  createOfficialNativeQuickAccess,
  officialNativeQuickAccessAvailable,
} from "./official-native-quick-access";
import path from "node:path";
import { mainState } from "./main-state";
import { showMainWindow } from "./main-window";
import {
  officialNativeDictationCredential,
  officialQuickEntryLocale,
  officialQuickEntryRecents,
  officialUiEnabled,
  officialUiRoot,
  submitOfficialQuickEntry,
} from "../official-ui/window";
import { organizationUuid } from "../official-ui/api/context";
import { preference } from "../../shared/settings-extras";
import type { OfficialQuickEntrySubmission } from "../official-ui/native/quick-entry";
import {
  deactivatingListeners,
  dirname,
  selectedAttachments,
  localCall,
  policy,
  sendTo,
  appWindows,
} from "../main";

let officialPanel: ReturnType<typeof openOfficialQuickWindow> | undefined;
let nativeQuickAccess:
  ReturnType<typeof createOfficialNativeQuickAccess> | undefined;
let mainOpening: Promise<void> | undefined;

async function showQuickEntryMain() {
  mainOpening ??= showMainWindow().finally(() => {
    mainOpening = undefined;
  });
  await mainOpening;
}

function quickEntryOwner(account: string) {
  const activation = mainState.accountRetirement.accountActivationIdentity;
  const current = () =>
    !mainState.quitting &&
    mainState.accountRetirement.accountActivationIdentity === activation &&
    !mainState.accountRetirement.accountRetiring &&
    mainState.activeAccount?.id === account;
  return {
    current,
    submit: async (submission: OfficialQuickEntrySubmission) => {
      const existing = appWindows.main();
      await showQuickEntryMain();
      if (!current()) return;
      submitOfficialQuickEntry(
        existing
          ? submission
          : { text: submission.text, images: submission.images },
      );
    },
  };
}

export function retireQuickEntry() {
  officialPanel?.win.destroy();
  nativeQuickAccess?.retire();
}

async function toggleOfficialQuickEntry(
  account: string,
  action?: "start" | "stop" | "toggle",
) {
  if (action === "stop") {
    nativeQuickAccess?.stop();
    return;
  }
  const owner = quickEntryOwner(account);
  const main = appWindows.main();
  if (!action && main?.isFullScreen()) {
    await showQuickEntryMain();
    if (owner.current()) submitOfficialQuickEntry("new-chat");
    return;
  }
  const root = officialUiRoot();
  if (!nativeQuickAccess && officialNativeQuickAccessAvailable(root)) {
    nativeQuickAccess = createOfficialNativeQuickAccess(root);
    if (nativeQuickAccess) deactivatingListeners.add(retireQuickEntry);
  }
  if (nativeQuickAccess) {
    const settings = mainState.store.settings;
    const shortcut = preference(settings, "quickEntryDictationShortcut");
    await nativeQuickAccess.open({
      owner,
      chats: officialQuickEntryRecents(),
      language: preference(settings, "locale"),
      credentials: officialNativeDictationCredential(),
      organization: organizationUuid(account),
      mode:
        shortcut === "capslock" || shortcut === "double-tap-capslock"
          ? "caps-lock"
          : "custom",
      action,
    });
    return;
  }
  if (action) return;
  if (officialPanel?.win.isVisible()) {
    officialPanel.win.hide();
    return;
  }
  if (!officialPanel) {
    const panel = openOfficialQuickWindow({
      root,
      current: owner.current,
      locale: () => officialQuickEntryLocale(root),
      submit: (text) => owner.submit({ text, images: [] }),
    });
    officialPanel = panel;
    const stop = deactivatingListeners.add(retireQuickEntry);
    panel.win.once("closed", () => {
      stop();
      if (officialPanel === panel) officialPanel = undefined;
    });
    try {
      await panel.loaded;
    } catch (error) {
      if (panel.win.isDestroyed()) return;
      panel.win.destroy();
      throw error;
    }
  }
  const panel = officialPanel;
  if (panel) {
    await panel.loaded;
    if (!panel.win.isDestroyed()) panel.win.show();
  }
}

export function openQuickEntry(action?: "start" | "stop" | "toggle") {
  if (
    !mainState.started ||
    mainState.quitting ||
    (mainState.activeAccount && mainState.accountRetirement.accountRetiring)
  )
    return;
  const account = mainState.activeAccount;
  const launch = !account
    ? action !== "stop" && showQuickEntryMain()
    : officialUiEnabled() && toggleOfficialQuickEntry(account.id, action);
  if (launch) {
    void launch.catch((error: unknown) =>
      console.error("Quick Entry could not open:", error),
    );
    return;
  }
  if (!mainState.activeAccount) return;
  mainState.quickEntry ??= quickWindowFor({
    dirname,
    main: () => appWindows.main(),
    showMain: () => {
      const main = appWindows.main();
      if (!main) return undefined;
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      return main;
    },
    send: sendTo,
    voice: (method, ...args) => {
      if (!mainState.activeAccount)
        throw Error("Your session ended. Sign in again to continue.");
      return localCall(method, ...args);
    },
    attach: (images) =>
      images.map(({ name, data }) => {
        if (!mainState.activeAccount)
          throw Error("Your session ended. Sign in again to continue.");
        const attachment = storeAttachment(
          path.join(mainState.store.root, "attachments"),
          name,
          data,
          policy(),
          true,
        );
        selectedAttachments.set(attachment.id, attachment);
        return attachment;
      }),
  });
  if (action) void mainState.quickEntry.dictation(action);
  else void mainState.quickEntry.toggle();
}
