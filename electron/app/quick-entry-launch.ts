import { storeAttachment } from "../engine/composer-files";
import { quickWindowFor } from "./quick-window-main";
import path from "node:path";
import { mainState } from "./main-state";
import {
  dirname,
  selectedAttachments,
  localCall,
  policy,
  sendTo,
  appWindows,
} from "../main";

export function openQuickEntry(action?: "start" | "stop" | "toggle") {
  if (!mainState.activeAccount) {
    // Signed out the shortcut brings the sign-in window forward (desktop
    // client 2.37337.1: the Quick Entry request shows the main window).
    const main = appWindows.main();
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    return;
  }
  mainState.quickEntry ??= quickWindowFor({
    dirname,
    main: () => appWindows.main(),
    showMain: () => {
      const main = appWindows.main();
      if (!main) return undefined;
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      return main;
    },
    send: sendTo,
    voice: (method, ...args) => {
      if (!mainState.activeAccount)
        throw Error("Your session ended. Sign in again to continue.");
      return localCall(method, ...args);
    },
    attach: (images) =>
      images.map(({ name, data }) => {
        if (!mainState.activeAccount)
          throw Error("Your session ended. Sign in again to continue.");
        const attachment = storeAttachment(
          path.join(mainState.store.root, "attachments"),
          name,
          data,
          policy(),
          true,
        );
        selectedAttachments.set(attachment.id, attachment);
        return attachment;
      }),
  });
  if (action) void mainState.quickEntry.dictation(action);
  else void mainState.quickEntry.toggle();
}
