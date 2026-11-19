import { stagedDocumentCurrent } from "./staged-document-lease";
import { observeAccountTransition, isAccountTransitionMethod } from "./account-transition-events";
import { preference } from "../../shared/settings-extras";
import { ipcMain } from "electron";
import { registerIpcHandler } from "./internal-ipc";
import { mainState } from "./main-state";
import {
  cloudSync,
  localHandlers,
  routedHandlers,
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
  // Only actual authorized dispatch reaches this registered function. Account
  // argument validation remains in the handler; even immediate refusal settles.
  const implementation = fn;
  if (isAccountTransitionMethod(name)) fn = (...args) => observeAccountTransition(name, {
    store: mainState.store,
    generation: mainState.accountRetirement.accountActivationIdentity,
  }, () => implementation(...args));
  // A cloud conversation's call goes to the cloud (electron/cloud).
  registerIpcHandler(name, fn, {
    local: localHandlers,
    routed: routedHandlers,
    route: (name, handler) => cloudSync.route(name, handler),
    expose: (name, routed) => {
      ipcMain.handle("app:" + name, async (event, ...args) => {
        // Only an app window's own top frame may call (the main window, R2's windows).
        const caller = appWindowOf(event.sender);
        if (!caller || event.senderFrame !== event.sender.mainFrame)
          throw new Error("Untrusted IPC sender");
        if (!stagedDocumentCurrent(caller)) throw new Error("This account window has retired.");
        if (
          !mainState.activeAccount &&
          !new Set([
            "authStatus",
            "setupLocalProvider",
            "switchAccount",
            "cancelAddAccount",
            "forgetBrowserAccount",
            "registerAccount",
            "loginAccount",
            "logoutAccount",
            "completeTwoFactor",
            "cancelTwoFactor",
            "sendVerificationCode",
            "referenceFonts",
            "windowAction",
            // The sign-in page (package LOGIN) and its ZecousAI email hint (OTA).
            "requestPasswordReset",
            "resetPassword",
            "sendSignInCode",
            "loginWithCode",
            "loginWithPasskey",
            // Continue with Google (owner, 2026-10-22: on a new install it was
            // refused with "Sign in to continue.").
            "loginWithGoogle",
            "cancelGoogleSignIn",
            "signInEmailHint",
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
    },
  });
}
