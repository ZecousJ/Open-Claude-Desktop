/**
 * A conversation with one of GPT's image models: each message is answered with
 * a picture. Codex still sends a Responses request; the gateway asks the
 * service's image endpoint with the person's latest message as the prompt (and
 * the pictures attached to it, which makes it an edit) and answers Codex with
 * one `image_generation_call`, the item an upstream image tool gives. Nothing
 * is added to what the person wrote.
 */
type Json = Record<string, any>;

/** Context Codex sends as user messages (instructions, environment). */
function envelope(text: string) {
  const t = text.trim();
  return t.startsWith("<") || t.startsWith("# AGENTS.md");
}

/** The latest message the person wrote: its text and the pictures attached to it. */
export function drawingPrompt(request: Json): {
  prompt: string;
  images: string[];
} {
  const input = Array.isArray(request?.input) ? request.input : [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Json;
    if (item?.role !== "user") continue;
    if (item.type && item.type !== "message") continue;
    const parts: Json[] =
      typeof item.content === "string"
        ? [{ type: "input_text", text: item.content }]
        : Array.isArray(item.content)
          ? item.content
          : [];
    const texts: string[] = [];
    const images: string[] = [];
    for (const part of parts) {
      if (
        (part?.type === "input_text" || part?.type === "text") &&
        typeof part.text === "string" &&
        !envelope(part.text)
      )
        texts.push(part.text);
      if (part?.type === "input_image") {
        const url =
          typeof part.image_url === "string"
            ? part.image_url
            : part.image_url?.url;
        if (typeof url === "string" && url) images.push(url);
      }
    }
    const prompt = texts.join("\n").trim();
    if (!prompt && !images.length) continue;
    return { prompt, images };
  }
  return { prompt: "", images: [] };
}

/** The image endpoint's request for a drawing turn. */
export function drawingRequest(
  model: string,
  prompt: string,
  images: string[],
): { route: "images/generations" | "images/edits"; body: Json } {
  const body: Json = { model, prompt, n: 1 };
  if (!images.length) return { route: "images/generations", body };
  return {
    route: "images/edits",
    body: {
      ...body,
      images: images.slice(0, 16).map((image_url) => ({ image_url })),
    },
  };
}

/** The picture an image endpoint answered with: base64, or a link to it. */
export function drawnImage(
  reply: Json,
): { base64?: string; url?: string; revisedPrompt?: string } | undefined {
  const first = Array.isArray(reply?.data) ? reply.data[0] : undefined;
  if (!first) return undefined;
  const revisedPrompt =
    typeof first.revised_prompt === "string" && first.revised_prompt
      ? first.revised_prompt
      : undefined;
  if (typeof first.b64_json === "string" && first.b64_json)
    return { base64: first.b64_json, revisedPrompt };
  if (typeof first.url === "string" && /^https?:\/\//.test(first.url))
    return { url: first.url, revisedPrompt };
  return undefined;
}

/** png, jpeg or webp, from the picture's first bytes (png when unknown). */
export function imageFormat(base64: string): "png" | "jpeg" | "webp" {
  if (base64.startsWith("/9j/")) return "jpeg";
  if (base64.startsWith("UklGR")) return "webp";
  return "png";
}

/**
 * Earlier pictures come back in Codex's history as image calls whose
 * picture was left out (the turn's item carries none, the file holds it);
 * the model service is not sent them.
 */
export function withoutEmptyImageCalls(request: Json): Json {
  if (!Array.isArray(request?.input)) return request;
  const input = request.input.filter(
    (item: Json) =>
      !(
        item?.type === "image_generation_call" &&
        !(typeof item.result === "string" && item.result)
      ),
  );
  return input.length === request.input.length
    ? request
    : { ...request, input };
}
