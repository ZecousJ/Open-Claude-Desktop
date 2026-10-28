import { Suspense } from "react";
import type { Conversation } from "../../shared/types";
import { useApp } from "./AppContext";
import { forkConversation } from "./fork";
import {
  branchDraft,
  inheritedMessageCount,
  sideChatAvailability,
} from "../side-chat/side-chat-model";
import { closeSideChat, useSideChat } from "../side-chat/side-chat-store";
import { usePresence } from "../ui/usePresence";
import { lazyPiece } from "../ui/lazy-piece";

// The card and its styles load the first time a side chat opens.
const SideChatPanel = lazyPiece(
  () => import("../side-chat/SideChatPanel"),
  "SideChatPanel",
);

/** The card closes over 200ms (side-chat.css). */
const exitMs = 200;

/**
 * The open conversation's side chat, beside it (Chat and Code; opened by View ▸
 * Side Chat or ⌘;). It renders nothing until opened. Branch to new chat puts
 * the side question and its answer in the composer to carry on from: in Chat a
 * new, empty chat; in Code a fork of the session.
 */
export function SideChatHost({ active }: { active: Conversation }) {
  const app = useApp();
  const state = useSideChat(active.id);
  const available = sideChatAvailability(active, active.mode).available;
  const open = Boolean(state?.open) && available;
  const { mounted, state: presence } = usePresence(open, exitMs);
  if (!state || !mounted) return null;
  return (
    <Suspense fallback={null}>
      <SideChatPanel
        conversationId={active.id}
        state={state}
        mode={active.mode}
        platform={app.snapshot?.platform ?? ""}
        closing={presence === "closed"}
        branchReason={
          active.incognito ? "An incognito chat can't be forked." : undefined
        }
        inheritedMessageCount={inheritedMessageCount(active)}
        onClose={() => closeSideChat(active.id)}
        onBranch={(question, answer) => {
          if (active.mode === "chat") {
            app.newChat("chat", undefined, false, (created) => {
              if (created) app.setText(branchDraft(question, answer));
            });
            return;
          }
          void forkConversation(app).then((forked) => {
            if (forked) app.setText(branchDraft(question, answer));
          });
        }}
      />
    </Suspense>
  );
}
