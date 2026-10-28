import path from "node:path";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import type { ComputerUseTeachStep } from "../../shared/computer-use";
import { teachHtml } from "./teach-page";

/** Click-through teaching tooltip. */
export class TeachOverlay {
  private win?: BrowserWindow;
  private pending?: (answer: "next" | "exit") => void;
  private generation = 0;
  private listeners: [string, (event: Electron.IpcMainEvent) => void][] = [];

  constructor(
    private translate: () => Promise<(text: string) => string>,
    private onExit: () => void,
  ) {}

  async withClickThrough<T>(work: () => Promise<T>): Promise<T> {
    this.win?.setIgnoreMouseEvents(true, { forward: true });
    try {
      return await work();
    } finally {
      if (this.win && !this.win.isDestroyed())
        this.win.webContents.send("cu-teach:hover");
    }
  }

  async show(step: ComputerUseTeachStep): Promise<"next" | "exit"> {
    this.pending?.("exit");
    this.pending = undefined;
    const generation = ++this.generation;
    const translate = await this.translate();
    if (generation !== this.generation) return "exit";
    const display = screen.getDisplayNearestPoint(
      step.anchorLogical ?? screen.getCursorScreenPoint(),
    );
    const area = display.workArea;
    let win = this.win;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        ...area,
        transparent: true,
        frame: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        acceptFirstMouse: true,
        movable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        type: process.platform === "darwin" ? "panel" : undefined,
        show: false,
        webPreferences: {
          preload: path.join(
            app.getAppPath(),
            "dist-electron/teach-preload.cjs",
          ),
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      this.win = win;
      win.once("closed", () => {
        if (this.win === win) this.hide();
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setContentProtection(true);
      if (process.platform === "darwin") win.setHiddenInMissionControl(true);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      for (const action of ["next", "exit", "enter", "leave"] as const) {
        const channel = `cu-teach:${action}`;
        const listener = (event: Electron.IpcMainEvent) => {
          if (
            event.sender !== this.win?.webContents ||
            event.senderFrame !== event.sender.mainFrame
          )
            return;
          if (action === "enter") this.win.setIgnoreMouseEvents(false);
          else if (action === "leave")
            this.win.setIgnoreMouseEvents(true, { forward: true });
          else if (action === "exit") {
            this.hide();
            this.onExit();
          } else {
            this.win.webContents.send("cu-teach:working");
            this.pending?.("next");
            this.pending = undefined;
          }
        };
        ipcMain.on(channel, listener);
        this.listeners.push([channel, listener]);
      }
      await win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(teachHtml(translate))}`,
      );
    }
    if (generation !== this.generation || win.isDestroyed()) return "exit";
    win.setBounds(area);
    win.setIgnoreMouseEvents(true, { forward: true });
    const answer = new Promise<"next" | "exit">((resolve) => {
      this.pending = resolve;
    });
    win.webContents.send("cu-teach:show", {
      ...step,
      anchorLogical: step.anchorLogical && {
        x: step.anchorLogical.x - area.x,
        y: step.anchorLogical.y - area.y,
      },
    });
    win.showInactive();
    return answer;
  }

  hide() {
    ++this.generation;
    this.pending?.("exit");
    this.pending = undefined;
    for (const [channel, listener] of this.listeners)
      ipcMain.removeListener(channel, listener);
    this.listeners = [];
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }
}
