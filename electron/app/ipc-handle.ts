import { preference } from "../../shared/settings-extras";
import { ipcMain } from "electron";
import { mainState } from "./main-state";
import {
  cloudSync,
  localHandlers,
  currentAccountDevices,
  callerWindows,
  emailLinkWindows,
  appWindowOf,
} from "../main";

export function handle(name: string, fn: (...args: any[]) => any) {
  if (name === "listCoworkDevices")
    fn = () => {
      const state = currentAccountDevices();
      return state
        ? [
            state.registration.snapshot(
              true,
              preference(mainState.store.settings, "computerAccess"),
            ),
          ]
        : [];
    };
  // A cloud conversation's call goes to the cloud (electron/cloud).
  localHandlers.set(name, fn);
  const routed = cloudSync.route(name, fn);
  ipcMain.handle("app:" + name, async (event, ...args) => {
    // Only an app window's own top frame may call (the main window, R2's windows).
    const caller = appWindowOf(event.sender);
    if (!caller || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Untrusted IPC sender");
    if (
      !mainState.activeAccount &&
      !new Set([
        "authStatus",
        "registerAccount",
        "loginAccount",
        "logoutAccount",
        "completeTwoFactor",
        "cancelTwoFactor",
        "sendVerificationCode",
        "windowAction",
        // The sign-in page's other ways in.
        "requestPasswordReset",
        "setServiceAddress",
        "resetPassword",
        "sendSignInCode",
        "loginWithCode",
        "loginWithPasskey",
        // Continue with Google.
        "loginWithGoogle",
        "cancelGoogleSignIn",
        // "Update Claudex" when the service refuses this version.
        "checkForAppUpdate",
        "relaunchToUpdate",
      ]).has(name)
    )
      throw new Error("Sign in to continue.");
    try {
      const result = await callerWindows.run(caller, () => routed(...args));
      if (
        name === "sendSignInCode" &&
        typeof args[1]?.request_id === "string"
      ) {
        emailLinkWindows.remember(args[1].request_id, caller);
      }
      return result;
    } catch (error) {
      const value = error as { code?: string; metadata?: unknown };
      if (
        typeof value?.code === "string" &&
        /^(action_verification_required|challenge_|invalid_code|code_not_sent|no_email_address|unavailable)/.test(
          value.code,
        )
      )
        throw Error(
          "CLAUDEX_ACTION_VERIFICATION:" +
            JSON.stringify({ code: value.code, metadata: value.metadata }),
        );
      throw error;
    }
  });
}
