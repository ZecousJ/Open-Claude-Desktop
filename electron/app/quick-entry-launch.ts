import { openOfficialQuickWindow } from "./official-quick-window";
import {
  createOfficialNativeQuickAccess,
  officialNativeQuickAccessAvailable,
} from "./official-native-quick-access";
import { mainState } from "./main-state";
import { showMainWindow } from "./main-window";
import {
  officialNativeDictationCredential,
  officialQuickEntryLocale,
  officialQuickEntryRecents,
  officialUiRoot,
  submitOfficialQuickEntry,
} from "../official-ui/window";
import { organizationUuid } from "../official-ui/api/context";
import { preference } from "../../shared/settings-extras";
import type { OfficialQuickEntrySubmission } from "../official-ui/native/quick-entry";
import { deactivatingListeners, appWindows } from "../main";

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
    : toggleOfficialQuickEntry(account.id, action);
  if (launch) {
    void launch.catch((error: unknown) =>
      console.error("Quick Entry could not open:", error),
    );
  }
}
