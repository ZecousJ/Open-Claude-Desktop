import { Suspense, useState } from "react";
import type { Conversation } from "../../shared/types";
import { lazyPiece } from "../ui/lazy-piece";
import { useQueuedMessages } from "./queue";

/** The list and its styles load with the first queued Chat or Cowork message. */
const ChatQueuedMessagesHost = lazyPiece(() => import("./ChatQueuedMessages"));

/**
 * Where the open Chat or Cowork conversation's queued messages show: in the
 * composer's dock, above the composer. The list stays mounted until its last
 * message has faded out.
 */
export function ChatQueuedSlot({
  conversation,
}: {
  conversation: Conversation;
}) {
  const entries = useQueuedMessages(conversation.id);
  const [shown, setShown] = useState<string>();
  if (entries.length && shown !== conversation.id) setShown(conversation.id);
  if (!entries.length && shown !== conversation.id) return null;
  return (
    <Suspense fallback={null}>
      <ChatQueuedMessagesHost
        key={conversation.id}
        conversation={conversation}
        entries={entries}
        onEmpty={() => setShown(undefined)}
      />
    </Suspense>
  );
}
