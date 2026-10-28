import { useCallback, useEffect, useState } from "react";
import type { ArtifactShareInput } from "../../shared/types";
import type { ArtifactSharingState } from "../../shared/sharing-api";

/** The same audience record opened by ArtifactShareDialog, never a guessed
 * default while the service is loading or unavailable. */
export function artifactAccessLabel(state?: ArtifactSharingState) {
  if (!state) return undefined;
  const share = state.share;
  if (share?.status !== "active") return "Private";
  if ((share.access ?? "link") === "link") return "Anyone with the link";
  return share.invites?.length ? "Only people invited" : "Private";
}

export function useArtifactAccess(
  input: ArtifactShareInput,
  enabled: boolean,
  accountId: string,
) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    accountId: string;
    identity: string;
    language: string;
    content: string;
    state: ArtifactSharingState;
  }>();
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    setResult(undefined);
    if (!enabled || !window.desktop.artifactShareState) return;
    let alive = true;
    let request = 0;
    const read = () => {
      const current = ++request;
      void window.desktop.artifactShareState(input).then(
        (state) => {
          if (alive && current === request)
            setResult({
              accountId,
              identity: input.identity,
              language: input.language,
              content: input.content,
              state,
            });
        },
        () => {
          if (alive && current === request) setResult(undefined);
        },
      );
    };
    read();
    const off = window.desktop.onEvent?.((event) => {
      if (
        (event.type === "sharing" && event.kind !== "conversation") ||
        event.type === "artifact-shares" ||
        event.type === "service-changed"
      )
        read();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [
    enabled,
    accountId,
    input.identity,
    input.language,
    input.content,
    revision,
  ]);
  const current =
    enabled &&
    result &&
    result.accountId === accountId &&
    result.identity === input.identity &&
    result.language === input.language &&
    result.content === input.content
      ? result.state
      : undefined;
  return { label: artifactAccessLabel(current), refresh };
}
