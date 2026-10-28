/**
 * Click-through full-display glow and flashing badge. Escape stops control;
 * screenshots omit it.
 */
import { BrowserWindow, globalShortcut, screen } from "electron";
import { indicatorHtml } from "./indicator-page";

export class FullControlIndicator {
  private win?: BrowserWindow;
  private escape = false;
  private generation = 0;

  constructor(
    onStop: () => void,
    private onEscape: () => void = onStop,
    private translate: () => Promise<(text: string) => string> = async () =>
      (text) =>
        text,
  ) {}

  show(appName?: string) {
    if (!this.escape) {
      this.escape = globalShortcut.register("Escape", () => this.onEscape());
    }
    if (this.win && !this.win.isDestroyed()) return;
    const win = this.win && !this.win.isDestroyed() ? this.win : this.create();
    const generation = ++this.generation;
    void this.translate().then((translate) => {
      if (generation === this.generation && !win.isDestroyed())
        return win.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(indicatorHtml(appName, translate("Claudex is using your computer")))}`,
        );
    });
  }

  private create() {
    const area = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).bounds;
    const win = new BrowserWindow({
      ...area,
      roundedCorners: false,
      type: process.platform === "darwin" ? "panel" : undefined,
      enableLargerThanScreen: true,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    if (process.platform === "darwin") win.setHiddenInMissionControl(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("data:")) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.once("ready-to-show", () => win.showInactive());
    this.win = win;
    return win;
  }

  hide() {
    if (this.escape) {
      globalShortcut.unregister("Escape");
      this.escape = false;
    }
    ++this.generation;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }
}
