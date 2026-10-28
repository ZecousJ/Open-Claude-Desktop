import { useSyncExternalStore } from "react";
import type {
  Attachment,
  Conversation,
  DesktopAPI,
  Mode,
} from "../../shared/types";
import { isSteeredMessage } from "../../shared/agent-api";
import { workspaceTrustMessage } from "../../shared/workspace-trust-api";
import {
  trustDeclined,
  withWorkspaceTrust,
} from "../workspace-trust/trust-request";

/**
 * Messages written while a conversation's turn runs. The composer first hands
 * one to the running turn (`turn/steer`, "steered"); when no turn can take it,
 * or the turn ends before the model read it, it waits here ("queued") and is
 * sent as the next message once the turn has finished. The queue lives for the
 * window's lifetime, per account and conversation, so switching conversations
 * keeps it.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Draft UI metadata only; actual send and steer carry the `$name` text. */
  skillTokens?: import("./skill-tokens").SkillToken[];
  attachments: Attachment[];
  state: "queued" | "steered";
  /** The steered item's `clientId`, once the running turn took the message. */
  messageId?: string;
  /** Why sending it failed; it stays queued until edited or removed. */
  error?: string;
  /** A send/steer request is in flight; its identity cannot be edited or withdrawn. */
  steering?: boolean;
  /** What the message is sent with. */
  mode: Mode;
  providerId: string;
  model: string;
  effort?: Conversation["effort"];
  webSearch: boolean;
}

export const conversationRunning = (conversation: Conversation) =>
  conversation.turns.some((turn) => turn.status === "inProgress");

function deliveredMessages(conversation: Conversation) {
  const delivered = new Set<string>();
  for (const turn of conversation.turns)
    for (const item of turn.items)
      if (isSteeredMessage(item)) delivered.add(item.clientId);
  return delivered;
}

/**
 * Brings the conversation's queue up to date: a steered message the turn
 * recorded (an item with its `clientId`) has been delivered and leaves the
 * queue; one the turn ended without reading is queued again.
 */
export function reconcileQueue(
  entries: QueuedMessage[],
  conversation: Conversation,
): QueuedMessage[] {
  const delivered = deliveredMessages(conversation);
  const running = conversationRunning(conversation);
  const next = entries.flatMap((entry): QueuedMessage[] => {
    if (entry.state !== "steered") return [entry];
    if (entry.messageId && delivered.has(entry.messageId)) return [];
    return running ? [entry] : [{ ...entry, state: "queued" }];
  });
  const same =
    next.length === entries.length &&
    next.every((entry, index) => entry === entries[index]);
  return same ? entries : next;
}

/** The queued message to send now: only once the conversation is idle. */
export function nextQueued(
  entries: QueuedMessage[],
  conversation: Conversation,
) {
  if (conversationRunning(conversation)) return undefined;
  if (entries.some((entry) => entry.state === "steered" || entry.steering))
    return undefined;
  // A message that failed holds the ones after it, which keep their order.
  const first = entries.find((entry) => entry.state === "queued");
  return first && !first.error ? first : undefined;
}

type Listener = () => void;
type QueueAccount = { id: string; active: boolean };
type QueueBridge = DesktopAPI | undefined;
const currentBridge = (): QueueBridge =>
  typeof window === "undefined" ? undefined : window.desktop;
let account: QueueAccount | undefined;
const queues = new Map<string, QueuedMessage[]>();
const listeners = new Set<Listener>();
const sending = new Set<string>();
type PendingSteerBatch = {
  account: QueueAccount | undefined;
  bridge: QueueBridge;
  count: number;
  latest?: { conversation: Conversation; send: Sender; entries: Set<string> };
};
/** Only lives while steer RPCs are pending; the final settlement deletes it. */
const pendingSteers = new Map<string, PendingSteerBatch>();
const empty: QueuedMessage[] = [];
let counter = 0;

const queueKey = (scope: QueueAccount | undefined, conversationId: string) =>
  JSON.stringify([scope?.id ?? null, conversationId]);
const scopeCurrent = (scope: QueueAccount | undefined, bridge: QueueBridge) =>
  account === scope && (!scope || scope.active) && currentBridge() === bridge;
const entriesFor = (scope: QueueAccount | undefined, conversationId: string) =>
  queues.get(queueKey(scope, conversationId)) ?? empty;

/** App owns the signed-in account lifetime; navigation keeps its queues. */
export function activateQueuedAccount(id: string) {
  if (account) account.active = false;
  stopWatching();
  const scope: QueueAccount = { id, active: true };
  account = scope;
  listeners.forEach((listener) => listener());
  return () => {
    scope.active = false;
    if (watching?.account === scope) stopWatching();
    if (account === scope) {
      account = undefined;
      listeners.forEach((listener) => listener());
    }
  };
}

/** Equal-millisecond events still have the real turn history to order them. */
function freshestConversation(previous: Conversation, incoming: Conversation) {
  if (previous.updatedAt !== incoming.updatedAt)
    return incoming.updatedAt > previous.updatedAt ? incoming : previous;
  const before = previous.turns.at(-1);
  const after = incoming.turns.at(-1);
  if (!before) return incoming;
  if (!after) return previous;
  if (before.id === after.id)
    return before.status !== "inProgress" && after.status === "inProgress"
      ? previous
      : incoming;
  if (incoming.turns.some((turn) => turn.id === before.id)) return incoming;
  if (previous.turns.some((turn) => turn.id === after.id)) return previous;
  // Renamed provisional turns or an explicit history replacement have no
  // ordering relationship in their opaque IDs; retain their arrival order.
  return incoming;
}

function rememberPendingConversation(
  pending: PendingSteerBatch,
  conversation: Conversation,
  send: Sender,
  entries = new Set(
    entriesFor(pending.account, conversation.id).map((entry) => entry.id),
  ),
) {
  if (
    pending.latest &&
    freshestConversation(pending.latest.conversation, conversation) !==
      conversation
  )
    return;
  pending.latest = { conversation, send, entries };
}

function setFor(
  scope: QueueAccount | undefined,
  conversationId: string,
  entries: QueuedMessage[],
) {
  const key = queueKey(scope, conversationId);
  if (entries.length) queues.set(key, entries);
  else queues.delete(key);
  listeners.forEach((listener) => listener());
}

function set(conversationId: string, entries: QueuedMessage[]) {
  setFor(account, conversationId, entries);
}

export function queuedMessages(conversationId: string | undefined) {
  return (conversationId && entriesFor(account, conversationId)) || empty;
}

export function useQueuedMessages(conversationId: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => queuedMessages(conversationId),
    () => queuedMessages(conversationId),
  );
}

export function addQueued(
  conversationId: string,
  entry: Omit<QueuedMessage, "id">,
) {
  const added = { ...entry, id: `queued-${++counter}` };
  set(conversationId, [...queuedMessages(conversationId), added]);
  return added;
}

/** Changes one queued entry (its state after "Send now", or its error). */
export function updateQueued(
  conversationId: string,
  id: string,
  patch: Partial<QueuedMessage>,
) {
  updateFor(account, conversationId, id, patch);
}

function updateFor(
  scope: QueueAccount | undefined,
  conversationId: string,
  id: string,
  patch: Partial<QueuedMessage>,
) {
  setFor(
    scope,
    conversationId,
    entriesFor(scope, conversationId).map((entry) =>
      entry.id === id ? { ...entry, ...patch } : entry,
    ),
  );
}

export function removeQueued(conversationId: string, id: string) {
  removeFor(account, conversationId, id);
}

function removeFor(
  scope: QueueAccount | undefined,
  conversationId: string,
  id: string,
) {
  setFor(
    scope,
    conversationId,
    entriesFor(scope, conversationId).filter((entry) => entry.id !== id),
  );
}

/** A user Edit/Remove rechecks the current entry, including retained UI callbacks. */
export function takeEditableQueued(conversationId: string, id: string) {
  const entry = queuedMessages(conversationId).find((item) => item.id === id);
  if (!entry || entry.state !== "queued" || entry.steering) return;
  removeQueued(conversationId, id);
  return entry;
}

/**
 * Puts a waiting message at another place among the waiting ones (dragged in
 * the transcript): `beforeId` is the waiting message it now precedes, or
 * none for the end. Messages the running turn already took keep their
 * places; the waiting ones are sent in their new order.
 */
export function moveQueued(
  conversationId: string,
  id: string,
  beforeId: string | undefined,
) {
  const entries = queuedMessages(conversationId);
  const waiting = entries.filter((entry) => entry.state === "queued");
  const moved = waiting.find((entry) => entry.id === id);
  if (!moved || id === beforeId) return;
  const order = waiting.filter((entry) => entry !== moved);
  const at = order.findIndex((entry) => entry.id === beforeId);
  order.splice(at < 0 ? order.length : at, 0, moved);
  if (order.every((entry, index) => entry === waiting[index])) return;
  let next = 0;
  set(
    conversationId,
    entries.map((entry) => (entry.state === "queued" ? order[next++] : entry)),
  );
}

/**
 * Takes every waiting message out of the queue ("Clear all"); messages the
 * running turn already took stay until it reads them.
 */
export function clearQueued(conversationId: string) {
  set(
    conversationId,
    queuedMessages(conversationId).filter(
      (entry) => entry.state !== "queued" || entry.steering,
    ),
  );
}

/**
 * A queued message on one line, as the queued-message bar previews it: its
 * text, then each attached file as `@name` and each image as "[Image]", runs of
 * white space as one space, and "…" when nothing is left.
 */
export function queuedPreview(
  entry: Pick<QueuedMessage, "text" | "attachments">,
  imageLabel = "[Image]",
) {
  const parts = [entry.text];
  for (const file of entry.attachments)
    parts.push(file.kind === "image" ? imageLabel : `@${file.name}`);
  return parts.join(" ").replace(/\s+/g, " ").trim() || "…";
}

/**
 * How "Send now" went: the running turn took the message ("steered"), it
 * could not take one right now so the message stays queued ("held"), or the
 * conversation was idle and the message went out as the next one ("sent").
 */
export type SendNowResult = "steered" | "held" | "sent" | "gone";

/**
 * "Send now" on a waiting message. While the turn runs the message is handed
 * to it (`turn/steer`) and the model reads it at its next step; the entry
 * spins meanwhile. When the conversation is idle (a message whose sending
 * failed holds the queue), the message moves to the front and is sent as
 * the next message at once. Errors from the service are thrown; the entry
 * stays queued.
 */
export async function sendQueuedNow(
  conversation: Conversation,
  id: string,
  upsert: (conversation: Conversation) => void,
  send: Sender = sendQueued,
): Promise<SendNowResult> {
  const conversationId = conversation.id;
  const scope = account;
  const bridge = currentBridge();
  const key = queueKey(scope, conversationId);
  const entries = () => entriesFor(scope, conversationId);
  const entry = entries().find((item) => item.id === id);
  if (!entry || entry.state !== "queued" || entry.steering) return "gone";
  if (!scopeCurrent(scope, bridge)) return "gone";
  if (!conversationRunning(conversation)) {
    const first = entries().find((item) => item.state === "queued");
    if (first && first.id !== id) moveQueued(conversationId, id, first.id);
    updateFor(scope, conversationId, id, { error: undefined });
    await conversationChangedFor(scope, bridge, conversation, send);
    if (!scopeCurrent(scope, bridge)) return "gone";
    return entries().some((item) => item.id === id) ? "held" : "sent";
  }
  let pending = pendingSteers.get(key);
  if (pending?.account !== scope || pending?.bridge !== bridge)
    pending = undefined;
  if (!pending)
    pendingSteers.set(key, (pending = { account: scope, bridge, count: 0 }));
  pending.count++;
  rememberPendingConversation(pending, conversation, send);
  updateFor(scope, conversationId, id, { steering: true, error: undefined });
  let outcome: SendNowResult = "held";
  let rejected = false;
  let failure: unknown;
  let sentAfterSteer = false;
  try {
    if (!scopeCurrent(scope, bridge) || !bridge) {
      updateFor(scope, conversationId, id, { steering: undefined });
      return "gone";
    }
    const steered = await bridge.steerTurn(
      conversationId,
      entry.text,
      entry.attachments.map((file) => file.id),
    );
    if (!steered) {
      updateFor(scope, conversationId, id, { steering: undefined });
    } else {
      // The message can be consumed before the RPC answers (Engine.recordSteer).
      // This proof remains valid even if an earlier completion event lacked it.
      if (deliveredMessages(steered.conversation).has(steered.messageId))
        removeFor(scope, conversationId, id);
      else
        updateFor(scope, conversationId, id, {
          state: "steered",
          steering: undefined,
          messageId: steered.messageId,
        });
      // The RPC can settle after a newer turn's event. Its read proof above
      // is useful, but its older snapshot must not replace that live turn.
      rememberPendingConversation(
        pending,
        steered.conversation,
        send,
        pending.latest?.entries,
      );
      if (scopeCurrent(scope, bridge))
        upsert(pending.latest?.conversation ?? steered.conversation);
      outcome = "steered";
    }
  } catch (error) {
    updateFor(scope, conversationId, id, { steering: undefined });
    rejected = true;
    failure = error;
  } finally {
    if (!scopeCurrent(scope, bridge))
      updateFor(scope, conversationId, id, { steering: undefined });
    pending.count--;
    if (!pending.count && pendingSteers.get(key) === pending) {
      pendingSteers.delete(key);
      const latest = pending.latest;
      // A cleared queue must not resurrect an old request or consume a new
      // generation of messages added after its last observed event.
      if (
        scopeCurrent(scope, bridge) &&
        latest &&
        entries().some((entry) => latest.entries.has(entry.id))
      )
        await conversationChangedFor(
          scope,
          bridge,
          latest.conversation,
          async (entry, targetId, target) => {
            await latest.send(entry, targetId, target);
            if (entry.id === id) sentAfterSteer = true;
          },
        );
    }
  }
  if (!scopeCurrent(scope, bridge)) return "gone";
  if (sentAfterSteer) return "sent";
  if (rejected) {
    if (!entries().some((entry) => entry.id === id)) return "gone";
    throw failure;
  }
  return outcome;
}

type Sender = (
  entry: QueuedMessage,
  conversationId: string,
  conversation?: Conversation,
) => Promise<void>;

/**
 * Where a failed send of a queued Code message is told: the Code bar has no
 * place for an error under the message, so the window shows it as a notice
 * (the queue then waits on that message until it is sent, edited or
 * removed). Chat and Cowork show the error under their queued bubble.
 */
let reportSendError: ((message: string) => void) | undefined;

/**
 * Reconciles the conversation's queue with its latest state and, when the
 * conversation is idle, sends the next queued message with `send`.
 */
export async function conversationChanged(
  conversation: Conversation,
  send: Sender,
) {
  return conversationChangedFor(account, currentBridge(), conversation, send);
}

async function conversationChangedFor(
  scope: QueueAccount | undefined,
  bridge: QueueBridge,
  conversation: Conversation,
  send: Sender,
) {
  if (!scopeCurrent(scope, bridge)) return;
  const key = queueKey(scope, conversation.id);
  const current = entriesFor(scope, conversation.id);
  if (!current.length) return;
  const pending = pendingSteers.get(key);
  if (pending && pending.account === scope && pending.bridge === bridge) {
    rememberPendingConversation(pending, conversation, send);
    return;
  }
  const entries = reconcileQueue(current, conversation);
  if (entries !== current) setFor(scope, conversation.id, entries);
  const next = nextQueued(entries, conversation);
  if (!next || sending.has(key)) return;
  sending.add(key);
  updateFor(scope, conversation.id, next.id, { steering: true });
  try {
    if (!scopeCurrent(scope, bridge)) return;
    if (send === sendQueued)
      await sendQueuedFor(scope, bridge, next, conversation.id, conversation);
    else await send(next, conversation.id, conversation);
    removeFor(scope, conversation.id, next.id);
  } catch (error) {
    if (!scopeCurrent(scope, bridge)) return;
    const message = error instanceof Error ? error.message : String(error);
    setFor(
      scope,
      conversation.id,
      entriesFor(scope, conversation.id).map((entry) =>
        entry.id === next.id
          ? { ...entry, steering: undefined, error: message }
          : entry,
      ),
    );
    if (next.mode === "code" && scopeCurrent(scope, bridge))
      reportSendError?.(message);
  } finally {
    if (!scopeCurrent(scope, bridge))
      updateFor(scope, conversation.id, next.id, { steering: undefined });
    sending.delete(key);
  }
}

/**
 * Sends a queued message as the conversation's next message. A Code
 * workspace no longer trusted asks "Trust this workspace?" and sends again
 * once trusted; Cancel leaves the message queued with the refusal.
 */
export const sendQueued: Sender = async (
  entry,
  conversationId,
  conversation,
) => {
  return sendQueuedFor(
    account,
    currentBridge(),
    entry,
    conversationId,
    conversation,
  );
};

async function sendQueuedFor(
  scope: QueueAccount | undefined,
  bridge: QueueBridge,
  entry: QueuedMessage,
  conversationId: string,
  conversation?: Conversation,
) {
  const assertCurrent = () => {
    if (!scopeCurrent(scope, bridge) || !bridge) throw expiredQueueScope;
    return bridge;
  };
  const send = async () => {
    let blankLease:
      | import("../artifacts/blank-artifact-flush").BlankArtifactSendLease
      | undefined;
    try {
      if (conversation?.blankArtifact) {
        const { prepareScopedBlankEditors } =
          await import("../artifacts/blank-artifact-flush");
        blankLease = await prepareScopedBlankEditors({
          account: scope?.id,
          bridge: assertCurrent(),
          conversationId,
          artifactId: conversation.blankArtifact.id,
          current: () => scopeCurrent(scope, bridge),
        });
        assertCurrent();
        if (!blankLease.saved)
          throw new Error(
            "Save the artifact changes before sending this message.",
          );
      }
      return await assertCurrent().send({
        conversationId,
        ...(blankLease?.expected
          ? { blankArtifactRevision: blankLease.expected }
          : {}),
        text: entry.text,
        mode: entry.mode,
        webSearch: entry.webSearch,
        attachments: entry.attachments,
        providerId: entry.providerId,
        model: entry.model,
        effort: entry.effort,
      });
    } finally {
      blankLease?.release();
    }
  };
  const sent = await withWorkspaceTrust(send, conversation, {
    // The web has no trust check (its runner trusts its sandboxes).
    api:
      typeof bridge?.checkWorkspaceTrust === "function"
        ? {
            checkWorkspaceTrust: (...args) =>
              assertCurrent().checkWorkspaceTrust(...args),
            saveWorkspaceTrust: (...args) =>
              assertCurrent().saveWorkspaceTrust(...args),
          }
        : undefined,
    notify: (message) => {
      if (scopeCurrent(scope, bridge)) reportSendError?.(message);
    },
  });
  if (sent === trustDeclined) throw new Error(workspaceTrustMessage);
}

const expiredQueueScope = Symbol("expired queue account");

let watching:
  | { account: QueueAccount | undefined; bridge: QueueBridge; stop: () => void }
  | undefined;
function stopWatching() {
  const previous = watching;
  watching = undefined;
  previous?.stop();
  reportSendError = undefined;
}
/**
 * Follows conversation events once per window, so a queue drains even when
 * its conversation is not open. `onSendError` hears why a queued Code
 * message could not be sent.
 */
export function watchQueuedMessages(onSendError?: (message: string) => void) {
  const scope = account;
  const bridge = currentBridge();
  if (watching?.account !== scope || watching?.bridge !== bridge)
    stopWatching();
  if (onSendError) reportSendError = onSendError;
  if (watching || !bridge?.onEvent || !scopeCurrent(scope, bridge)) return;
  const stop = bridge.onEvent((event) => {
    if (event.type === "conversation")
      void conversationChangedFor(
        scope,
        bridge,
        event.conversation,
        sendQueued,
      );
  });
  watching = { account: scope, bridge, stop };
}
