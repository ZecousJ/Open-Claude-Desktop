import type { Artifact } from "../ui/ArtifactTypes";
import { markdownFence } from "./ArtifactSource";
import {
  artifactDownloadError,
  artifactDownloadLimit,
} from "../../shared/artifact-download";
import { t } from "../i18n";

/** Longest artifact source Try fixing quotes when there is no file to point at. */
const maxQuotedSource = 100_000;

/**
 * The message Try fixing sends to the artifact's conversation. A generated file
 * is named by path so the agent edits it; a code block's source is quoted
 * instead. The error text comes from the sandboxed preview, so it is fenced and
 * only ever sent when the person clicks.
 */
export function fixRequest(artifact: Artifact, error: string) {
  const fence = markdownFence(error);
  const source = artifact.sourcePath
    ? `File: ${artifact.sourcePath}`
    : (() => {
        const content = artifact.content.slice(0, maxQuotedSource);
        const sourceFence = markdownFence(content);
        return `Artifact source:\n${sourceFence}${artifact.language}\n${content}\n${sourceFence}`;
      })();
  return `The artifact "${artifact.name}" shows this error in its preview:\n\n${fence}\n${error}\n${fence}\n\n${source}\n\nPlease fix it.`;
}

/** The toast after a download is saved: the file's own name. */
export function savedMessage(path: string) {
  return `Saved ${path.split(/[\\/]/).at(-1) || path}`;
}

/** Saves a text or binary artifact; resolves to the saved path, or null when cancelled. */
export async function downloadArtifact(
  artifact: Artifact,
  filename: string,
  current: () => boolean = () => true,
): Promise<string | null> {
  const bridge = window.desktop;
  try {
    if (artifact.blankArtifact && artifact.conversationId) {
      const document = await bridge.readBlankArtifact({
        conversationId: artifact.conversationId,
        artifactId: artifact.blankArtifact.id,
      });
      if (!current() || window.desktop !== bridge) return null;
      artifact = {
        ...artifact,
        content: document.content,
        blankArtifact: undefined,
      };
    }
    if (
      !artifact.blob &&
      new TextEncoder().encode(artifact.content).byteLength >
        artifactDownloadLimit
    )
      throw new Error("too_large");
    if (artifact.blob) {
      if (!artifact.sourceDigest)
        throw Error("This file has no saved snapshot to download.");
      return await bridge.saveGeneratedFile(artifact.sourceDigest, filename);
    }
    if (!current() || window.desktop !== bridge) return null;
    return await bridge.saveArtifact(filename, artifact.content);
  } catch (error) {
    const message = artifactDownloadError(error);
    if (message === null) return null;
    throw new Error(t(message));
  }
}
