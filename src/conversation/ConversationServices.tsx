import { createContext, useContext } from "react";
import type { GeneratedImage } from "../../shared/artifacts-api";
import type { Artifact } from "../ui/ArtifactTypes";

/**
 * The transcript's small host seam. Web/desktop retain their existing bridge
 * implementations; the offline native entry supplies display-scoped services.
 * This is deliberately not DesktopAPI and exposes no arbitrary RPC or network.
 */
export interface ConversationServices {
  conversationId?: string;
  /** Native shares live in its file viewer; omit the unsupported inline affordance. */
  inlineArtifactSharing?: boolean;
  /** Explicit host limitation shown by the shared image-tool controls. */
  imagePreviewUnavailable?: string;
  /** `html` is the same text as rich text, for a paste into a document or mail. */
  copyText(text: string, html?: string): Promise<void>;
  attachmentPreview(id: string): Promise<string | null>;
  /** Injected snapshot cache; later native media renders must not retain an old null. */
  attachmentPreviewSync?: (id: string) => string | null;
  openAttachment?: (id: string) => Promise<void>;
  loadRemoteImage(url: string): Promise<string>;
  readGeneratedFile(digest: string): Promise<string>;
  imageGenerationSnapshot(path: string): Promise<GeneratedImage | null>;
  viewedImageSnapshot(
    conversationId: string,
    path: string,
  ): Promise<GeneratedImage | null>;
  downloadArtifact?: (
    artifact: Artifact,
    filename: string,
  ) => Promise<string | null>;
  /** Native can reserve one bounded chooser batch; desktop retains its existing loop. */
  downloadArtifacts?: (artifacts: Artifact[]) => Promise<number>;
}
export const desktopConversationServices: ConversationServices = {
  copyText: async (text, html) => {
    if (window.desktop?.copyText) await window.desktop.copyText(text, html);
    else await navigator.clipboard.writeText(text);
  },
  attachmentPreview: (id) => window.desktop.attachmentPreview(id),
  loadRemoteImage: (url) => window.desktop.loadRemoteImage(url),
  readGeneratedFile: (digest) => window.desktop.readGeneratedFile(digest),
  imageGenerationSnapshot: (path) =>
    window.desktop.imageGenerationSnapshot(path),
  viewedImageSnapshot: (conversationId, path) =>
    window.desktop.viewedImageSnapshot(conversationId, path),
};
export const ConversationServicesContext = createContext<ConversationServices>(
  desktopConversationServices,
);
export const useConversationServices = () =>
  useContext(ConversationServicesContext);
