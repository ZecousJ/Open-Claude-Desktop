import { useEffect, useRef } from "react";
import { t } from "../i18n";

/** What a screen reader hears when a reply starts and when it ends. */
export function responseAnnouncement(streaming: boolean, userStopped: boolean) {
  return streaming
    ? "Claudex is responding"
    : userStopped
      ? "Claudex’s response was interrupted."
      : "Claudex finished the response";
}

/**
 * A hidden status line that tells screen readers a reply started and that it
 * finished or was interrupted. It says nothing on arrival or when another
 * conversation opens, only when streaming changes.
 */
export function ResponseStatusAnnouncer({
  conversationId,
  streaming,
  userStopped,
}: {
  conversationId: string;
  streaming: boolean;
  userStopped: boolean;
}) {
  const node = useRef<HTMLDivElement>(null);
  const last = useRef(false);
  const shown = useRef(conversationId);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    let previous = last.current;
    last.current = streaming;
    if (shown.current !== conversationId) {
      shown.current = conversationId;
      previous = false;
      element.textContent = "";
    }
    if (streaming !== previous)
      element.textContent = t(responseAnnouncement(streaming, userStopped));
  }, [streaming, conversationId, userStopped]);
  return (
    <div
      ref={node}
      role="status"
      className="sr-only"
      data-no-translate=""
      data-testid="response-status-announcer"
    />
  );
}
