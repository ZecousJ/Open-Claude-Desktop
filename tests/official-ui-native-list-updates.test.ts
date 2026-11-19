import assert from "node:assert/strict";
import test from "node:test";
import { observeConversationListUpdates, conversationListUpdateChannel } from "../electron/official-ui/native/conversation-list-updates";
import type { AppEvent, Conversation } from "../shared/types";

test("native cloud resync reaches its active window and unsubscribes on detach", () => {
  const callbacks = new Set<(event: any) => void>();
  const sent: unknown[][] = [];
  let current = true;
  const stop = observeConversationListUpdates({ webContents: { send: (...args: unknown[]) => sent.push(args) } } as never,
    { onEvent(callback) { callbacks.add(callback); return () => { callbacks.delete(callback); }; } }, () => current);
  const emit = (type: string) => { for (const callback of callbacks) callback({ type }); };
  emit("conversation-turn"); assert.equal(sent.length, 0);
  emit("resync"); assert.deepEqual(sent, [[conversationListUpdateChannel]]);
  current = false; emit("resync"); assert.equal(sent.length, 1);
  stop(); assert.equal(callbacks.size, 0);
});

test("native metadata signals each current window and detaching removes its observer", () => {
  const listeners = new Set<(event: AppEvent) => void>();
  const ctx = {
    onEvent(listener: (event: AppEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const sent: string[] = [];
  const window = (id: string) => ({
    webContents: { send: (channel: string) => sent.push(`${id}:${channel}`) },
  }) as never;
  let firstCurrent = true;
  const stopFirst = observeConversationListUpdates(window("first"), ctx, () => firstCurrent);
  const stopSecond = observeConversationListUpdates(window("second"), ctx, () => true);
  const chat: Conversation = {
    id: "chat", title: "Before", mode: "chat", model: "fixture", providerId: "fixture",
    createdAt: 1, updatedAt: 1, pinned: false, archived: false, turns: [],
  };
  const emit = (conversation: Conversation) => {
    for (const listener of listeners) listener({ type: "conversation", conversation });
  };
  emit(chat);
  emit(chat);
  firstCurrent = false;
  emit({ ...chat, title: "After" });
  stopFirst();
  stopSecond();
  emit({ ...chat, pinned: true });
  assert.deepEqual(sent, ["first", "second", "second"].map(id => `${id}:${conversationListUpdateChannel}`));
  assert.equal(listeners.size, 0);
});
