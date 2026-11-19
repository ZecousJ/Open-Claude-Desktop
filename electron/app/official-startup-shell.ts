import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, nativeTheme, screen } from "electron";
import { z } from "zod";
import type { Settings } from "../../shared/types";
import { mainWindowChrome } from "./main-window-chrome";
import { mainWindowPlacement, type MainWindowState } from "./main-window-state";
import { zoomFactorOf } from "./window-zoom";
import type { StealthWindow } from "../updates/stealth";

export function officialWindowPlacement(
  state: MainWindowState | undefined,
  display: { width?: number; height?: number } | undefined,
) {
  const primary = screen.getPrimaryDisplay();
  if (!state?.bounds)
    return {
      width: Math.min(display?.width ?? 1440, primary.workArea.width),
      height: Math.min(display?.height ?? 900, primary.workArea.height),
    };
  return mainWindowPlacement(state, [
    primary.workArea,
    ...screen
      .getAllDisplays()
      .filter((item) => item.id !== primary.id)
      .map((item) => item.workArea),
  ]);
}

const windowMode = z.enum(["system", "light", "dark"]);
const frameLayout = z.object({
  sidebarWidth: z.number().finite().min(0).max(10000),
  collapsed: z.boolean(),
  narrowViewportMaxWidth: z.number().finite().min(0).max(10000),
});
const shape = z.object({
  top: z.number().finite().min(0).max(10000),
  left: z.number().finite().min(0).max(10000),
  width: z.number().finite().min(0).max(10000),
  height: z.number().finite().min(0).max(10000),
  radius: z.number().finite().min(0).max(10000),
});
const rgba = z.object({
  red: z.number().finite().min(0).max(255),
  green: z.number().finite().min(0).max(255),
  blue: z.number().finite().min(0).max(255),
  alpha: z.number().finite().min(0).max(1),
});
export const officialBootColors = z.object({
  dark: z.boolean(),
  page: rgba.extend({ alpha: z.literal(1) }),
  sidebar: rgba.optional(),
  seam: rgba.optional(),
});
const snapshot = z.object({
  layout: frameLayout.optional(),
  shapes: z.array(shape).max(160).optional(),
  light: officialBootColors.optional(),
  dark: officialBootColors.optional(),
});
type Snapshot = z.infer<typeof snapshot>;
const filename = "official-startup-frame.json";
function readFrame(folder: string): Snapshot {
  try {
    return snapshot.parse(
      JSON.parse(fs.readFileSync(path.join(folder, filename), "utf8")),
    );
  } catch {
    return {};
  }
}
const freshFrames = new Map<string, Snapshot>();

export function recordOfficialBootSurface(
  profile: string,
  field: "layout" | "shapes",
  value: unknown,
) {
  const current = freshFrames.get(profile) ?? readFrame(profile);
  if (field === "layout") {
    const next = frameLayout.safeParse(value);
    if (!next.success) return;
    current.layout = next.data;
  } else {
    const next = z.array(shape).max(160).safeParse(value);
    if (!next.success) return;
    current.shapes = next.data;
  }
  freshFrames.set(profile, current);
}

export function recordOfficialBootColors(profile: string, colors: z.infer<typeof officialBootColors>) {
  const current = freshFrames.get(profile) ?? readFrame(profile);
  current[colors.dark ? "dark" : "light"] = colors;
  freshFrames.set(profile, current);
}

export function writeOfficialBootSurface(profile: string) {
  const current = freshFrames.get(profile);
  if (!current) return;
  const file = path.join(profile, filename);
  try {
    fs.writeFileSync(file + ".tmp", JSON.stringify(current), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  } catch (error) {
    console.warn("Could not save the startup frame.", error);
  }
}

export function savedOfficialTheme(
  profile: string,
): Settings["theme"] | undefined {
  try {
    return windowMode.safeParse(
      JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"))
        .theme,
    ).data;
  } catch {
    return;
  }
}

function sidebarShapes(width: number) {
  const row = (top: number, left: number, width: number, height = 13) => ({
    top,
    left,
    width,
    height,
    radius: 4,
  });
  return [
    ...[36, 56, 60, 72].flatMap((width, i) => {
      const top = 60 + i * 26;
      return [row(top - 1, 14, 16, 16), row(top, 34, width)];
    }),
    row(188, 14, 88, 10),
    ...[0.68, 0.54, 0.44, 0.68, 0.54].flatMap((fraction, i) => {
      const top = 218 + i * 26;
      return [
        { ...row(top + 3, 19, 6, 6), radius: 3 },
        row(top, 38, Math.round(Math.max(0, width - 20) * fraction)),
      ];
    }),
  ];
}

const titleBar =
  "$eipc_message$_2c52b292-adb9-4097-9941-2e3e2dd496b2_$_claude.internal.ui_$_MainWindowTitleBar_$_";

export function showOfficialStartupShell(options: {
  root: string;
  state: MainWindowState | undefined;
  profile: string;
  locale(): { locale: string; messages: Record<string, string> };
  zoom: number;
  visibility: StealthWindow | undefined;
  retry(): void;
  quit(): void;
}) {
  const { root, state, profile, zoom, visibility } = options;
  const shell = path.join(root, "main-window", "index.html");
  if (
    !fs.existsSync(shell) ||
    (visibility && (!visibility.visible || visibility.minimized))
  )
    return;
  const dark = nativeTheme.shouldUseDarkColors;
  const saved = readFrame(profile);
  const reported = dark ? saved.dark : saved.light;
  const ground = reported
    ? `rgb(${reported.page.red}, ${reported.page.green}, ${reported.page.blue})`
    : dark
      ? "#151515"
      : "#fcfcfb";
  const layout = saved.layout ?? {
    sidebarWidth: 288,
    collapsed: false,
    narrowViewportMaxWidth: 700,
  };
  const display = JSON.parse(
    fs.readFileSync(path.join(root, "data", "display-settings.json"), "utf8"),
  ).window;
  const frame = {
    ...layout,
    zoomFactor: zoomFactorOf(zoom),
    shapes: saved.shapes ?? sidebarShapes(layout.sidebarWidth),
  };
  const win = new BrowserWindow({
    ...officialWindowPlacement(state, display),
    minWidth: 600,
    minHeight: 400,
    show: false,
    paintWhenInitiallyHidden: true,
    title: "Claudex",
    backgroundColor: ground,
    ...mainWindowChrome(process.platform, zoom, dark),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(root, "host", "main-window-preload.cjs"),
      additionalArguments: [
        '--desktop-managed-config={"disableEssentialTelemetry":true}',
        `--desktop-boot-placeholder=${JSON.stringify({ enabled: true, frame, colors: dark ? saved.dark : saved.light })}`,
      ],
    },
  });
  let ready = false;
  let failed = false;
  function report() {
    if (ready && !win.isDestroyed()) {
      if (failed)
        win.webContents.send(titleBar + "showLoadError", {
          errorTitle: "Claudex couldn’t load",
          errorDescription: "Try reloading the page.",
          retrying: false,
        });
      else win.webContents.send(titleBar + "hideLoadError");
    }
  }
  win.webContents.ipc.handle(
    "$eipc_message$_2c52b292-adb9-4097-9941-2e3e2dd496b2_$_claude.hybrid_$_DesktopIntl_$_getInitialLocale",
    options.locale,
  );
  win.webContents.ipc.handle(titleBar + "titleBarReady", () => {
    ready = true;
    report();
  });
  win.webContents.ipc.handle(titleBar + "requestReloadMainView", () => {
    if (!failed) return;
    failed = false;
    report();
    options.retry();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("close", options.quit);
  // The recovered shell is the first visible document. Waiting for an
  // occluded renderer to paint before showing it can delay paint on Windows.
  if (state?.fullScreen) win.setFullScreen(true);
  else if (state?.maximized) win.maximize();
  if (visibility) win.showInactive();
  else win.show();
  void win.loadFile(shell).catch(() => {
    if (!win.isDestroyed()) win.destroy();
  });
  return {
    frame() {
      if (win.isDestroyed() || !win.isVisible()) return state;
      return {
        version: 1 as const,
        bounds: win.getNormalBounds(),
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen(),
        zoomLevel: zoom,
      };
    },
    failed() {
      failed = true;
      report();
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
