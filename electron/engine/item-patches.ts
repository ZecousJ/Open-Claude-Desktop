import type { Item } from "../../shared/types";

import type { ItemPatch } from "./engine-extensions";

export class PendingItemPatches {
  private entries = new Map<string, ItemPatch[]>();
  private count = 0;
  constructor(private limit = 512) {}
  private key(threadId: string, itemId: string) {
    return JSON.stringify([threadId, itemId]);
  }
  get size() {
    return this.count;
  }
  hold(threadId: string, itemId: string, patch: ItemPatch) {
    while (this.count >= this.limit) {
      const [oldest, patches] = this.entries.entries().next().value!;
      patches.shift();
      this.count--;
      if (!patches.length) this.entries.delete(oldest);
    }
    const key = this.key(threadId, itemId);
    const patches = this.entries.get(key) ?? [];
    patches.push(patch);
    this.entries.set(key, patches);
    this.count++;
  }
  /**
   * Applies the patches held for an item that just arrived or changed.
   * Patches that do not fit the item yet stay until it completes.
   */
  apply(threadId: string, item: Item, completed: boolean) {
    const key = this.key(threadId, item.id);
    const patches = this.entries.get(key);
    if (!patches) return false;
    let changed = false;
    const waiting: ItemPatch[] = [];
    for (const patch of patches) {
      if (applyItemPatch(item, patch)) changed = true;
      else if (
        !completed &&
        patch.types.includes(item.type) &&
        patch.accepts &&
        !patch.accepts(item)
      )
        waiting.push(patch);
    }
    this.count -= patches.length - waiting.length;
    if (waiting.length) this.entries.set(key, waiting);
    else this.entries.delete(key);
    return changed;
  }
  clear() {
    this.entries.clear();
    this.count = 0;
  }
}

/** Applies a patch to an item; true when the item took it. */
export function applyItemPatch(item: Item, patch: ItemPatch): boolean {
  if (!patch.types.includes(item.type)) return false;
  if (patch.accepts && !patch.accepts(item)) return false;
  let changed = false;
  for (const [key, value] of Object.entries(patch.fields)) {
    if (value === undefined) continue;
    if (!patch.overwrite && item[key] !== undefined) continue;
    item[key] = value;
    changed = true;
  }
  return changed || !!patch.overwrite;
}
