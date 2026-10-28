import { Suspense, useEffect, useState } from "react";
import type { Conversation } from "../../shared/types";
import { prefersReducedMotion } from "../ui/usePresence";
import { useQueuedMessages, type QueuedMessage } from "./queue";
import { lazyPiece } from "../ui/lazy-piece";

/** The bar and its styles load with the first queued Code message. */
const QueuedMessageBarHost = lazyPiece(() => import("./QueuedMessageBar"));

/** The exit runs 120ms; a bar whose animation never ends goes after this. */
const EXIT_FALLBACK_MS = 400;

/**
 * Where the open Code conversation's queued messages show, above the composer.
 * When the last one leaves, the bar keeps it while it sinks out.
 */
export function QueuedBarSlot({
  conversation,
}: {
  conversation: Conversation;
}) {
  const entries = useQueuedMessages(conversation.id);
  const [previous, setPrevious] = useState({ id: conversation.id, entries });
  const [leaving, setLeaving] = useState<{
    id: string;
    entries: QueuedMessage[];
  }>();
  // Worked out while rendering, so the last message never blinks out.
  if (previous.entries !== entries || previous.id !== conversation.id) {
    setPrevious({ id: conversation.id, entries });
    if (
      !entries.length &&
      previous.entries.length &&
      previous.id === conversation.id &&
      !prefersReducedMotion()
    )
      setLeaving({ id: conversation.id, entries: previous.entries });
    else if (leaving) setLeaving(undefined);
  }
  const exiting = !entries.length && leaving?.id === conversation.id;
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(
      () => setLeaving(undefined),
      EXIT_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exiting]);
  const drawn = exiting ? leaving.entries : entries;
  if (!drawn.length) return null;
  return (
    <Suspense fallback={null}>
      <QueuedMessageBarHost
        conversation={conversation}
        entries={drawn}
        exiting={exiting}
        onExited={() => setLeaving(undefined)}
      />
    </Suspense>
  );
}
