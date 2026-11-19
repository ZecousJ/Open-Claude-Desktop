import {
  completionBlocks,
  type CompletionOutputContext,
} from "./completion-content";
import type { Turn } from "../../../shared/types";
export interface CompletionEvent {
  event: string;
  data: Record<string, unknown>;
}
/** Translate actual turn snapshots into official SSE content events. */
export class RestCompletionTextStream {
  readonly events: CompletionEvent[] = [];
  done = false;
  private blocks: {
    key: string;
    start: string;
    text: string;
    summaries: string[];
    closed: boolean;
    textBlock: boolean;
  }[] = [];
  private readonly elicitations = new Map<string, string>();
  private started = false;
  private bytes = 0;
  constructor(
    private readonly options: { deferTextForCitations?: boolean } = {},
  ) {}
  private push(event: string, data: Record<string, unknown>) {
    const entry = { event, data };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (
      size > 200 * 1024 ||
      this.bytes + size > 4 * 1024 * 1024 ||
      this.events.length >= 4096
    )
      throw Error("Completion stream limit exceeded.");
    this.events.push(entry);
    this.bytes += size;
  }
  updateElicitations(
    offers: readonly {
      type: string;
      tool_use_id: string;
      elicitation_id: string;
      [key: string]: unknown;
    }[],
  ) {
    if (this.done) return;
    const available = new Set(offers.map((offer) => offer.elicitation_id));
    for (const [id, toolUseId] of this.elicitations) {
      if (!available.has(id)) {
        this.push("mcp_elicitation_complete", {
          type: "mcp_elicitation_complete",
          tool_use_id: toolUseId,
        });
        this.elicitations.delete(id);
      }
    }
    for (const offer of offers) {
      if (this.elicitations.has(offer.elicitation_id)) continue;
      const matches = this.blocks.filter((block) => {
        const start = JSON.parse(block.start);
        return start.type === "tool_use" && start.id === offer.tool_use_id;
      });
      if (matches.length !== 1) continue;
      this.push("mcp_elicitation", offer);
      this.elicitations.set(offer.elicitation_id, offer.tool_use_id);
    }
  }
  fail(message: string, type = "completion_error") {
    if (this.done) return;
    // Reserve one bounded terminal error even after a content limit.
    this.events.push({
      event: "error",
      data: { type: "error", error: { type, message } },
    });
    this.done = true;
  }
  update(
    turn: Turn,
    humanId: string,
    assistantId: string,
    model: string,
    output?: CompletionOutputContext,
  ) {
    if (this.done) return;
    try {
      if (
        !turn ||
        !["inProgress", "completed", "failed", "interrupted"].includes(
          turn.status,
        ) ||
        !Array.isArray(turn.items) ||
        turn.items.some(
          (item) =>
            !item ||
            typeof item.type !== "string" ||
            (item.type === "agentMessage" && typeof item.text !== "string"),
        )
      ) {
        this.fail("The completion snapshot is invalid.");
        return;
      }
      const content = completionBlocks(
        turn,
        this.options.deferTextForCitations,
        output,
      );
      const last = this.blocks.at(-1);
      if (
        last?.textBlock &&
        !last.closed &&
        !turn.items.some((item) => item.id === last.key)
      ) {
        this.blocks.pop();
        this.push("content_block_retract", {
          type: "content_block_retract",
          from_index: this.blocks.length,
        });
      }
      if (content.length < this.blocks.length)
        throw Error("Content was removed");
      if (!this.started) {
        this.push("message_start", {
          type: "message_start",
          message: {
            uuid: assistantId,
            parent_uuid: humanId,
            role: "assistant",
            model,
            content: [],
          },
        });
        this.started = true;
      }
      for (const [index, block] of content.entries()) {
        const shape = JSON.stringify(block.start);
        let current = this.blocks[index];
        if (!current) {
          if (index > 0 && !this.blocks[index - 1].closed)
            throw Error("Previous content is unfinished");
          this.push("content_block_start", {
            type: "content_block_start",
            index,
            content_block: block.start,
          });
          current = {
            key: block.key,
            start: shape,
            text: "",
            summaries: [],
            closed: false,
            textBlock: block.start.type === "text",
          };
          this.blocks.push(current);
        }
        if (current.key !== block.key || current.start !== shape)
          throw Error("Content identity changed");
        let next = block.text ?? "";
        const tail = next.charCodeAt(next.length - 1);
        if (tail >= 0xd800 && tail <= 0xdbff && !block.complete)
          next = next.slice(0, -1);
        for (let i = 0; i < next.length; i++) {
          const code = next.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const low = next.charCodeAt(++i);
            if (!(low >= 0xdc00 && low <= 0xdfff))
              throw Error("Invalid UTF-16");
          } else if (code >= 0xdc00 && code <= 0xdfff)
            throw Error("Invalid UTF-16");
        }
        const summaries = block.summaries ?? [];
        if (
          !next.startsWith(current.text) ||
          summaries.length < current.summaries.length ||
          current.summaries.some((v, i) => summaries[i] !== v) ||
          (current.closed &&
            (next !== current.text ||
              summaries.length !== current.summaries.length))
        )
          throw Error("Content changed after delivery");
        let delta = next.slice(current.text.length);
        while (delta.length) {
          let size = Math.min(delta.length, 4096);
          const last = delta.charCodeAt(size - 1);
          if (size < delta.length && last >= 0xd800 && last <= 0xdbff) size--;
          const thinking = block.start.type === "thinking";
          const tool = block.start.type === "tool_use";
          this.push("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: thinking
              ? { type: "thinking_delta", thinking: delta.slice(0, size) }
              : tool
                ? {
                    type: "input_json_delta",
                    partial_json: delta.slice(0, size),
                  }
                : { type: "text_delta", text: delta.slice(0, size) },
          });
          delta = delta.slice(size);
        }
        for (const summary of summaries.slice(current.summaries.length))
          this.push("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_summary_delta", summary: { summary } },
          });
        current.text = next;
        current.summaries = [...summaries];
        if (block.complete && !current.closed) {
          this.push("content_block_stop", {
            type: "content_block_stop",
            index,
            ...(block.start.type === "tool_use"
              ? { buffered_input: next }
              : {}),
          });
          if (block.authRequired) {
            this.push("mcp_auth_required", {
              type: "mcp_auth_required",
              server_id: block.authRequired.server_id,
              tool_use_id: block.authRequired.tool_use_id,
              error_code: block.authRequired.error_code,
            });
          }
          current.closed = true;
        }
      }
      if (turn.status !== "inProgress") this.updateElicitations([]);
      if (turn.status === "failed" || turn.status === "interrupted") {
        this.fail(
          turn.status === "interrupted"
            ? "The response was interrupted."
            : "The response failed. Reopen the conversation to inspect its state.",
          turn.status === "interrupted" ? "cancelled" : "completion_error",
        );
        return;
      }
      if (turn.status === "completed") {
        const stopReasons: Record<string, string> = {
          length: "max_tokens",
          tool_use_limit: "tool_use_limit",
          conversation_length_limit: "conversation_length_limit",
          usage_limit: "usage_limit",
        };
        if (turn.stopReason && !stopReasons[turn.stopReason]) {
          this.fail(
            "The response ended early. Reopen the conversation to review its limit or recovery state.",
          );
          return;
        }
        this.push("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: turn.stopReason
              ? stopReasons[turn.stopReason]
              : "end_turn",
            stop_sequence: null,
          },
        });
        this.push("message_stop", { type: "message_stop" });
        this.done = true;
      }
    } catch {
      this.fail(
        "The response content changed, is unsupported, or exceeded the stream limit. Reopen the conversation.",
      );
    }
  }
  batch(cursor: number) {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > this.events.length
    )
      throw Error("Invalid completion cursor.");
    const events: CompletionEvent[] = [];
    let bytes = 0;
    for (const event of this.events.slice(cursor, cursor + 64)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 240 * 1024) break;
      events.push(event);
      bytes += size;
    }
    const next = cursor + events.length;
    return {
      cursor: next,
      events,
      done: this.done && next === this.events.length,
    };
  }
}
