import type { BrowserWindow } from "electron";
import { conversationListsChanged } from "../../../shared/conversation-list-updates";
import type { AdapterContext } from "../api/context";

export const conversationListUpdateChannel = "claudex:conversation-lists-invalidated";

/** Refresh only this window's current account lists. */
export function observeConversationListUpdates(
  window: BrowserWindow,
  ctx: Pick<AdapterContext, "onEvent">,
  current: () => boolean,
) {
  const listsChanged = conversationListsChanged();
  return ctx.onEvent((event) => {
    if (current() && listsChanged(event))
      window.webContents.send(conversationListUpdateChannel);
  });
}
