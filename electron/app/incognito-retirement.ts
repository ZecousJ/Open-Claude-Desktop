/** Cleanup of still-owned temporary chats after their captured engine stops. */
import type { Attachment, Conversation } from "../../shared/types";
import type { Store } from "../store/store";
import { discardIncognitoAttachments } from "../workspace/incognito-attachments";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import { discardIncognitoUploads } from "../workspace/incognito-upload";

type RegistryCleanup = (
  conversation: Conversation,
  remaining: Conversation[],
) => void;
// The native adapter's sessionIdentity is the Store object. Its callback carries
// the exact loaded account scope, including pending registry writes. No disk
// scan, path inference, persisted ownership marker or fallback scope is used.
const registries = new WeakMap<object, RegistryCleanup>();
export function registerIncognitoRegistryCleanup(
  identity: unknown,
  cleanup: RegistryCleanup,
) {
  if (typeof identity === "object" && identity !== null)
    registries.set(identity, cleanup);
}

export interface IncognitoRetirementOptions {
  store: Store | undefined;
  engine: object | undefined;
  selected: Map<string, Attachment>;
  feedback: { deleteConversation(id: string): void } | undefined;
  stop(): void | Promise<void>;
  current(store: Store | undefined, engine: object | undefined): boolean;
}

/** One bounded shutdown/retirement attempt. Cancellation never starts cleanup. */
export function createIncognitoRetirement(options: IncognitoRetirementOptions) {
  const { store, engine, selected, feedback } = options;
  let allowed = true,
    confirmed = false;
  const check = () => {
    if (!allowed || !options.current(store, engine))
      throw Error("The account cleanup was superseded.");
  };
  return {
    get confirmed() {
      return confirmed;
    },
    cancel() {
      allowed = false;
    },
    async run() {
      check();
      await options.stop();
      check();
      if (!store) {
        confirmed = true;
        return;
      }
      const temporary = store.conversations.filter(
        (conversation) => conversation.incognito,
      );
      if (
        temporary.some((conversation) =>
          conversation.turns.some((turn) => turn.status === "inProgress"),
        )
      )
        throw Error("A temporary conversation is still running.");
      for (const conversation of temporary) {
        check();
        const remaining = store.conversations.filter(
          (other) => other !== conversation,
        );
        discardIncognitoAttachments(
          store.root,
          conversation,
          store.conversations,
          selected,
        );
        registries.get(store)?.(conversation, remaining);
        feedback?.deleteConversation(conversation.id);
        coworkFolderGrants(store.root).forgetConversation(conversation.id);
        // Retain the in-memory owner until every cleanup operation succeeds.
        // A failed file/registry write can then be retried without guessing.
        store.conversations = remaining;
      }
      discardIncognitoUploads(store.root, selected);
      confirmed = true;
    },
  };
}
