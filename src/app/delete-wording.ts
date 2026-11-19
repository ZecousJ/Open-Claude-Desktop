import type { Conversation } from "../../shared/types";
import { formatText } from "../i18n";

/**
 * What the delete confirmation says for each kind of conversation (desktop
 * bundle 2.31226.1): a Code session names itself and says it cannot be
 * undone, a Cowork task asks about "this task" under "Delete task" (no
 * question mark: live claude.ai bundle, 2026-10-12, the task delete
 * dialog), and a chat keeps the live claude.ai wording (2026-09-29).
 */
export function deleteWording(c: Pick<Conversation, "mode" | "title">) {
  if (c.mode === "code")
    return {
      title: "Delete session?",
      body: formatText(
        "“{sessionTitle}” will be permanently deleted. This can’t be undone.",
        { sessionTitle: c.title },
      ),
    };
  if (c.mode === "cowork")
    return {
      title: "Delete task",
      body: "Are you sure you want to delete this task?",
    };
  return {
    title: "Delete chat?",
    body: "Are you sure you want to delete this chat?",
  };
}
