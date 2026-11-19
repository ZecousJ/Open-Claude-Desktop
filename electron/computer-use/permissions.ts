/**
 * macOS privacy permissions computer use needs (R10 design §3.1): the
 * driver runs as Claudex's child without its helper app
 * (OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY=1), so the grants macOS
 * records for Claudex are the ones that apply (docs/computer-use.md §4.1).
 * Windows needs no permission; both rows then read "granted".
 *
 * Screen Recording granted while the app runs only applies after a
 * restart: that state is "restart-required".
 */
import { desktopCapturer, shell, systemPreferences } from "electron";
import type {
  ComputerUsePermissionKind,
  ComputerUsePermissions,
  ComputerUsePermissionState,
} from "../../shared/computer-use";

const panes: Record<ComputerUsePermissionKind, string> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

function screenStatus(): ComputerUsePermissionState {
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return "granted";
  if (status === "not-determined") return "not-determined";
  return "denied";
}

export class PermissionMonitor {
  /** Screen Recording as it was when the app started (what capture uses until a restart). */
  private screenAtLaunch =
    process.platform === "darwin" ? screenStatus() : "granted";
  private asked = new Set<ComputerUsePermissionKind>();
  private driverAccessibilityDenied = false;

  constructor(private driverApp?: string) {}

  reportDriverAccessibilityDenied() {
    this.driverAccessibilityDenied = true;
  }

  current(): ComputerUsePermissions {
    if (process.platform !== "darwin")
      return {
        platform: process.platform,
        accessibility: "granted",
        screen: "granted",
      };
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    const driverDenied = this.driverAccessibilityDenied && this.driverApp;
    const screen = screenStatus();
    return {
      platform: "darwin",
      accessibility: trusted && !driverDenied
        ? "granted"
        : driverDenied || this.asked.has("accessibility")
          ? "denied"
          : "not-determined",
      screen:
        screen === "granted" && this.screenAtLaunch !== "granted"
          ? "restart-required"
          : screen,
    };
  }

  /** Both permissions work now. */
  ready() {
    const now = this.current();
    return now.accessibility === "granted" && now.screen === "granted";
  }

  /** Shows the system's prompt (first time) and opens the settings pane. */
  async request(kind: ComputerUsePermissionKind) {
    if (process.platform !== "darwin") return this.current();
    this.asked.add(kind);
    if (kind === "accessibility") {
      if (!this.driverAccessibilityDenied || !this.driverApp)
        systemPreferences.isTrustedAccessibilityClient(true);
    }
    else
      await desktopCapturer
        .getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
        })
        .catch(() => []);
    await this.open(kind);
    return this.current();
  }

  async open(kind: ComputerUsePermissionKind) {
    if (process.platform !== "darwin") return;
    if (kind === "accessibility" && this.driverAccessibilityDenied && this.driverApp) {
      const error = await shell.openPath(this.driverApp);
      if (!error) {
        this.driverAccessibilityDenied = false;
        return;
      }
    }
    await shell.openExternal(panes[kind]);
  }
}
