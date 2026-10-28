import type { Item } from "../../shared/types";
import { captureGeneratedFilesWith } from "../artifacts/generated-files";
import { GeneratedBlobs } from "../artifacts/generated-blobs";
import { remoteWorkspace, FRESH_MS } from "./remote-workspace";
import type { GeneratedFilesSources } from "./remote-workspace";

/**
 * Snapshots the files an SSH conversation's completed file changes wrote,
 * as the local engine does for its own (captureGeneratedFiles): once, when
 * the change is seen completing, read from the host. Returns the function
 * that stops watching.
 */
export function watchRemoteGeneratedFiles(
  sources: GeneratedFilesSources,
  now: () => number = Date.now,
): () => void {
  const started = new Set<string>();
  const capture = async (
    conversationId: string,
    turnId: string,
    item: Item,
  ) => {
    const conversation = sources.store.conversations.find(
      (c) => c.id === conversationId,
    );
    const environment = conversation?.environment;
    if (!conversation?.cwd || environment?.kind !== "ssh") return;
    const workspace = remoteWorkspace(sources, environment.hostId);
    let files;
    try {
      files = await captureGeneratedFilesWith(
        item,
        conversation.cwd,
        workspace.readFileInside,
        conversation.incognito
          ? undefined
          : new GeneratedBlobs(sources.store.root),
      );
    } catch {
      return;
    }
    // The item as it is now (the engine may have replaced the object).
    const current = sources.store.conversations.find(
      (c) => c.id === conversationId,
    );
    const target = current?.turns
      .find((turn) => turn.id === turnId)
      ?.items.find((value) => value.id === item.id);
    if (!current || !target || target.generatedFiles) return;
    target.generatedFiles = files;
    sources.store.flush();
    sources.push({
      type: "conversation",
      conversation: structuredClone(current),
    });
  };
  return sources.onEvent((event) => {
    if (event.type !== "conversation") return;
    const conversation = event.conversation;
    if (conversation.environment?.kind !== "ssh" || !conversation.cwd) return;
    for (const turn of conversation.turns.slice(-3))
      for (const item of turn.items) {
        if (
          item.type !== "fileChange" ||
          item.status !== "completed" ||
          item.generatedFiles ||
          typeof item.completedAt !== "number" ||
          now() - item.completedAt > FRESH_MS
        )
          continue;
        const key = `${conversation.id}\0${turn.id}\0${item.id}`;
        if (started.has(key)) continue;
        // Keys of long-finished changes are no longer needed.
        if (started.size > 5_000) started.clear();
        started.add(key);
        void capture(conversation.id, turn.id, structuredClone(item));
      }
  });
}
