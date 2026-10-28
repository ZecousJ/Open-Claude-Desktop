import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ArtifactShareInput } from "../../shared/types";
import type {
  ArtifactPublication,
  HostedShare,
  SharingStatus,
} from "../../shared/sharing-api";

/**
 * Publish: whether the shown version of an artifact has a public link on the
 * Claudex service. The modal itself loads lazily (PublishArtifactModal).
 */

/**
 * What the Claudex service allows for hosted sharing, or null when it has
 * none (local account, service without it, turned off, unreachable). Read
 * again when the service or the account's links change.
 */
export function useSharingStatus(): SharingStatus | null {
  return useSyncExternalStore(subscribeStatus, statusSnapshot, noStatus);
}

// One reading for every component that asks (the transcript's artifact
// cards each do): read when the first subscribes, again when the service
// or the account's links change, dropped when the last one leaves.
let status: SharingStatus | null = null;
let statusRequest = 0;
const statusListeners = new Set<() => void>();
let statusOff: (() => void) | undefined;
const statusSnapshot = () => status;
const noStatus = () => null;
function readStatus() {
  const desktop = typeof window === "undefined" ? undefined : window.desktop;
  if (!desktop?.sharingStatus) return;
  const id = ++statusRequest;
  const settle = (value: SharingStatus | null) => {
    if (id !== statusRequest || value === status) return;
    status = value;
    for (const listener of statusListeners) listener();
  };
  void desktop
    .sharingStatus()
    .then((value) => settle(value ?? null))
    .catch(() => settle(null));
}
function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  if (statusListeners.size === 1) {
    readStatus();
    statusOff = window.desktop?.onEvent?.((event) => {
      if (event.type === "service-changed" || event.type === "sharing")
        readStatus();
    });
  }
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size) return;
    statusOff?.();
    statusOff = undefined;
    statusRequest++;
  };
}

/** The account's newest hosted link of an artifact (active or taken down), if any. */
export async function hostedArtifactShare(
  identity: string,
): Promise<HostedShare | undefined> {
  const shares = await window.desktop.hostedShares("artifact");
  return shares.find((share) => share.sourceKey === identity);
}

/**
 * Whether the version's publication could be read: Publish waits while it
 * is read and stays off when it could not be (the reference's
 * `publishCheck`).
 */
export type PublishCheck = "pending" | "failed" | "ok";

/** Why Publish is off after the version's check failed. */
export const publishCheckFailedReason =
  "Couldn’t check whether this artifact is already published. Reload the page to try again.";
/** Why Publish is off for a version that was unpublished. */
export const previouslyUnpublishedReason =
  "This artifact was previously unpublished. Create a new artifact to publish again.";

/** How long the content must settle before its publication is read again. */
const settleMs = 300;

/**
 * The publication of one version (`input`'s content), read again when the
 * account's links change. `enabled` false (no hosted artifact links, a
 * binary file) reads nothing.
 */
export function useArtifactPublication(
  input: ArtifactShareInput,
  enabled: boolean,
): {
  check: PublishCheck;
  publication: ArtifactPublication | null;
  refresh: () => void;
} {
  const [state, setState] = useState<{
    check: PublishCheck;
    publication: ArtifactPublication | null;
  }>({ check: "pending", publication: null });
  const latest = useRef(input);
  latest.current = input;
  const request = useRef(0);
  const read = useCallback(() => {
    const desktop = typeof window === "undefined" ? undefined : window.desktop;
    if (!desktop?.artifactPublication) return;
    const id = ++request.current;
    void desktop
      .artifactPublication(latest.current)
      .then((publication) => {
        if (id === request.current)
          setState({ check: "ok", publication: publication ?? null });
      })
      .catch(() => {
        if (id === request.current)
          setState({ check: "failed", publication: null });
      });
  }, []);
  const { identity, title, language, content } = input;
  const readFor = useRef<string>(undefined);
  useEffect(() => {
    if (!enabled) {
      request.current++;
      readFor.current = undefined;
      setState({ check: "pending", publication: null });
      return;
    }
    // Another artifact is checked at once; a version of the same one once
    // its content settles, keeping what was known meanwhile.
    const other = readFor.current !== identity;
    readFor.current = identity;
    if (other) setState({ check: "pending", publication: null });
    const timer = setTimeout(read, other ? 0 : settleMs);
    const off = window.desktop?.onEvent?.((event) => {
      if (
        (event.type === "sharing" && event.kind !== "conversation") ||
        event.type === "service-changed"
      )
        read();
    });
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [enabled, identity, title, language, content, read]);
  return { ...state, refresh: read };
}
