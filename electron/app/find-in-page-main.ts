/**
 * Find in page as the app runs it: the bar's views, its IPC channels and
 * the Edit menu's Find…, Find Next and Find Previous (find-in-page.ts).
 * A bar's call is answered only for the bar it came from, from that bar's
 * own top frame, and its arguments are checked.
 */
// The default import is read when the app starts, so tests can load this
// file under plain Node (where "electron" is only the binary's path).
import electron from "electron";
import type { BaseWindow, BrowserWindow, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { findChannels, findMaxLength } from "../../shared/find-in-page";
import type { AppWindows } from "./app-context";
import { FindInPage, type FindWindow } from "./find-in-page";
import { menuState } from "./menu-state";
import { extraPagePreferences, loadExtraPage } from "../extra-pages";

/** What the Edit menu asks of find in page; `window` is the menu's focused window. */
export interface FindMenuActions {
  open(window?: BaseWindow): void;
  step(window: BaseWindow | undefined, forward: boolean): void;
}

const queryArgument = z.string().max(findMaxLength);
const optionsArgument = z
  .object({ forward: z.boolean().optional(), findNext: z.boolean() })
  .strict();

/**
 * Starts find in page; call once the app is ready. The windows searched are
 * the app's own (the main window and conversation windows).
 */
export function startFindInPage(options: {
  appWindows: Pick<AppWindows, "all" | "focused" | "main">;
  dirname: string;
}): FindMenuActions {
  const { WebContentsView, ipcMain } = electron;
  const controller = new FindInPage({
    isMain: (win) => win === options.appWindows.main(),
    // The Code surface uses the compact density (2.37337.1 oNr).
    compact: (win) =>
      win === options.appWindows.main() && menuState().mode === "code",
    createView: () => {
      const view = new WebContentsView({
        webPreferences: extraPagePreferences(
          options.dirname,
          "find-preload.cjs",
        ),
      });
      view.setBackgroundColor("#00000000");
      view.setVisible(false);
      void loadExtraPage(view.webContents, "find.html", options.dirname).catch(
        (error: unknown) =>
          console.error(
            "The find bar could not load:",
            error instanceof Error ? error.message : String(error),
          ),
      );
      return view;
    },
  });
  /** The bar a call came from, from its own top frame. */
  const caller = (event: IpcMainInvokeEvent) => {
    if (event.senderFrame !== event.sender.mainFrame) return undefined;
    return controller.windowOf(event.sender) ? event.sender : undefined;
  };
  ipcMain.handle(findChannels.find, (event, query: unknown, raw: unknown) => {
    const sender = caller(event);
    if (!sender) throw new Error("Untrusted IPC sender");
    return controller.find(
      sender,
      queryArgument.parse(query),
      optionsArgument.parse(raw),
    );
  });
  ipcMain.handle(findChannels.stop, (event) => {
    const sender = caller(event);
    if (sender) controller.stop(sender);
  });
  ipcMain.handle(findChannels.close, (event) => {
    const sender = caller(event);
    if (sender) controller.closeFrom(sender);
  });
  /** The window a menu command searches: an app window, the focused one first. */
  const target = (window?: BaseWindow): FindWindow | undefined => {
    const windows = options.appWindows.all();
    const chosen =
      windows.find((win) => win === window) ??
      options.appWindows.focused() ??
      options.appWindows.main();
    return chosen && !chosen.isDestroyed()
      ? (chosen as BrowserWindow as unknown as FindWindow)
      : undefined;
  };
  return {
    open: (window) => {
      const win = target(window);
      if (win) controller.open(win);
    },
    step: (window, forward) => {
      const win = target(window);
      if (win) controller.step(win, forward);
    },
  };
}
