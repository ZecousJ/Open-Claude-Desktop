import { useConversationServices } from "../conversation/ConversationServices";
import { useEffect, useState } from "react";
import type { GeneratedFile } from "../../shared/types";
import type { Artifact } from "../ui/components";
import { GeneratedFileCard } from "./GeneratedFileCard";
import "./generated-file-card.css";

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

/**
 * The card under Chat's steps for a picture the agent generated: the same
 * "Image · PNG" file card claude.ai shows for a picture it shares. Loaded on
 * first use, with its styles, to keep the first load within budget.
 */
export default function GeneratedImageCard({
  savedPath,
  platform,
  onArtifact,
  onError,
  onNotify,
}: {
  savedPath: string;
  platform?: string;
  onArtifact: (artifact: Artifact) => void;
  onError?: (error: unknown) => void;
  onNotify?: (message: string) => void;
}) {
  const services = useConversationServices();
  const [file, setFile] = useState<GeneratedFile>();
  // Said only once the snapshot is known to be missing, not while it loads.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    setFile(undefined);
    setMissing(false);
    services.imageGenerationSnapshot(savedPath).then(
      (snapshot) => {
        if (!live) return;
        if (!snapshot) return setMissing(true);
        const base = savedPath.split(/[\\/]/).at(-1) || "image";
        const name = /\.[a-z0-9]+$/i.test(base)
          ? base
          : `${base}.${extensions[snapshot.mime]}`;
        setFile({
          id: `generated-image:${snapshot.digest}`,
          name,
          path: savedPath,
          language: "text",
          operation: "create",
          state: "ready",
          digest: snapshot.digest,
          bytes: snapshot.bytes,
          blob: true,
        });
      },
      () => {
        if (live) setMissing(true);
      },
    );
    return () => {
      live = false;
    };
  }, [savedPath, services]);
  if (!file)
    return services.imagePreviewUnavailable ||
      (services.conversationId && missing) ? (
      <p className="text-muted" role="status">
        {services.imagePreviewUnavailable ??
          "Image preview is not available for this file"}
      </p>
    ) : null;
  return (
    <GeneratedFileCard
      file={file}
      platform={platform}
      onArtifact={onArtifact}
      onError={onError}
      onNotify={onNotify}
    />
  );
}
