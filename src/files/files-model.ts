import { type Conversation } from "../../shared/types";
import { surface } from "../../shared/host";

/**
 * The Files pane can open: a local Code session in the desktop app, or a cloud
 * session (its space), whose folder the runner reads.
 */
export function filesPaneAvailable(conversation: Conversation | undefined) {
  const kind = conversation?.environment?.kind ?? "local";
  return (
    !!conversation &&
    conversation.mode === "code" &&
    (kind === "space" || (kind === "local" && surface !== "web")) &&
    typeof window !== "undefined" &&
    !!window.desktop?.listProjectFolder
  );
}
