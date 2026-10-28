import type { CloudSessionInfo } from "../../shared/host";
import type { AppEvent, Conversation, Snapshot } from "../../shared/types";

type TurnEvent = Extract<AppEvent, { type: "conversation-turn" }>;

/**
 * The conversation a "conversation-turn" event makes: the turn replaces the
 * one with its id (or is added after the last), and the event's other fields
 * go on top. Undefined when the window does not have the conversation; the
 * next full "conversation" event brings it.
 */
export function mergeConversationTurn(
  conversation: Conversation | undefined,
  event: TurnEvent,
): Conversation | undefined {
  if (!conversation || conversation.id !== event.conversationId) return;
  let index = conversation.turns.findIndex((t) => t.id === event.turn.id);
  // A turn the window still knows by its provisional id ("pending-…") is the
  // same turn once Codex names it (turn/start): it is replaced, not doubled.
  if (index < 0) {
    const last = conversation.turns.length - 1;
    if (last >= 0 && conversation.turns[last].id.startsWith("pending-"))
      index = last;
  }
  const turns =
    index < 0
      ? [...conversation.turns, event.turn]
      : conversation.turns.map((t, i) => (i === index ? event.turn : t));
  return {
    ...conversation,
    ...event.conversation,
    id: conversation.id,
    turns,
  };
}

/**
 * Merges turn events that arrive faster than the window renders. The
 * snapshot a render made may not show the previous turn event yet, so each
 * merge remembers which rendered conversation it started from: while that is
 * still what the window shows, the next merge builds on the merge's result;
 * once the window rendered something newer (this merge, or a change of its
 * own such as a rename), it builds on that.
 */
export class ConversationTurns {
  private merged = new Map<
    string,
    { from: Conversation; result: Conversation }
  >();
  apply(
    rendered: Conversation | undefined,
    event: TurnEvent,
  ): Conversation | undefined {
    const last = this.merged.get(event.conversationId);
    const base = last && last.from === rendered ? last.result : rendered;
    const result = mergeConversationTurn(base, event);
    if (!result || !rendered) return result;
    this.merged.set(event.conversationId, { from: rendered, result });
    return result;
  }
  /** A full conversation arrived, or the snapshot was read again. */
  forget(conversationId?: string) {
    if (conversationId === undefined) this.merged.clear();
    else this.merged.delete(conversationId);
  }
}

/** The key a cloud session is stored under: its conversation, or "" for the shared sandbox. */
const sessionKey = (session: CloudSessionInfo) => session.conversationId ?? "";

/**
 * The account's cloud sessions after one changed. An archived sandbox is
 * gone and leaves the list.
 */
export function applyCloudSession(
  sessions: readonly CloudSessionInfo[] | undefined,
  session: CloudSessionInfo,
): CloudSessionInfo[] {
  const rest = (sessions ?? []).filter(
    (s) => sessionKey(s) !== sessionKey(session),
  );
  return session.state === "archived" ? rest : [...rest, session];
}

/**
 * What the window shows after the event stream reconnected: the fresh
 * snapshot, keeping the incognito chat the window has open (the first load
 * drops incognito chats; a reconnect must not end the one on screen).
 *
 * `arrived` are conversations whose events came in while the snapshot was
 * being read. They go on top of it: the snapshot may have been taken before
 * those changes (the last event of a reply would otherwise be lost until the
 * conversation changes again), and a change it already had is sent again as
 * a later event.
 */
export function resyncSnapshot(
  current: Snapshot | undefined,
  fresh: Snapshot,
  arrived: readonly Conversation[] = [],
): Snapshot {
  const shown = new Set(
    (current?.conversations ?? []).filter((c) => c.incognito).map((c) => c.id),
  );
  const newer = new Map(arrived.map((c) => [c.id, c]));
  const conversations = fresh.conversations
    .filter((c) => !c.incognito || shown.has(c.id) || newer.has(c.id))
    .map((c) => newer.get(c.id) ?? c);
  const known = new Set(conversations.map((c) => c.id));
  return {
    ...fresh,
    conversations: [
      ...arrived.filter((c) => !known.has(c.id)),
      ...conversations,
    ],
  };
}
