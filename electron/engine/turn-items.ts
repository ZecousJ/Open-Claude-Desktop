import { createHash } from "node:crypto";
import type { Item, Turn } from "../../shared/types";

export function pendingPromptKey(parentThreadId: string, callId: string) {
  return JSON.stringify([parentThreadId, callId]);
}

/** Finds a streamed item, creating it when a delta arrives before item/started. */
export function streamedItem(turn: Turn, id: string, create: () => Item): Item {
  let item = turn.items.find((value) => value.id === id);
  if (!item) {
    item = create();
    turn.items.push(item);
  }
  return item;
}

export function replaceOrAppend(turn: Turn, item: Item) {
  const index = turn.items.findIndex((value) => value.id === item.id);
  if (index < 0) turn.items.push(item);
  else turn.items[index] = item;
}

/** The SHA-256 (hex) the gateway uses to name a message's text. */
export function textHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
