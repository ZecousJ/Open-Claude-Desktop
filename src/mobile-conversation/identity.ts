import type { Conversation } from "../../shared/types";
import type { ConversationFileIdentity } from "../../shared/mobile/conversation-contract";
import type { Artifact } from "../ui/ArtifactTypes";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { artifactsIn } from "../ui/ArtifactTypes";

/** Resolve a renderer descriptor back to canonical source before crossing the bridge. */
export function fileIdentity(
  conversation: Conversation,
  artifact: Artifact,
): ConversationFileIdentity | undefined {
  for (const turn of conversation.turns)
    for (const item of turn.items) {
      for (const file of item.generatedFiles ?? []) {
        const known = generatedArtifact(file);
        if (
          known &&
          (known.id === artifact.id ||
            (known.sourcePath === artifact.sourcePath &&
              known.sourceDigest === artifact.sourceDigest))
        ) {
          return {
            conversationId: conversation.id,
            artifactId: known.id,
            sourcePath: file.path,
            ...(file.digest ? { sourceDigest: file.digest } : {}),
          };
        }
      }
      const sources = [
        { kind: "fence", text: item.text ?? "" },
        { kind: "fence-summary", text: item.summary?.join("\n\n") ?? "" },
      ];
      for (const source of sources)
        for (const [index, fence] of artifactsIn(
          source.text,
          item.id,
        ).entries()) {
          if (
            fence.language === artifact.language &&
            fence.content.trimEnd() === artifact.content.trimEnd()
          ) {
            return {
              conversationId: conversation.id,
              artifactId: `${source.kind}:${item.id}:${index}`,
            };
          }
        }
    }
  return undefined;
}

export function rasterDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 16_000_000 &&
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

/** The shared selection component produces Markdown; native composer quotes once. */
export function rawQuoteSelection(quote: string) {
  return quote
    .replace(/\n\n$/, "")
    .split("\n")
    .map((line) => (line.startsWith("> ") ? line.slice(2) : line))
    .join("\n");
}
