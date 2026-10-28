import { z } from "zod";
import type { Engine } from "../engine/engine";
import type { Store } from "../store/store";
import type { BackgroundTerminalInfo } from "../../shared/types";
import type { BackgroundHistory } from "../conversations/background-history";
import { registryOf } from "../engine/engine-registry";
type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  readonly store: Store;
  readonly engine: Engine;
  /** Keeps ended background terminals for the panel's Finished group. */
  readonly backgroundHistory?: BackgroundHistory;
}
const id = z.string().min(1).max(500);
/**
 * The engine running a conversation now (an SSH host's for an SSH
 * conversation, R9); undefined while that host's engine isn't running.
 */
function engineOf(context: Context, conversationId: string) {
  const registry = registryOf(context.engine);
  return registry ? registry.running(conversationId) : context.engine;
}
/** Codex's list, or `listed: false` when the thread is not loaded. */
async function nativeList(context: Context, conversationId: string) {
  const conversation = context.store.conversation(conversationId);
  const none = {
    conversationId,
    items: [] as BackgroundTerminalInfo[],
    listed: false,
  };
  if (!conversation.threadId) return none;
  const engine = engineOf(context, conversationId);
  // An SSH host's Codex that isn't running has no terminals to list.
  if (
    conversation.environment?.kind === "ssh" &&
    (!engine?.rpc || engine.state.state !== "ready")
  )
    return none;
  if (!engine?.rpc || engine.state.state !== "ready")
    throw Error("Codex is not connected.");
  const loaded = await engine.rpc.call("thread/loaded/list", {});
  if (
    !Array.isArray(loaded?.data) ||
    !loaded.data.includes(conversation.threadId)
  )
    return none;
  const response = await engine.rpc.call("thread/backgroundTerminals/list", {
    threadId: conversation.threadId,
    limit: 50,
  });
  const items: Array<BackgroundTerminalInfo> = Array.isArray(response?.data)
    ? response.data
        .filter(
          (item: any) =>
            typeof item?.processId === "string" &&
            typeof item?.command === "string",
        )
        .map((item: any) => ({
          conversationId,
          itemId: typeof item.itemId === "string" ? item.itemId : "",
          processId: item.processId,
          command: item.command,
          cwd: typeof item.cwd === "string" ? item.cwd : "",
        }))
    : [];
  return { conversationId, items, listed: true };
}
export function registerBackgroundTerminalHandlers(
  handle: Handle,
  context: Context,
) {
  // The terminals each conversation's last real listing showed, so one that
  // is gone from the next listing is kept under Finished as completed.
  const seen = new Map<string, BackgroundTerminalInfo[]>();
  // Terminals being stopped from the panel. A listing that no longer shows
  // one leaves its record to the stop, so it is kept as "stopped" rather than
  // "completed"; `gone` notes that the listing skipped it.
  const stopping = new Map<string, { gone: boolean }>();
  const finish = (
    item: BackgroundTerminalInfo,
    status: "stopped" | "completed",
  ) => {
    try {
      context.backgroundHistory?.recordFinished({
        conversationId: item.conversationId,
        itemId: item.itemId,
        processId: item.processId,
        command: item.command,
        cwd: item.cwd,
        status,
        finishedAt: Date.now(),
      });
    } catch (error) {
      console.error("Could not keep a finished background terminal:", error);
    }
  };
  // The Changes panel's workingTreeChanges is registered in panels.ts (R9).
  handle("listBackgroundTerminals", async (raw: unknown) => {
    const conversationId = id.parse(raw);
    const { items, listed } = await nativeList(context, conversationId);
    if (listed) {
      const current = new Set(items.map((item) => item.processId));
      for (const item of seen.get(conversationId) ?? []) {
        if (current.has(item.processId)) continue;
        const stop = stopping.get(`${conversationId}\0${item.processId}`);
        if (stop) stop.gone = true;
        else finish(item, "completed");
      }
      seen.set(conversationId, items);
    } else seen.delete(conversationId);
    return {
      conversationId,
      items,
      finished: context.backgroundHistory?.finished(conversationId) ?? [],
    };
  });
  handle(
    "stopBackgroundTerminal",
    async (rawConversation: unknown, rawProcess: unknown) => {
      const conversationId = id.parse(rawConversation),
        processId = id.parse(rawProcess),
        conversation = context.store.conversation(conversationId);
      const listed = await nativeList(context, conversationId);
      const item = listed.items.find((value) => value.processId === processId);
      if (!item)
        throw Error("Background terminal is not in this conversation.");
      const key = `${conversationId}\0${processId}`;
      const stop = { gone: false };
      stopping.set(key, stop);
      let terminated = false;
      try {
        const engine = engineOf(context, conversationId);
        if (!engine?.rpc) throw Error("Codex is not connected.");
        const result = await engine.rpc.call(
          "thread/backgroundTerminals/terminate",
          { threadId: conversation.threadId, processId },
        );
        terminated = Boolean(result?.terminated);
        return terminated;
      } finally {
        if (stopping.get(key) === stop) stopping.delete(key);
        if (terminated) finish(item, "stopped");
        // It ended on its own before the stop reached it.
        else if (stop.gone) finish(item, "completed");
      }
    },
  );
}
