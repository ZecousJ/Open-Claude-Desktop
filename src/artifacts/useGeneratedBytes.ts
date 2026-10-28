import {
  desktopConversationServices,
  useConversationServices,
} from "../conversation/ConversationServices";
import { useCallback, useContext, useEffect, useState } from "react";
import { ArtifactAccountScope } from "./artifact-metadata";
import type { Artifact } from "../ui/ArtifactTypes";

// A few recent snapshots stay in memory so switching back is instant.
const cache = new Map<string, Promise<string>>();
const maxCached = 6;
let cachedAccount = "";
let cachedBridge: Window["desktop"] | undefined;

/** Base64 bytes of a binary snapshot, read from the profile by digest. */
export function readSnapshot(
  artifact: Artifact,
  accountId = "",
): Promise<string> {
  const digest = artifact.sourceDigest;
  if (!artifact.blob || !digest)
    return Promise.reject(Error("This file has no saved snapshot."));
  if (cachedAccount !== accountId || cachedBridge !== window.desktop) {
    cache.clear();
    cachedAccount = accountId;
    cachedBridge = window.desktop;
  }
  let value = cache.get(digest);
  if (!value) {
    value = window.desktop.readGeneratedFile(digest);
    value.catch(() => {
      if (cache.get(digest) === value) cache.delete(digest);
    });
    cache.set(digest, value);
    while (cache.size > maxCached) cache.delete(cache.keys().next().value!);
  }
  return value;
}

export function useGeneratedBytes() {
  const services = useConversationServices();
  const account = useContext(ArtifactAccountScope);
  return useCallback(
    (artifact: Artifact) => {
      if (services === desktopConversationServices)
        return readSnapshot(artifact, account.id);
      if (!artifact.blob || !artifact.sourceDigest)
        return Promise.reject(Error("This file has no saved snapshot."));
      return services.readGeneratedFile(artifact.sourceDigest);
    },
    [services, account.id],
  );
}

/** A data: URL for an image snapshot, or the error that prevented reading it. */
/** The saved file's type, from its name when it was saved without one. */
function typeOf(artifact: { mime?: string; name: string; filename?: string }) {
  if (artifact.mime && artifact.mime !== "application/octet-stream")
    return artifact.mime;
  const extension = /\.([a-z0-9]+)$/i
    .exec(artifact.filename ?? artifact.name)?.[1]
    ?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    pdf: "application/pdf",
  };
  return (extension && types[extension]) || "application/octet-stream";
}

export function useSnapshotUrl(artifact: Artifact): {
  url?: string;
  error?: string;
} {
  const read = useGeneratedBytes();
  const [state, setState] = useState<{
    url?: string;
    error?: string;
    read?: typeof read;
    digest?: string;
  }>({});
  useEffect(() => {
    let live = true;
    setState({});
    read(artifact).then(
      (base64) =>
        live &&
        setState({
          read,
          digest: artifact.sourceDigest,
          url: `data:${typeOf(artifact)};base64,${base64}`,
        }),
      (error) =>
        live &&
        setState({
          read,
          digest: artifact.sourceDigest,
          error:
            error instanceof Error
              ? error.message
              : "The file could not be read.",
        }),
    );
    return () => {
      live = false;
    };
    // Digest identifies the bytes; other fields do not change them.
  }, [artifact.sourceDigest, artifact.mime, artifact.blob, read]);
  return state.read === read && state.digest === artifact.sourceDigest
    ? state
    : {};
}
