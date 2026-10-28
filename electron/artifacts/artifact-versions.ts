import { createHash, randomUUID } from "node:crypto";
import type { Conversation, GeneratedFile } from "../../shared/types";
import { GeneratedBlobs } from "./generated-blobs";

// Only a version belonging to this artifact can be restored.
export function artifactVersion(
  conversation: Conversation,
  filename: string,
  digest: string,
  root: string,
) {
  const file = conversation.turns
    .flatMap((turn) => turn.items)
    .flatMap((item) => item.generatedFiles ?? [])
    .find(
      (file) =>
        file.path === filename &&
        file.digest === digest &&
        file.state === "ready" &&
        !file.tooLarge,
    );
  if (!file || (!file.blob && typeof file.content !== "string")) return;
  const bytes = file.blob
    ? new GeneratedBlobs(root).read(digest)
    : Buffer.from(file.content!, "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== digest) return;
  return { file, bytes };
}

export function restoredArtifact(
  file: GeneratedFile,
  now = Date.now(),
): GeneratedFile {
  return { ...file, id: randomUUID(), operation: "update", capturedAt: now };
}
