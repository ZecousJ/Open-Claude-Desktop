import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { AppContext } from "../app/AppContext";

type Value = {
  status: SharingStatus | null | undefined;
  share: HostedShare | null | undefined;
  pending: boolean;
  failed?: boolean;
};

/** The trigger's capability/readiness, distinct from the model's running state. */
export function useConversationSharingStatus(conversation: Conversation) {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const owner = app?.accountId,
    controller = app?.controllerScope;
  const scope = useMemo(
    () => ({
      id: conversation.id,
      bridge,
      owner,
      controller,
      active: true,
      sequence: 0,
      value: { status: undefined, share: undefined, pending: true } as Value,
      target: conversation,
    }),
    [conversation.id, bridge, owner, controller],
  );
  scope.target = conversation;
  const latest = useRef(scope);
  latest.current = scope;
  const [stored, setStored] = useState(() => ({ scope, value: scope.value }));
  const value = stored.scope === scope ? stored.value : scope.value;
  scope.value = value;
  const current = () =>
    latest.current === scope &&
    scope.active &&
    (typeof window === "undefined" ? undefined : window.desktop) === bridge &&
    (!app?.currentController ||
      (app.currentController.current?.accountId === owner &&
        app.currentController.current?.controllerScope === controller));
  const publish = (next: Value) => {
    if (!current()) return;
    scope.value = next;
    setStored((old) => (current() ? { scope, value: next } : old));
  };
  useEffect(() => {
    scope.active = true;
    const read = async (resetCapabilities = false) => {
      const sequence = ++scope.sequence;
      if (scope.target.incognito || !bridge?.sharingStatus) {
        publish({ status: null, share: null, pending: false });
        return;
      }
      publish({
        ...scope.value,
        pending: resetCapabilities || scope.value.status === undefined,
        failed: false,
      });
      try {
        const status = await bridge.sharingStatus();
        if (!current() || sequence !== scope.sequence) return;
        // Capability/hydration readiness controls the trigger. The source
        // permits opening while the separate snapshot read is still pending.
        publish({ ...scope.value, status, pending: false });
        const share = status
          ? await bridge.conversationShare(scope.id).catch(() => undefined)
          : null;
        if (current() && sequence === scope.sequence)
          publish({
            status,
            share,
            pending: false,
            failed: Boolean(status && share === undefined),
          });
      } catch {
        if (current() && sequence === scope.sequence)
          publish(
            !resetCapabilities && scope.value.status
              ? { ...scope.value, pending: false, failed: true }
              : {
                  status: null,
                  share: null,
                  pending: false,
                  failed: true,
                },
          );
      }
    };
    void read();
    const off = bridge?.onEvent?.((event) => {
      if (
        event.type === "service-changed" ||
        (event.type === "sharing" &&
          (!event.kind || event.kind === "conversation") &&
          (!event.sourceKey || event.sourceKey === scope.id))
      )
        void read(event.type === "service-changed");
    });
    return () => {
      scope.active = false;
      scope.sequence++;
      off?.();
    };
  }, [scope, conversation.incognito]);

  const reason = () => {
    const now = scope.value,
      target = scope.target;
    if (target.incognito) return "Incognito chats can't be shared.";
    if (target.slim || now.pending) return "Available once loading finishes";
    if (now.status?.blocked) return "Sharing is disabled by your organization.";
    if (!now.status)
      return now.failed
        ? "Failed to check share status. You can try again."
        : "Sharing isn't available on this service";
    if (!now.status.conversations && !now.share && now.failed)
      return "Failed to check share status. You can try again.";
    if (!now.status.conversations && !now.share)
      return "Your administrator has turned off sharing.";
    if (
      !target.turns.some(
        (turn) =>
          turn.prompt.trim() || turn.attachments?.length || turn.items.length,
      )
    )
      return "There's nothing in this chat to share yet.";
    return undefined;
  };
  return {
    ...value,
    disabledReason: reason(),
    ready: !reason(),
    canOpen: () => current() && !reason(),
  };
}
