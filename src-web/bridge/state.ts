/**
 * What the bridge remembers between calls: the policy (for decisions that
 * must happen during the click that asked, such as opening a tab or the
 * file picker), the conversations the window was sent (Markdown export),
 * and a snapshot the event stream pushed after a long disconnection.
 */
import type { ClientPolicy } from "../../shared/client-policy";
import { webHost } from "../../shared/host";
import type { AppEvent, Conversation, Snapshot } from "../../shared/types";
import { mergeConversationTurn } from "../../src/host/events";

/**
 * The operating system as `Snapshot.platform` names it, so shortcuts read
 * ⌘ on a Mac and Ctrl elsewhere. The runner reports its own host's.
 */
export function platformFromHint(hint: string): "darwin" | "win32" | "linux" {
  if (/mac|iphone|ipad|ipod|darwin/i.test(hint)) return "darwin";
  if (/win/i.test(hint)) return "win32";
  return "linux";
}

/** The window's snapshot as the web shows it (this browser's platform, web host). */
export function webSnapshot(
  snapshot: Snapshot,
  platformHint: string,
): Snapshot {
  return {
    ...snapshot,
    platform: platformFromHint(platformHint),
    host: snapshot.host?.kind === "web" ? snapshot.host : webHost,
  };
}

/** How long a pushed snapshot answers the window's next `snapshot()`. */
const pushedSnapshotMs = 15_000;

export class BridgeState {
  private policy?: ClientPolicy;
  private conversations = new Map<string, Conversation>();
  private pushed?: { snapshot: Snapshot; at: number };
  /** The window has read a snapshot since the session began. */
  snapshotLoaded = false;
  /** The last event number that snapshot holds, when Go said it. */
  snapshotSeq?: number;

  constructor(private now: () => number) {}

  get cachedPolicy() {
    return this.policy;
  }
  set cachedPolicy(policy: ClientPolicy | undefined) {
    this.policy = policy;
  }

  conversation(id: string) {
    return this.conversations.get(id);
  }

  loaded(snapshot: Snapshot, eventSeq?: number) {
    this.snapshotLoaded = true;
    this.snapshotSeq = eventSeq;
    this.conversations = new Map(snapshot.conversations.map((c) => [c.id, c]));
  }

  push(snapshot: Snapshot) {
    this.pushed = { snapshot, at: this.now() };
  }

  /** The pushed snapshot, once, while it is fresh. */
  takePushed(): Snapshot | undefined {
    const pushed = this.pushed;
    this.pushed = undefined;
    return pushed && this.now() - pushed.at < pushedSnapshotMs
      ? pushed.snapshot
      : undefined;
  }

  observe(event: AppEvent) {
    switch (event.type) {
      case "conversation":
        this.conversations.set(event.conversation.id, event.conversation);
        break;
      case "conversation-turn": {
        const merged = mergeConversationTurn(
          this.conversations.get(event.conversationId),
          event,
        );
        if (merged) this.conversations.set(merged.id, merged);
        break;
      }
      case "policy":
        this.policy = event.policy;
        break;
      case "service-changed":
        this.policy = undefined;
        break;
    }
  }

  forget(conversationId: string) {
    this.conversations.delete(conversationId);
  }

  clear() {
    this.policy = undefined;
    this.conversations.clear();
    this.pushed = undefined;
    this.snapshotLoaded = false;
    this.snapshotSeq = undefined;
  }
}
