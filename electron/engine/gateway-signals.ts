import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GeneratedImageEvent } from "../../server/image-observer";
import { recordItemLifecycle } from "../../shared/activity";
import type { WebSourcesEvent } from "../../shared/gateway-signals";
import type { ToolDescriptionEvent } from "../../shared/tool-description";
import type { ToolStartEvent } from "../../shared/tool-start";
import type { Conversation, Item, Turn } from "../../shared/types";
import type {
  GatewaySignalContext,
  GatewaySignalEvent,
  ItemPatch,
} from "./engine-extensions";
import { textHash } from "./turn-items";

/** What the gateway signals need from the engine. */
export interface GatewaySignalHost {
  /** The conversation (or parent agent) a thread's signal is about. */
  target(threadId: string): GatewaySignalContext;
  /** Sets fields on an item now, or once Codex reports it. */
  patchItem(
    c: Conversation,
    threadId: string,
    itemId: string,
    patch: ItemPatch,
  ): Turn | undefined;
  changed(c: Conversation): void;
  gatewaySignal(signal: GatewaySignalEvent, target: GatewaySignalContext): void;
  /** An engine on another computer (SSH) keeps no pictures here. */
  remote(): boolean;
  runningThread(): string | undefined;
  /** $CODEX_HOME/generated_images on this computer. */
  imageFolder(): string;
}

/**
 * What the gateway reports beside Codex's own events: a shell command's
 * description (R7), the pages a search read and a reply's citations (R45),
 * pictures the image tool made, and a file write that has begun. Each lands
 * on its item, or waits until the turn ends and is placed then.
 */
export class GatewaySignals {
  /** Pictures the image tool made in a thread's running turn (captureGeneratedImage). */
  private generatedImages = new Map<string, Item[]>();
  /** Where each captured picture was made: the turn's last item then. */
  private generatedImageAfter = new Map<string, string>();
  /**
   * Web searches the gateway reported that Codex has no item for (a model
   * the gateway searches for upstream, Claude's server-side search):
   * recorded as items when their turn completes. Keyed by thread.
   */
  private orphanSearches = new Map<
    string,
    Extract<WebSourcesEvent, { kind: "search" }>[]
  >();
  /** R7: the model's description of a shell command, for its command item. */
  toolDescription(event: ToolDescriptionEvent) {
    const target = this.host.target(event.threadId);
    if (target.conversation)
      target.turn = this.host.patchItem(
        target.conversation,
        event.threadId,
        event.callId,
        {
          fields: { description: event.description },
          types: ["commandExecution"],
        },
      );
    this.host.gatewaySignal({ type: "toolDescription", event }, target);
  }
  /** R45: the pages a search read and a message's citations. */
  webSources(event: WebSourcesEvent) {
    const target = this.host.target(event.threadId);
    const c = target.conversation;
    if (c) {
      if (event.kind === "search") target.turn = this.search(c, event);
      else if (event.kind === "message") {
        const accepts = (item: Item) =>
          typeof item.text === "string" &&
          item.text.length === event.textLength &&
          textHash(item.text) === event.textHash;
        const patch: ItemPatch = {
          fields: { citations: event.citations },
          types: ["agentMessage"],
          accepts,
        };
        const itemId =
          event.itemId ??
          c.turns
            .at(-1)
            ?.items.filter(
              (item) => item.type === "agentMessage" && accepts(item),
            )
            .at(-1)?.id;
        if (itemId)
          target.turn = this.host.patchItem(c, event.threadId, itemId, patch);
      } else if (event.messageId)
        target.turn = this.host.patchItem(c, event.threadId, event.messageId, {
          fields: { webCitations: event.urls },
          types: ["agentMessage"],
        });
    }
    this.host.gatewaySignal({ type: "webSources", event }, target);
  }
  private search(
    c: Conversation,
    event: Extract<WebSourcesEvent, { kind: "search" }>,
  ) {
    const fields: Partial<Item> = {
      searchTool: event.tool,
      ...(event.sources.length ? { sources: event.sources } : {}),
    };
    if (event.tool === "web_search") {
      const found = this.host.patchItem(c, event.threadId, event.callId, {
        fields,
        types: ["webSearch"],
      });
      // No item yet: Codex may still send one (an OpenAI hosted search), or
      // never. The turn's end decides.
      if (!found) {
        const list = this.orphanSearches.get(event.threadId) ?? [];
        if (list.length < 50) list.push(event);
        this.orphanSearches.set(event.threadId, list);
      }
      return found;
    }
    // Codex has no item for grok's X search (it drops x_search_call), so
    // the search is recorded as a finished web search item of its own.
    const turn = c.turns.at(-1);
    if (!turn || turn.items.some((item) => item.id === event.callId)) return;
    const query = event.queries[0] ?? "";
    turn.items.push({
      id: event.callId,
      type: "webSearch",
      query,
      action: {
        type: "search",
        query,
        queries: event.queries.length > 1 ? event.queries : null,
      },
      ...fields,
      status: event.status,
      lifecycleStatus: event.status,
    });
    this.host.changed(c);
    return turn;
  }
  /**
   * At a turn's end, each web search the gateway reported without a Codex
   * item becomes a finished search item, placed before the turn's reply.
   */
  /**
   * A picture the image tool made: saved where Codex keeps them
   * ($CODEX_HOME/generated_images, which the Image card reads), and given an
   * imageGeneration item at the turn's end unless Codex reported one
   * (server/image-observer.ts).
   */
  generatedImage(event: GeneratedImageEvent) {
    if (this.host.remote()) return;
    // A picture from the image endpoint names no thread: the one turn
    // running in this engine takes it.
    const threadId = event.threadId ?? this.host.runningThread();
    if (!threadId) return;
    if (!this.host.target(threadId).conversation) return;
    const safe = (value: string) =>
      value.replace(/[^\w.-]/g, "_").slice(0, 120);
    try {
      const folder = path.join(this.host.imageFolder(), safe(threadId));
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const savedPath = path.join(
        folder,
        `${safe(event.callId)}.${event.format === "jpeg" ? "jpg" : event.format}`,
      );
      fs.writeFileSync(savedPath, Buffer.from(event.base64, "base64"), {
        mode: 0o600,
      });
      const list = this.generatedImages.get(threadId) ?? [];
      const last = this.host
        .target(threadId)
        .conversation?.turns.at(-1)
        ?.items.at(-1);
      if (last && list.length < 20)
        this.generatedImageAfter.set(event.callId, last.id);
      if (list.length < 20)
        list.push({
          id: event.callId,
          type: "imageGeneration",
          status: "completed",
          lifecycleStatus: "completed",
          savedPath,
          ...(event.revisedPrompt
            ? { revisedPrompt: event.revisedPrompt }
            : {}),
        });
      this.generatedImages.set(threadId, list);
    } catch {
      /* The picture is lost as before; the reply goes on. */
    }
  }
  /**
   * The model began writing a file (apply_patch): the change shows in progress
   * at once, not when the whole file is written. Codex's item has the call's id
   * and takes its place; one Codex never reports leaves when the turn ends.
   */
  private earlyCalls = new Map<string, Set<string>>();
  toolStart(event: ToolStartEvent) {
    const c = this.host.target(event.threadId).conversation;
    const turn = c?.turns.at(-1);
    if (!c || turn?.status !== "inProgress") return;
    if (turn.items.some((item) => item.id === event.callId)) return;
    const early = this.earlyCalls.get(event.threadId) ?? new Set<string>();
    early.add(event.callId);
    this.earlyCalls.set(event.threadId, early);
    recordItemLifecycle(
      turn,
      {
        id: event.callId,
        type: "fileChange",
        status: "inProgress",
        changes: [],
      },
      false,
    );
    this.host.changed(c);
  }
  /** The turn ends: a started write Codex never reported is dropped. */
  settleEarlyCalls(threadId: string, turn: Turn) {
    const early = this.earlyCalls.get(threadId);
    this.earlyCalls.delete(threadId);
    if (early?.size)
      turn.items = turn.items.filter((item) => !early.has(item.id));
  }
  /** The turn ends: pictures Codex did not report join it before the reply. */
  settleGeneratedImages(threadId: string, turn: Turn) {
    const list = this.generatedImages.get(threadId);
    this.generatedImages.delete(threadId);
    // A picture the reply also hands over as a file (the image script saved it
    // in the workspace) shows once, as that file.
    const shared = new Set(
      turn.items.flatMap((value) =>
        (value.generatedFiles ?? []).flatMap((file) =>
          file.digest ? [file.digest] : [],
        ),
      ),
    );
    // Pictures made at the same point keep their order.
    const placed = new Set<string>();
    for (const item of list ?? []) {
      const after = this.generatedImageAfter.get(item.id);
      this.generatedImageAfter.delete(item.id);
      if (turn.items.some((value) => value.id === item.id)) continue;
      if (shared.size && item.savedPath) {
        try {
          const digest = createHash("sha256")
            .update(fs.readFileSync(item.savedPath))
            .digest("hex");
          if (shared.has(digest)) continue;
        } catch {
          /* Unreadable: the card shows as before. */
        }
      }
      // It goes where it was made; one made before anything else (or whose
      // place is gone) goes before the reply, as before.
      const at = after
        ? turn.items.findIndex((value) => value.id === after)
        : -1;
      if (at >= 0) {
        let index = at + 1;
        while (index < turn.items.length && placed.has(turn.items[index].id))
          index += 1;
        turn.items.splice(index, 0, item);
        placed.add(item.id);
        continue;
      }
      const reply = turn.items.findIndex(
        (value) => value.type === "agentMessage" && value.text,
      );
      if (reply < 0) turn.items.push(item);
      else turn.items.splice(reply, 0, item);
    }
  }
  settleOrphanSearches(threadId: string, turn: Turn) {
    const list = this.orphanSearches.get(threadId);
    this.orphanSearches.delete(threadId);
    if (!list?.length) return;
    for (const event of list) {
      if (turn.items.some((item) => item.id === event.callId)) continue;
      const query = event.queries[0] ?? "";
      const item: Item = {
        id: event.callId,
        type: "webSearch",
        query,
        action: {
          type: "search",
          query,
          queries: event.queries.length > 1 ? event.queries : null,
        },
        searchTool: event.tool,
        ...(event.sources.length ? { sources: event.sources } : {}),
        status: event.status,
        lifecycleStatus: event.status,
      };
      const reply = turn.items.findIndex(
        (value) => value.type === "agentMessage",
      );
      if (reply < 0) turn.items.push(item);
      else turn.items.splice(reply, 0, item);
    }
  }

  /** Codex reported the item a started write was standing in for. */
  reported(threadId: string, itemId: string) {
    this.earlyCalls.get(threadId)?.delete(itemId);
  }
  constructor(private host: GatewaySignalHost) {}
}
