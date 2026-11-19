import { z } from "zod";
import type { ComputerUseAPI } from "../../../shared/computer-use-api";
import type { VoiceAPI } from "../../../shared/voice-api";
import {
  defaultComputerUseSettings,
  type ComputerUsePermissionState,
  type ComputerUseSettings,
} from "../../../shared/computer-use";
import type { ComputerUseSettingsState } from "../../computer-use/service";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

export const computerUsePreferenceKeys = {
  chicagoEnabled: true,
  chicagoAutoUnhide: true,
  chicagoPreferredMode: true,
  chicagoUserDeniedBundleIds: true,
} as const;

export type OfficialComputerUsePreference =
  keyof typeof computerUsePreferenceKeys;

export function officialComputerUsePreference(
  key: string,
): key is OfficialComputerUsePreference {
  return Object.hasOwn(computerUsePreferenceKeys, key);
}

export function computerUsePreferences(
  state: ComputerUseSettingsState | undefined,
) {
  const settings = state?.settings ?? defaultComputerUseSettings;
  return {
    chicagoEnabled: state?.available === true && settings.enabled,
    chicagoAutoUnhide: settings.unhideApps,
    chicagoPreferredMode:
      settings.mode === "fullControl" && state?.allowFullControl
        ? "full_control"
        : "background",
    chicagoUserDeniedBundleIds: settings.deniedApps
      .filter((app) => app.platform === process.platform)
      .map((app) => app.id),
  };
}

export function computerUseFeatures(
  state: ComputerUseSettingsState | undefined,
) {
  const supported = { status: "supported" };
  const unavailable = { status: "unavailable" };
  const feature =
    state?.available
      ? supported
      : {
          status: "unsupported",
          reason:
            state?.reason === "driver"
              ? "Computer use driver is missing"
              : "Computer use is unavailable on this computer",
          unsupportedCode:
            state?.reason === "driver" ? "not_enabled" : "unsupported_platform",
        };
  return {
    computerUse: feature,
    computerUseRollout: state?.available ? supported : unavailable,
    computerUseAppScoped:
      state?.available && process.platform === "darwin"
        ? supported
        : unavailable,
    computerUsePerAppAccess: state?.available ? supported : unavailable,
  };
}

function permission(state: ComputerUsePermissionState | undefined) {
  if (process.platform !== "darwin" || !state) return "not-supported";
  return state === "restart-required" ? "not-determined" : state;
}

const appIds = z.array(z.string().trim().min(1).max(300)).max(100);

export function registerOfficialComputerUse(
  host: NativeHost,
  system: Pick<Electron.SystemPreferences, "getMediaAccessStatus">,
) {
  const { ctx } = host;
  const account = sessionAccountScope(ctx, () => {});
  const run = <T>(operation: () => Promise<T>) =>
    account.run(async () => {
      if (!ctx.account?.() || ctx.isCurrent?.() === false)
        throw Error("The account changed.");
      return account.guard(operation);
    });
  type Methods = ComputerUseAPI &
    Pick<VoiceAPI, "requestMicrophone" | "openMicrophoneSettings">;
  const call = <K extends keyof Methods>(
    method: K,
    ...args: Parameters<Methods[K]>
  ) => {
    if (!ctx.localCall) throw Error("Computer use is unavailable here.");
    return account.guard(() => ctx.localCall!(method, ...args)) as ReturnType<
      Methods[K]
    >;
  };
  const state = () => ctx.computerUseSettingsState?.();
  const microphone = () => {
    if (process.platform !== "darwin") return "not-supported";
    const status = system.getMediaAccessStatus("microphone");
    return status === "unknown" ? "not-supported" : status;
  };
  host.on("ComputerUseTcc.getState", () => {
    const permissions = state()?.permissions;
    return {
      accessibility: permission(permissions?.accessibility),
      screenRecording: permission(permissions?.screen),
      microphone: microphone(),
    };
  });
  host.on("ComputerUseTcc.requestAccessibility", () =>
    run(async () =>
      permission(
        (await call("requestComputerUsePermission", "accessibility"))
          .accessibility,
      ),
    ),
  );
  host.on("ComputerUseTcc.requestScreenRecording", () =>
    run(async () =>
      permission((await call("requestComputerUsePermission", "screen")).screen),
    ),
  );
  host.on("ComputerUseTcc.requestMicrophone", () =>
    run(async () => {
      if (microphone() === "not-determined") await call("requestMicrophone");
      return microphone();
    }),
  );
  host.on("ComputerUseTcc.openSystemSettings", (pane: unknown) =>
    run(async () => {
      const selected = z
        .enum([
          "Privacy_Accessibility",
          "Privacy_ScreenCapture",
          "Privacy_Microphone",
        ])
        .parse(pane);
      if (selected === "Privacy_Microphone")
        return call("openMicrophoneSettings");
      await call(
        "openComputerUsePermissionSettings",
        selected === "Privacy_Accessibility" ? "accessibility" : "screen",
      );
    }),
  );
  host.on("ComputerUseTcc.listInstalledApps", () =>
    run(async () =>
      (await call("computerUseInstalledApps")).map((app) => ({
        bundleId: app.id,
        displayName: app.name,
      })),
    ),
  );
  host.on("ComputerUseTcc.revokeGrant", (session: unknown, appId: unknown) =>
    run(async () => {
      const id = z.string().startsWith("local_").min(7).max(206).parse(session);
      const app = z.string().trim().min(1).max(300).parse(appId);
      await ctx.revokeComputerUseGrant?.(id.slice("local_".length), app);
    }),
  );

  return (key: OfficialComputerUsePreference, value: unknown) =>
    run(async () => {
      let patch: Partial<ComputerUseSettings>;
      switch (key) {
        case "chicagoEnabled":
          patch = { enabled: z.boolean().parse(value) };
          break;
        case "chicagoAutoUnhide":
          patch = { unhideApps: z.boolean().parse(value) };
          break;
        case "chicagoPreferredMode":
          patch = {
            mode:
              z.enum(["background", "full_control"]).parse(value) ===
              "full_control"
                ? "fullControl"
                : "background",
          };
          break;
        case "chicagoUserDeniedBundleIds": {
          const ids = appIds.parse(value);
          const platform = process.platform;
          if (platform !== "darwin" && platform !== "win32")
            throw Error("Computer use is unavailable here.");
          const installed = await call("computerUseInstalledApps");
          const denied = state()?.settings.deniedApps ?? [];
          const names = new Map(
            [...denied, ...installed]
              .filter((app) => app.platform === platform)
              .map((app) => [app.id.toLowerCase(), app.name]),
          );
          patch = {
            deniedApps: [
              ...denied.filter((app) => app.platform !== platform),
              ...ids.map((id) => ({
                id,
                name: names.get(id.toLowerCase()) ?? id.slice(0, 200),
                platform,
              })),
            ],
          };
          break;
        }
      }
      await call("saveComputerUseSettings", patch);
    });
}
