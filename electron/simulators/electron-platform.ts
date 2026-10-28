/**
 * The simulator platform on Electron: the ask-before-use dialog (a native
 * message box over the main window, 60 seconds to answer), the system
 * browser and Electron's image scaling. `electron/ipc/simulators.ts` loads
 * this file on demand.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  shell,
} from "electron";
import type { AppContext } from "../app/app-context";
import { nativeTranslator } from "../app/native-i18n";
import { preference } from "../../shared/settings-extras";
import type { DialogAnswer } from "./consent";
import { nodeEnvironment, nodeProbe, type SimulatorPlatform } from "./platform";
import type { ImageScaler } from "./png";
import { systemRunner, within } from "./runner";

/** How long the dialog waits for an answer. */
export const dialogTimeoutMs = 60_000;

/** Scales with Electron's image support and encodes JPEG (quality 80); a picture already that size stays PNG. */
export const electronScaler: ImageScaler = (png, size) => {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("The screenshot couldn't be read.");
  const now = image.getSize();
  if (now.width <= size.width && now.height <= size.height)
    return {
      data: image.toJPEG(80),
      mimeType: "image/jpeg",
      width: now.width,
      height: now.height,
    };
  const scaled = image.resize({
    width: size.width,
    height: size.height,
    quality: "good",
  });
  return {
    data: scaled.toJPEG(80),
    mimeType: "image/jpeg",
    width: size.width,
    height: size.height,
  };
};

export function electronPlatform(ctx: AppContext): SimulatorPlatform {
  return {
    environment: nodeEnvironment(),
    probe: nodeProbe,
    runner: systemRunner,
    scaler: electronScaler,
    async ask(text): Promise<DialogAnswer> {
      const translate = await nativeTranslator(
        preference(ctx.store.settings, "locale"),
      );
      const window = ctx.appWindows.main();
      const parent =
        window && !window.isDestroyed()
          ? window
          : BrowserWindow.getAllWindows()[0];
      if (!parent) return "timeout";
      // Claude asks while the person may be in another app: bring the window forward.
      if (parent.isMinimized()) parent.restore();
      parent.show();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), dialogTimeoutMs);
      try {
        const { response } = await dialog.showMessageBox(parent, {
          type: "question",
          title: translate(text.title),
          message: text.message.startsWith("Allow Claudex to use ")
            ? translate("Allow Claudex to use {device}?").replace(
                "{device}",
                text.message.slice("Allow Claudex to use ".length, -1),
              )
            : translate(text.message),
          detail: text.detail.split("\n\n").map(translate).join("\n\n"),
          buttons: text.buttons.map(translate),
          defaultId: 0,
          cancelId: 0,
          signal: abort.signal,
        });
        return response === 1 ? "allow" : "cancel";
      } catch {
        return "timeout";
      } finally {
        clearTimeout(timer);
      }
    },
    async openExternal(url) {
      await shell.openExternal(url);
    },
    onQuit(listener) {
      app.once("will-quit", listener);
    },
    captureFolder: () => app.getPath("desktop"),
    clipboard: {
      read: () => clipboard.readText(),
      write: (text) => clipboard.writeText(text),
    },
    reveal(file) {
      shell.showItemInFolder(file);
    },
    async thumbnail(file, size) {
      // Quick Look's picture of the movie (macOS), as the original's thumbnail.
      const image = await within(
        nativeImage.createThumbnailFromPath(file, size),
        thumbnailTimeoutMs,
        undefined,
      );
      if (!image || image.isEmpty()) return undefined;
      const { width, height } = image.getSize();
      return { data: image.toPNG(), mimeType: "image/png", width, height };
    },
  };
}

/** How long a recording's thumbnail may take. */
const thumbnailTimeoutMs = 5000;
