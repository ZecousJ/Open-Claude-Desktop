import { useEffect, useState } from "react";
import type { HostedShare } from "../../../shared/sharing-api";

/** The conversations with a live link, by id (a share made elsewhere has no known source). */
export function sharedConversationIds(shares: HostedShare[]) {
  return new Set(
    shares
      .filter((share) => share.status === "active" && share.sourceKey)
      .map((share) => share.sourceKey),
  );
}

/**
 * Which conversations the account has shared, kept current while `enabled`.
 * Empty where the service hosts no sharing.
 */
export function useSharedConversationIds(enabled: boolean) {
  return useSharedConversations(enabled).ids;
}

/**
 * The same ids and whether the first answer is still on its way: the chats
 * page's Shared tab waits for it instead of saying nothing is shared.
 */
export function useSharedConversations(enabled: boolean) {
  const [state, setState] = useState<{
    ids: ReadonlySet<string>;
    pending: boolean;
  }>(() => ({ ids: new Set(), pending: true }));
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () =>
      void Promise.resolve()
        .then(() => window.desktop.hostedShares("conversation"))
        .then(
          (shares) =>
            live &&
            setState({ ids: sharedConversationIds(shares), pending: false }),
          () => live && setState({ ids: new Set(), pending: false }),
        );
    read();
    const off = window.desktop.onEvent((event) => {
      if (
        event.type === "sharing" &&
        (!event.kind || event.kind === "conversation")
      )
        read();
    });
    return () => {
      live = false;
      off();
    };
  }, [enabled]);
  return enabled ? state : { ids: state.ids, pending: false };
}
