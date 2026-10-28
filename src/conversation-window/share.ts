import { useEffect, useState, type ComponentType } from "react";
import type { SharingStatus } from "../../shared/sharing-api";
import type { Conversation } from "../../shared/types";
import { shareButtonStatus } from "./share-status";

/** What the Share chat / Share session dialog (R1-U1) takes. */
export type ShareDialogComponent = ComponentType<{
  conversation: Conversation;
  status: SharingStatus;
  onClose: () => void;
}>;

/**
 * The share dialog belongs to the main title bar (R1-U1,
 * src/ConversationShareDialog.tsx). The separate window opens the same
 * dialog; until that module is part of the build, the window has no Share
 * button rather than one that does nothing.
 */
const dialogModules = import.meta.glob<{
  ConversationShareDialog?: ShareDialogComponent;
}>("../ConversationShareDialog.tsx");

let dialog: Promise<ShareDialogComponent | undefined> | undefined;
export function loadShareDialog() {
  dialog ??= Promise.all(
    Object.values(dialogModules).map((load) =>
      load()
        .then((module) => module.ConversationShareDialog)
        .catch(() => undefined),
    ),
  ).then((found) => found.find(Boolean));
  return dialog;
}

/**
 * Whether this conversation can be shared from the window: see
 * shareButtonStatus, and the dialog is part of the build. Read again when
 * the account's shares change anywhere (the dialog, Privacy, another
 * window). The dialog itself shows whether the link is on.
 */
export function useConversationShare(conversation: Conversation) {
  const [state, setState] = useState<{
    status: SharingStatus | null;
    Dialog?: ShareDialogComponent;
  }>({ status: null });
  const { id, incognito } = conversation;
  useEffect(() => {
    const api = window.desktop;
    // Incognito content never leaves this computer.
    if (incognito || !api?.sharingStatus) return;
    let live = true;
    const read = async () => {
      try {
        const [status, Dialog] = await Promise.all([
          api.sharingStatus(),
          loadShareDialog(),
        ]);
        // An existing link keeps the button when sharing is turned off.
        const shared =
          Boolean(status && !status.conversations && Dialog) &&
          Boolean(await api.conversationShare(id).catch(() => null));
        const usable = Dialog ? shareButtonStatus(status, shared) : null;
        if (live) setState({ status: usable, Dialog });
      } catch {
        // A service that cannot be reached offers no Share button.
        if (live) setState({ status: null });
      }
    };
    void read();
    const off = api.onEvent((event) => {
      if (
        event.type === "sharing" &&
        (!event.kind || event.kind === "conversation") &&
        (!event.sourceKey || event.sourceKey === id)
      )
        void read();
    });
    return () => {
      live = false;
      off();
    };
  }, [id, incognito]);
  return state;
}
