import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { attachDesignPdf } from "./design-pdf";
import {
  BrowserWindow,
  clipboard,
  dialog,
  nativeTheme,
  type BrowserWindowConstructorOptions,
} from "electron";
import type { ArtifactPreviews } from "./artifact-previews";
import {
  popoutChrome,
  popoutChromeCsp,
  popoutCommand,
  popoutLink,
  type PopoutCommand,
} from "./artifact-popout-page";

/** What the pop-out can save and copy besides showing the rendered page. */
export interface PopoutSource {
  pdfLabel?: string;
  pdfError?: string;
  /** The file name Download suggests. */
  filename?: string;
  /** The artifact's own text (Download, Copy as Markdown). */
  source?: string;
  sourceBase64?: string;
  previewDownload?: boolean;
  language?: string;
}

/**
 * Standalone Artifact windows. Each shows a toolbar page with the artifact
 * in a sandboxed frame; only the toolbar has the restricted PDF preload.
 */
export class ArtifactPopouts {
  private windows = new Set<BrowserWindow>();
  /**
   * `onLink` receives a web address the artifact in a window asked to open;
   * the app asks the person before it leaves Claudex.
   */
  constructor(
    private previews: ArtifactPreviews,
    private onLink: (url: string) => void = () => {},
  ) {}
  open(title: string, content: string, source: PopoutSource = {}) {
    const dark = nativeTheme.shouldUseDarkColors;
    const previewUrl = this.previews.create(content);
    const frameUrl = `${previewUrl}#${randomUUID()}`;
    let chromeUrl: string;
    try {
      chromeUrl = this.previews.create(
        popoutChrome({
          title,
          frameUrl,
          dark,
          platform: process.platform,
          canSave:
            source.source !== undefined || source.sourceBase64 !== undefined,
          canCopy: source.source !== undefined,
          previewDownload: source.previewDownload,
          pdfLabel: source.pdfLabel,
          pdfError: source.pdfError,
        }),
        { csp: popoutChromeCsp },
      );
    } catch (error) {
      this.previews.release(previewUrl);
      throw error;
    }
    const frame: BrowserWindowConstructorOptions =
      process.platform === "darwin"
        ? { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 17 } }
        : {
            titleBarStyle: "hidden",
            titleBarOverlay: {
              color: dark ? "#20201e" : "#f5f4ef",
              symbolColor: dark ? "#c9c8c3" : "#55544f",
              height: 48,
            },
          };
    const popout = new BrowserWindow({
      width: 900,
      height: 700,
      useContentSize: true,
      minWidth: 360,
      minHeight: 280,
      title,
      backgroundColor: dark ? "#1a1a1a" : "#ffffff",
      ...frame,
      webPreferences: {
        preload: path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "design-pdf-preload.cjs",
        ),
        additionalArguments: [`--claudex-design-document=${chromeUrl}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.windows.add(popout);
    const contents = popout.webContents;
    attachDesignPdf(popout, chromeUrl, frameUrl);
    // A link or window.open in the artifact is not followed here: a web
    // address goes to the main window to be confirmed and opened.
    const ask = (url: string) => {
      const link = popoutLink(url);
      if (link) this.onLink(link);
    };
    contents.setWindowOpenHandler(({ url }) => {
      ask(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => event.preventDefault());
    // The artifact's own pages stay inside Claudex's preview documents.
    contents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame || event.url === frameUrl) return;
      event.preventDefault();
      if (!this.previews.has(event.url)) ask(event.url);
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame || !url.startsWith(chromeUrl)) return;
      const command = popoutCommand(url);
      if (command) void this.run(popout, command, title, source);
    });
    popout.on("page-title-updated", (event) => event.preventDefault());
    popout.on("closed", () => {
      this.windows.delete(popout);
      this.previews.release(chromeUrl);
      this.previews.release(previewUrl);
    });
    void popout.loadURL(chromeUrl);
  }
  private async run(
    popout: BrowserWindow,
    command: PopoutCommand,
    title: string,
    source: PopoutSource,
  ) {
    const status = (text: string) =>
      void popout.webContents
        .executeJavaScript(`window.__claudexStatus(${JSON.stringify(text)})`)
        .catch(() => {});
    try {
      if (command === "pin-on" || command === "pin-off")
        popout.setAlwaysOnTop(command === "pin-on");
      if (command === "return") {
        const main = BrowserWindow.getAllWindows().find(
          (value) => !this.windows.has(value),
        );
        popout.close();
        main?.show();
        main?.focus();
      }
      if (command === "copy" && source.source !== undefined) {
        // One backtick more than the longest run inside, as in the panel.
        const longest = Math.max(
          2,
          ...[...source.source.matchAll(/`+/g)].map((run) => run[0].length),
        );
        const fence = "`".repeat(longest + 1);
        clipboard.writeText(
          `# ${title}\n\n${fence}${source.language ?? ""}\n${source.source}\n${fence}`,
        );
        status("Copied as Markdown");
      }
      if (
        command === "download" &&
        (source.source !== undefined || source.sourceBase64 !== undefined)
      ) {
        const result = await dialog.showSaveDialog(popout, {
          defaultPath: path.basename(source.filename || `${title}.html`),
        });
        if (!result.filePath) return;
        fs.writeFileSync(
          result.filePath,
          source.sourceBase64 !== undefined
            ? Buffer.from(source.sourceBase64, "base64")
            : source.source!,
        );
        status(`Saved ${path.basename(result.filePath)}`);
      }
    } catch (error) {
      status(error instanceof Error ? error.message : "That didn't work.");
    }
  }
  closeAll() {
    for (const popout of [...this.windows]) popout.destroy();
  }
}
