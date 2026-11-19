import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { z } from "zod";
import {
  quickEntryEdgeGap,
  quickEntryMaxHeight,
  quickEntryMaxLength,
  quickEntryPosition,
  quickEntryWidth,
  quickPrompt,
} from "../../shared/quick-entry";
import { extraPagePreferences } from "../extra-pages";

const prefix = "$eipc_message$_2c52b292-adb9-4097-9941-2e3e2dd496b2_$_";
const quickWindow = `${prefix}claude.internal.ui_$_QuickWindow_$_`;
const initialLocale = `${prefix}claude.hybrid_$_DesktopIntl_$_getInitialLocale`;
const positionSchema = z.object({ x: z.number().int(), y: z.number().int() });
const dimension = z.number().int().positive();
const prompt = z.string().max(quickEntryMaxLength).nullable();

function loadPosition(file: string) {
  try {
    return positionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export function openOfficialQuickWindow(options: {
  root: string;
  current: () => boolean;
  locale: () => { locale: string; messages: Record<string, string> };
  submit: (text: string) => Promise<void>;
}) {
  const positionFile = path.join(
    app.getPath("userData"),
    "quick-entry-position.json",
  );
  const saved = loadPosition(positionFile);
  const area = (
    saved ? screen.getDisplayNearestPoint(saved) : screen.getPrimaryDisplay()
  ).workArea;
  const win = new BrowserWindow({
    ...quickEntryPosition(area, saved, quickEntryMaxHeight),
    width: quickEntryWidth,
    height: quickEntryMaxHeight,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    ...(process.platform === "darwin"
      ? { type: "panel", hiddenInMissionControl: true }
      : {}),
    webPreferences: {
      ...extraPagePreferences(
        path.join(options.root, "host"),
        "quick-window-preload.cjs",
      ),
      additionalArguments: [
        '--desktop-managed-config={"disableEssentialTelemetry":true}',
      ],
    },
  });
  const contents = win.webContents;
  win.setAlwaysOnTop(true, "pop-up-menu");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  win.on("blur", () => win.hide());
  win.on("hide", () => {
    const { x, y } = win.getBounds();
    try {
      fs.writeFileSync(positionFile, JSON.stringify({ x, y }), { mode: 0o600 });
    } catch (error) {
      console.error("Could not save Quick Entry position:", error);
    }
  });
  const fromPage = (event: Electron.IpcMainInvokeEvent) =>
    event.senderFrame === contents.mainFrame && options.current();
  contents.ipc.handle(initialLocale, (event) => {
    if (fromPage(event)) return options.locale();
  });
  contents.ipc.handle(
    `${quickWindow}requestDismiss`,
    async (event, raw: unknown) => {
      if (!fromPage(event) || !win.isVisible()) return;
      const result = prompt.safeParse(raw);
      if (!result.success) return;
      win.hide();
      const text = quickPrompt(result.data ?? "");
      if (text) await options.submit(text);
    },
  );
  contents.ipc.handle(
    `${quickWindow}requestSkooch`,
    (event, rawWidth: unknown, rawHeight: unknown) => {
      if (!fromPage(event) || !win.isVisible()) return;
      const width = dimension.safeParse(rawWidth);
      const height = dimension.safeParse(rawHeight);
      if (!width.success || !height.success) return;
      const bounds = win.getBounds();
      const area = screen.getDisplayNearestPoint(bounds).workArea;
      const right = area.x + area.width;
      const bottom = area.y + area.height;
      const x =
        bounds.x + width.data <= right
          ? bounds.x
          : Math.max(area.x, right - width.data - quickEntryEdgeGap);
      const y =
        bounds.y + height.data <= bottom
          ? bounds.y
          : Math.max(area.y, bottom - height.data - quickEntryEdgeGap);
      if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y);
    },
  );
  const loaded = win.loadFile(
    path.join(options.root, "quick-window", "quick-window.html"),
  );
  return { win, loaded };
}
