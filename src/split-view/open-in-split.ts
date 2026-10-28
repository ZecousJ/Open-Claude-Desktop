import type { Conversation } from "../../shared/types";
import type { AppController } from "../app/AppContext";
import { openInSplit } from "./split-actions";
import { focusPaneComposer } from "./split-dom";

/** Said when a session cannot be opened in split view: every cell is taken by an empty pane. */
export const noPaneRoomNotice = "There's no room for another pane.";

/**
 * Open in ▸ Split view (a sidebar row's menu, Alt-click on a row): the Code
 * session opens in a pane beside the one on screen, or the pane that shows it
 * takes the focus. The split view lives on the window's Code page, so the
 * window goes there first.
 */
export function openInSplitView(
  app: Pick<
    AppController,
    "activeId" | "page" | "mode" | "setPage" | "setMode" | "notify"
  >,
  conversation: Conversation,
) {
  if (conversation.mode !== "code") return;
  if (app.mode !== "code") app.setMode("code");
  if (app.page !== "chat") app.setPage("chat");
  const focus = openInSplit(conversation.id, app.activeId);
  if (focus === null) app.notify(noPaneRoomNotice);
  else focusPaneComposer(focus);
}
