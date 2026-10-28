import type { GeneratedFile } from "../../shared/types";
import type { Artifact } from "../ui/components";
import { fileCardName } from "./file-card-name";

/**
 * The artifact a captured file opens as. Text files carry their content;
 * binary files (images, PDF, Office) carry only their profile snapshot's
 * digest, type and size, and are read by digest when previewed or saved.
 */
export function generatedArtifact(file: GeneratedFile): Artifact | undefined {
  if (file.state !== "ready") return;
  const common = {
    updatedAt: file.capturedAt,
    id: `generated:${file.id}:${file.digest}`,
    filename: file.name,
    language: file.language,
    sourcePath: file.path,
    sourceDigest: file.digest,
  };
  // Past the snapshot limits: a file card that opens the too-large viewer.
  if (file.tooLarge)
    return {
      ...common,
      name: file.name,
      content: "",
      contentOmitted: true,
      bytes: file.bytes,
    };
  if (file.blob) {
    if (!file.digest) return;
    return {
      ...common,
      // A picture's viewer is titled as its card is ("Red circle · PNG").
      name: /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(file.name)
        ? fileCardName(file.name)
        : file.name,
      content: "",
      blob: true,
      mime: file.mime,
      bytes: file.bytes,
    };
  }
  if (file.content === undefined) return;
  const title =
    file.language === "html"
      ? /<title[^>]*>([^<]+)<\/title>/i.exec(file.content)?.[1]?.trim()
      : undefined;
  return { ...common, name: title || file.name, content: file.content };
}
