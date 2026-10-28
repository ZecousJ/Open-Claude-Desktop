/**
 * Pictures the built-in image tool made, read beside the stream Codex gets.
 *
 * Codex 0.144.1 records an upstream `image_generation_call` in its rollout but,
 * through the Claudex gateway, neither saves the picture nor reports an
 * `imageGeneration` item; the reply ends empty and the paid-for picture is
 * lost. The gateway therefore hands the picture to the main process, which
 * saves it where Codex would (`$CODEX_HOME/generated_images`) and records the
 * item. The bytes sent to Codex are never changed.
 */
type Json = Record<string, any>;

export interface GeneratedImageEvent {
  threadId?: string;
  /** The upstream call id (`ig_…`), the item's id. */
  callId: string;
  /** The picture, base64. */
  base64: string;
  /** png, jpeg or webp. */
  format: "png" | "jpeg" | "webp";
  revisedPrompt?: string;
}

/** Largest picture handed over (base64 characters, about 24 MB of image). */
export const maxGeneratedImageBase64 = 32 * 1024 * 1024;

const formats = new Set(["png", "jpeg", "webp"]);

/** The finished picture an SSE event carries, if any. */
export function generatedImageFromResponse(
  event: Json,
  threadId: string | undefined,
): GeneratedImageEvent | undefined {
  if (event?.type !== "response.output_item.done") return;
  const item = event.item as Json | undefined;
  if (item?.type !== "image_generation_call") return;
  const base64 = typeof item.result === "string" ? item.result.trim() : "";
  const callId = typeof item.id === "string" ? item.id.slice(0, 200) : "";
  if (!base64 || !callId || base64.length > maxGeneratedImageBase64) return;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64.slice(0, 4096))) return;
  const format = String(item.output_format ?? "png").toLowerCase();
  return {
    threadId,
    callId,
    base64,
    format: (formats.has(format)
      ? format
      : "png") as GeneratedImageEvent["format"],
    ...(typeof item.revised_prompt === "string" && item.revised_prompt
      ? { revisedPrompt: item.revised_prompt.slice(0, 4000) }
      : {}),
  };
}

/** A picture handed over from the provider child, checked again. */
export function parseGeneratedImageSignal(
  value: unknown,
): GeneratedImageEvent | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Json;
  if (typeof raw.callId !== "string" || !raw.callId || raw.callId.length > 200)
    return;
  if (
    typeof raw.base64 !== "string" ||
    !raw.base64 ||
    raw.base64.length > maxGeneratedImageBase64
  )
    return;
  if (!formats.has(raw.format)) return;
  if (raw.threadId !== undefined && typeof raw.threadId !== "string") return;
  return {
    ...(raw.threadId ? { threadId: raw.threadId.slice(0, 200) } : {}),
    callId: raw.callId,
    base64: raw.base64,
    format: raw.format,
    ...(typeof raw.revisedPrompt === "string" && raw.revisedPrompt
      ? { revisedPrompt: raw.revisedPrompt.slice(0, 4000) }
      : {}),
  };
}
