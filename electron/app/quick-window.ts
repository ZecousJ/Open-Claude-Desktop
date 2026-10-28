/**
 * Quick Entry (shared/quick-entry.ts): a small frameless window that floats
 * above everything with one field. The Quick Entry shortcut brings it up (or
 * puts it away when it is up); a submission hides it and hands the prompt to
 * the main window, which starts a new chat with it; Escape, a click outside the
 * field's row or the window losing focus hides it. It opens again where it was
 * put away, also after a restart (the host keeps the position), and is pushed
 * back into the work area when it would run off its right or bottom edge.
 *
 * The class does not import Electron's runtime objects: `QuickWindowHost`
 * creates the window and delivers the prompt, so it runs under the unit tests
 * with a fake window.
 */
import {
  quickEntryChannels,
  quickEntryHeight,
  quickEntryEdgeGap,
  quickEntryMinHeight,
  quickEntryPosition,
  quickEntryWidth,
  quickPrompt,
} from "../../shared/quick-entry";
import type { Attachment } from "../../shared/types";

type Rect = { x: number; y: number; width: number; height: number };

/** The composer's window. */
export interface QuickBrowserWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  destroy(): void;
  getBounds(): Rect;
  setBounds(bounds: Partial<Rect>): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

export interface QuickWindowHost {
  /** A hidden, frameless, always-on-top window loading quick.html. */
  createWindow(bounds: Rect): QuickBrowserWindow;
  /** The work area of the display at a point (the primary one with none). */
  workArea(point?: { x: number; y: number }): Rect;
  /** Shows the main window and starts a new chat there with the prompt. */
  deliver(prompt: string, attachments?: Attachment[]): void;
  /** Where the composer was put away in an earlier run, if it was. */
  loadPosition?(): { x: number; y: number } | undefined;
  /** Remembers where the composer was put away, for the next run. */
  savePosition?(position: { x: number; y: number }): void;
}

export class QuickWindow {
  private win?: QuickBrowserWindow;
  private ready?: Promise<void>;
  private rendererReady?: Promise<void>;
  private resolveRendererReady?: () => void;
  private last?: { x: number; y: number };
  private dictationRequest = 0;
  constructor(private host: QuickWindowHost) {
    this.last = host.loadPosition?.();
  }

  /** The shortcut: brings the composer up, or puts it away when it is up. */
  async toggle() {
    const win = this.window();
    if (win.isVisible()) return this.hide();
    await Promise.all([this.ready, this.rendererReady]);
    if (win.isDestroyed()) return;
    const area = this.host.workArea(this.last);
    const height = win.getBounds().height;
    win.setBounds({
      ...quickEntryPosition(area, this.last, height),
      width: quickEntryWidth,
    });
    win.webContents.send(quickEntryChannels.shown, area.height);
    win.show();
    win.focus();
  }

  async dictation(action: "start" | "stop" | "toggle") {
    const request = ++this.dictationRequest;
    const win = this.window();
    if (!win.isVisible()) {
      if (action === "stop") return;
      await this.toggle();
    }
    await this.ready;
    if (!win.isDestroyed() && request === this.dictationRequest)
      win.webContents.send(quickEntryChannels.dictation, action);
  }

  rendererLoaded(sender: unknown) {
    if (this.owns(sender)) this.resolveRendererReady?.();
  }

  /** Whether `sender` is the composer's own page. */
  owns(sender: unknown) {
    return Boolean(
      this.win && !this.win.isDestroyed() && this.win.webContents === sender,
    );
  }

  /** The field's Enter: hides, then hands a prompt worth sending to the main window. */
  submit(sender: unknown, text: string, attachments?: Attachment[]) {
    if (!this.owns(sender)) return;
    this.hide();
    const prompt = quickPrompt(text);
    if (attachments?.length) this.host.deliver(text.trim(), attachments);
    else if (prompt) this.host.deliver(prompt);
  }

  /** Escape or a click outside the field's row. */
  dismiss(sender: unknown) {
    if (this.owns(sender)) this.hide();
  }

  /**
   * The field grew or shrank: the window takes its height, and moves up
   * (or left) when it would run off the bottom (or right) of the work area.
   */
  resize(sender: unknown, content: number) {
    const win = this.win;
    if (!win || !this.owns(sender)) return;
    const bounds = win.getBounds();
    const area = this.host.workArea(bounds);
    const height = quickEntryHeight(content, area.height);
    const bottom = area.y + area.height - quickEntryEdgeGap;
    const right = area.x + area.width - quickEntryEdgeGap;
    const y =
      bounds.y + height > bottom ? Math.max(area.y, bottom - height) : bounds.y;
    const x =
      bounds.x + quickEntryWidth > right
        ? Math.max(area.x, right - quickEntryWidth)
        : bounds.x;
    win.setBounds({ x, y, width: quickEntryWidth, height });
  }

  /** Puts the composer away, remembering where it was. */
  hide() {
    this.dictationRequest++;
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const { x, y } = win.getBounds();
    this.last = { x, y };
    this.host.savePosition?.(this.last);
    win.webContents.send(quickEntryChannels.hidden);
    win.hide();
  }

  /** The app is going: the composer goes with it. */
  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }

  private window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const area = this.host.workArea();
    const win = this.host.createWindow({
      ...quickEntryPosition(area),
      width: quickEntryWidth,
      height: quickEntryMinHeight,
    });
    this.ready = new Promise((resolve) => win.once("ready-to-show", resolve));
    this.rendererReady = new Promise((resolve) => {
      this.resolveRendererReady = resolve;
    });
    win.on("blur", () => this.hide());
    win.on("closed", () => {
      if (this.win === win) this.win = undefined;
    });
    this.win = win;
    return win;
  }
}
