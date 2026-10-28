import { useContext } from "react";
import { AppContext } from "../app/AppContext";
import { ReconnectBanner } from "../ssh/ReconnectBanner";

/**
 * A conversation on an SSH host shows its connection above the composer while
 * the host is not connected (R9, src/ssh/ReconnectBanner.tsx).
 *
 * Queued messages show in the composer's dock: Code's QueuedMessageBar.tsx,
 * Chat and Cowork's ChatQueuedMessages.tsx, which replaced the transcript
 * bubbles that used to live here.
 */
export function HostBanner({
  conversationId,
}: {
  conversationId: string | undefined;
}) {
  const app = useContext(AppContext);
  const conversation =
    app?.active?.id === conversationId ? app?.active : undefined;
  return conversation?.environment?.kind === "ssh" ? (
    <ReconnectBanner environment={conversation.environment} />
  ) : null;
}
