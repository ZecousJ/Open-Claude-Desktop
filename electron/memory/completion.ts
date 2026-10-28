/**
 * How the memory summary asks the model (R3 design 3.6 step 2): one
 * Responses request to this computer's own gateway (the same one Codex
 * uses, so the account's key, model list, limits and usage accounting all
 * apply), with no tools, nothing stored upstream and low reasoning effort.
 * Nothing goes anywhere but the configured provider.
 */
import { readSSE } from "../engine/gateway-support";
import type { Prompt } from "./prompts";

/** Where the gateway listens and which model to ask. */
export interface CompletionTarget {
  /** The gateway's base address, ending in /v1. */
  url: string;
  token: string;
  model: string;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

/** Sends a prompt, answers the model's text. Rejects with a plain-English reason. */
export type Completer = (
  prompt: Prompt,
  options?: CompletionOptions,
) => Promise<string>;

/** No model is set up, or the gateway is not running. */
export class CompletionUnavailableError extends Error {
  constructor(message = "The model isn't available right now.") {
    super(message);
    this.name = "CompletionUnavailableError";
  }
}

const timeoutMs = 3 * 60_000;

function errorMessage(body: unknown, status: number) {
  const message = (body as any)?.error?.message ?? (body as any)?.message;
  if (typeof message === "string" && message.trim())
    return message.trim().slice(0, 300);
  return status === 429
    ? "The usage limit was reached."
    : `The model request failed (${status}).`;
}

async function readAnswer(response: Response): Promise<string> {
  if (!response.body) throw new Error("The response was empty.");
  let text = "";
  let completed = "";
  for await (const event of readSSE(response.body)) {
    if (event?.type === "response.output_text.delta")
      text += String(event.delta ?? "");
    else if (event?.type === "response.completed") {
      completed = (event.response?.output ?? [])
        .flatMap((item: any) => item?.content ?? [])
        .filter((part: any) => part?.type === "output_text")
        .map((part: any) => String(part.text ?? ""))
        .join("");
    } else if (event?.type === "response.failed" || event?.type === "error")
      throw new Error(
        errorMessage(
          event.response?.error ?? event.error ?? event,
          response.status,
        ),
      );
  }
  return (text || completed).trim();
}

/**
 * The completer over the gateway. `target()` answers undefined when the
 * agent (and so the gateway) cannot be reached; the request then fails
 * without sending anything.
 */
export function gatewayCompleter(
  target: () => Promise<CompletionTarget | undefined>,
  fetchImpl: typeof fetch = fetch,
): Completer {
  return async (prompt, options = {}) => {
    const where = await target();
    if (!where) throw new CompletionUnavailableError();
    const send = async (reasoning: boolean) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchImpl(`${where.url}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${where.token}`,
          },
          body: JSON.stringify({
            model: where.model,
            instructions: prompt.instructions,
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: prompt.input }],
              },
            ],
            store: false,
            stream: true,
            ...(options.maxOutputTokens
              ? { max_output_tokens: options.maxOutputTokens }
              : {}),
            ...(reasoning ? { reasoning: { effort: "low" } } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => undefined);
          return {
            status: response.status,
            message: errorMessage(body, response.status),
          };
        }
        return { text: await readAnswer(response) };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      }
    };
    let result = await send(true);
    // A model without reasoning settings: ask again without them.
    if ("status" in result && result.status === 400) result = await send(false);
    if ("message" in result) throw new Error(result.message);
    if (!result.text) throw new Error("The model gave no answer.");
    return result.text;
  };
}
