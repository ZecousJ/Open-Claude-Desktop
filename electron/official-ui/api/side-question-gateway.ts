import { randomUUID } from "node:crypto";
import { readSSE } from "../../engine/gateway-support";
import type { SideQuestionMessage } from "./side-question-context";

export interface SideQuestionGateway {
  open(): Promise<{ url: string; token: string; path: string }>;
  close(path: string): Promise<void>;
  current(): boolean;
  instructions?: string;
  verifyContext?(
    conversation: import("../../../shared/types").Conversation,
  ): void;
}

/** One ephemeral, tool-free gateway request. A failed request is never retried. */
export async function streamSideQuestion(
  gateway: SideQuestionGateway,
  options: {
    model: string;
    messages: SideQuestionMessage[];
    reasoning?: { effort: string };
    instructions?: string;
    signal: AbortSignal;
    onDelta(text: string): void;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const check = () => {
    options.signal.throwIfAborted();
    if (!gateway.current()) throw Error("The side-question account changed.");
  };
  check();
  const target = await gateway.open();
  try {
    check();
    if (!/^[a-f0-9]{64}$/.test(target.path))
      throw Error("The side-question gateway is unavailable.");
    const response = await fetchImpl(
      `${target.url}/side/${target.path}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${target.token}`,
        },
        body: JSON.stringify({
          model: options.model,
          input: options.messages.map((message) =>
            "role" in message
              ? {
                  role: message.role,
                  content: message.content ?? [
                    {
                      type:
                        message.role === "user" ? "input_text" : "output_text",
                      text: message.text,
                    },
                  ],
                }
              : message,
          ),
          stream: true,
          store: false,
          max_output_tokens: 4096,
          tools: [],
          client_metadata: { turn_id: randomUUID() },
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          ...(options.instructions
            ? { instructions: options.instructions }
            : {}),
        }),
        signal: options.signal,
      },
    );
    check();
    if (!response.ok || !response.body)
      throw Error(
        `The side-question model request failed (${response.status}).`,
      );
    let text = "",
      completed = false;
    const append = (delta: unknown) => {
      if (
        typeof delta !== "string" ||
        Buffer.byteLength(text, "utf8") + Buffer.byteLength(delta, "utf8") >
          1024 * 1024
      )
        throw Error("The side-question response is invalid or too large.");
      if (delta) {
        text += delta;
        options.onDelta(delta);
      }
    };
    for await (const event of readSSE(response.body)) {
      check();
      if (completed)
        throw Error("The side-question response continued after completion.");
      if (
        (event.type === "response.output_item.added" ||
          event.type === "response.output_item.done") &&
        event.item?.type !== "message" &&
        event.item?.type !== "reasoning"
      )
        throw Error("The side-question response included unsupported output.");
      if (event.type === "response.output_text.delta") append(event.delta);
      else if (event.type === "response.refusal.delta") append(event.delta);
      else if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      )
        throw Error("The side-question model did not complete its response.");
      else if (event.type === "response.completed") {
        const output = event.response?.output;
        if (!Array.isArray(output))
          throw Error("The side-question response is invalid.");
        let final = "";
        for (const item of output) {
          if (item?.type === "reasoning") continue;
          if (
            item?.type !== "message" ||
            item.role !== "assistant" ||
            !Array.isArray(item.content)
          )
            throw Error(
              "The side-question response included unsupported output.",
            );
          for (const part of item.content) {
            if (part?.type === "output_text" && typeof part.text === "string")
              final += part.text;
            else if (
              part?.type === "refusal" &&
              typeof part.refusal === "string"
            )
              final += part.refusal;
            else
              throw Error(
                "The side-question response included unsupported content.",
              );
          }
        }
        if (!final.startsWith(text))
          throw Error("The side-question response changed after streaming.");
        append(final.slice(text.length));
        completed = true;
      }
    }
    check();
    if (!completed)
      throw Error("The side-question response ended before completion.");
  } finally {
    await gateway.close(target.path).catch(() => {});
  }
}
