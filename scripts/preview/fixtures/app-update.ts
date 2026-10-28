/**
 * Claudex's own update. By default there is none, as in a development build.
 * `appUpdate=ready` has an update staged (the sidebar shows Relaunch to
 * update); `appUpdate=downloading` is halfway through the download.
 */
import type { AppUpdateStatus } from "../../../shared/app-update-api";
import type { FixtureDomain } from "./index";

export const appUpdateFixture: FixtureDomain = {
  params: {
    appUpdate: "ready | downloading: Claudex 0.0.2 is staged or downloading",
    signInHint: "1: the sign-in card starts with a suggested email",
  },
  bridge: ({ params }) => {
    const phase = params.get("appUpdate");
    const status: AppUpdateStatus =
      phase === "ready" || phase === "downloading"
        ? {
            phase,
            supported: true,
            currentVersion: "0.0.1",
            version: "0.0.2",
            ...(phase === "downloading" ? { progress: 0.5 } : {}),
          }
        : { phase: "idle", supported: false, currentVersion: "0.0.1" };
    return {
      appUpdateStatus: async () => status,
      checkForAppUpdate: async () => status,
      relaunchToUpdate: async () => {},
    };
  },
};
