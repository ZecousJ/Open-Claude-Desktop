import type { Conversation } from "../../shared/types";
import type { GeneratedImage } from "../../shared/artifacts-api";

/**
 * A generated picture is opened by the app from its own file, so the card only
 * needs its descriptor; 2 MiB (the inline thumbnail limit) left most generated
 * pictures without a card.
 */
export const maxImageBytes = 64 * 1024 * 1024;

/** Native captures only transcript-observed paths and publishes their canonical descriptors. */
export function transcriptImageSnapshot(
  conversation: Conversation,
  path: string,
  viewed = false,
): GeneratedImage | null {
  for (const turn of conversation.turns)
    for (const item of turn.items) {
      if (
        item.type !== (viewed ? "imageView" : "imageGeneration") ||
        (viewed ? item.path : item.savedPath) !== path
      )
        continue;
      const file = item.generatedFiles?.find(
        (f) => f.path === path && f.state === "ready" && f.blob,
      );
      if (
        !file ||
        typeof file.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.digest) ||
        typeof file.bytes !== "number" ||
        file.bytes < 0 ||
        file.bytes > maxImageBytes
      )
        return null;
      const mime = file.mime;
      if (
        mime !== "image/png" &&
        mime !== "image/jpeg" &&
        mime !== "image/webp"
      )
        return null;
      return { digest: file.digest, mime, bytes: file.bytes };
    }
  return null;
}
