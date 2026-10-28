import { formatText, t, useT } from "../i18n";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ShieldCheck, SquareArrowOutUpRight, Check } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import type { Conversation } from "../../shared/types";
import { useConversationShare } from "../sharing/useConversationShare";
export { useConversationShare } from "../sharing/useConversationShare";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { Modal } from "../ui/Controls";
import { api } from "../desktop-api";
import { conversationTexts, scanSecrets } from "../../shared/secret-scan";
import { showToast } from "../ui/toast-store";
import { lazyPiece } from "../ui/lazy-piece";
const ChatSharePopover = lazyPiece(
  () => import("./ChatSharePopover"),
  "ChatSharePopover",
);

/**
 * Share chat / Share session (package R1-U1, design R1 4.1). The Code
 * dialog follows R-Code-会话分享弹层 (512 wide, Private / Public rows, the
 * Usage Policy note and the repository warning); the Chat title, the public
 * link row, the stale snapshot line and the stop-sharing confirmation have
 * no capture and are provisional. Sharing uploads a snapshot of the chat to
 * the Claudex service (electron/hosted-shares.ts); Private stops the link.
 * Styles: conversation-share.css, loaded by ConversationHeaderHost.
 */

export type ShareTarget = Pick<
  Conversation,
  "id" | "title" | "mode" | "cwd" | "environment" | "incognito" | "slim"
>;

/** The dialog's title and the line under it. */
export function shareDialogText(mode: Conversation["mode"]) {
  return mode !== "code"
    ? { title: "Share session", subtitle: "Share a snapshot of this chat." }
    : {
        title: "Share session",
        subtitle: "Showcase your work and how you code with Claudex.",
      };
}

import { shareDate } from "./share-date";
export { shareDate };

/** What the Public row says under its title. */
export function publicDescription(
  status: SharingStatus,
  share: HostedShare | null,
  requireRepositoryAccess = false,
) {
  if (share?.status === "disabled") return "Removed by the administrator";
  if (!share && status.blocked)
    return "Your administrator has turned off sharing for your account.";
  if (!share && !status.conversations)
    return "Your administrator has turned off sharing.";
  // Account → Require repository access.
  return requireRepositoryAccess
    ? "Anyone with repository access and the link can view"
    : "Anyone with the link can view";
}

export interface ShareDialogState {
  /** undefined while the conversation's link is being read. */
  share: HostedShare | null | undefined;
  busy: boolean;
  confirmStop: boolean;
  copied: boolean;
  error?: string;
  /** What the last invitation did, in words ("Invitation sent to …"). */
  notice?: string;
  /** The session's folder is a Git repository. */
  repository: boolean;
  /** A fresh service read is pending, or its last check failed. */
  checking?: boolean;
  checkFailed?: boolean;
  /** The session holds what looks like a credential (it can still be shared). */
  secrets?: boolean;
  /** The account asks for repository access to open a shared session. */
  requireRepositoryAccess?: boolean;
}

/**
 * The dialog's content for a state; `ConversationShareDialog` supplies the
 * state and the actions. Split out so the states render without a window.
 */
export function ConversationShareView({
  conversation,
  status,
  state,
  onPublic,
  onPrivate,
  onCopy,
  onUpdate,
  onUsagePolicy,
  onOpenLink,
}: {
  conversation: ShareTarget;
  status: SharingStatus;
  state: ShareDialogState;
  onPublic: () => void;
  onPrivate: () => void;
  /** Kept for callers; Private stops the link at once. */
  onStop?: () => void;
  onCancelStop?: () => void;
  onCopy: () => void;
  onUpdate: () => void;
  onUsagePolicy: (url: string) => void;
  /** The link, opened in a new tab. */
  onOpenLink?: (url: string) => void;
}) {
  useT();
  const { share, busy, copied, error, repository } = state;
  const loading = share === undefined;
  const shared = Boolean(share);
  const active = share?.status === "active";
  const publicAllowed = shared || status.conversations;
  const text = shareDialogText(conversation.mode);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (index: number) => (index === 0 ? onPrivate() : onPublic());
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    const index = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : 0;
    rows.current[index]?.focus();
  }
  const option = (
    index: number,
    selected: boolean,
    disabled: boolean,
    icon: ReactNode,
    title: string,
    description: string,
  ) => (
    <button
      ref={(node) => {
        rows.current[index] = node;
      }}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={selected ? 0 : -1}
      className={`share-option${selected ? " selected" : ""}`}
      onClick={() => {
        if (!disabled && !selected) choose(index);
      }}
    >
      <span className="share-option-icon">{icon}</span>
      <span className="share-option-text">
        <span className="share-option-title">{t(title)}</span>
        <span className="share-option-description">{t(description)}</span>
      </span>
      {selected && <Check className="share-option-check" size={16} />}
    </button>
  );
  const policy = status.usagePolicyUrl;
  // One sentence with the link inside it, so each language orders it its own
  // way.
  const [policyBefore, policyAfter] = t(
    "Don’t share personal information or third-party content without permission, and see our {usagePolicy}.",
  ).split("{usagePolicy}");
  return (
    <div className="conversation-share" aria-busy={loading || busy}>
      <p className="share-subtitle">{t(text.subtitle)}</p>
      <div
        className={`share-options${loading ? " loading" : ""}`}
        role="radiogroup"
        aria-label={t("Share visibility")}
        onKeyDown={keyDown}
      >
        {option(
          0,
          !shared,
          loading || busy,
          <ShieldCheck size={14} strokeWidth={1.6} />,
          "Private",
          "Only you have access",
        )}
        {option(
          1,
          shared,
          loading || busy || !publicAllowed,
          <SquareArrowOutUpRight size={14} strokeWidth={1.6} />,
          "Public",
          loading
            ? "Anyone with the link can view"
            : publicDescription(
                status,
                share ?? null,
                state.requireRepositoryAccess,
              ),
        )}
      </div>
      {active && share && (
        <div className="share-link">
          {share.stale && (
            <p className="share-stale">
              <span data-no-translate>
                {formatText("Shared on {date}. New messages aren't included.", {
                  date: shareDate(share.snapshotAt),
                })}
              </span>
              {status.conversations && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="share-text-button"
                    disabled={busy}
                    onClick={onUpdate}
                  >
                    Update link
                  </button>
                </>
              )}
            </p>
          )}
          {/* The link opens in a new tab; Copy link is primary, then Copied
             secondary. */}
          <div className="share-link-row">
            <button
              type="button"
              className="share-link-open"
              title={share.url}
              onClick={() => onOpenLink?.(share.url)}
            >
              <span data-no-translate>{share.url}</span>
              <SquareArrowOutUpRight size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`share-copy ${copied ? "secondary" : "primary"}`}
              disabled={busy}
              onClick={onCopy}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="share-error" role="alert">
          {error}
        </p>
      )}
      {/* The live dialog drops the note once the session is shared. */}
      {!shared && (
        <p className="share-note">
          {policy ? (
            <>
              {policyBefore}
              <a
                href={policy}
                onClick={(event) => {
                  event.preventDefault();
                  onUsagePolicy(policy);
                }}
              >
                {t("Usage Policy")}
              </a>
              {policyAfter}
            </>
          ) : (
            t(
              "Don’t share personal information or third-party content without permission.",
            )
          )}
        </p>
      )}
      {state.secrets && (
        <div className="share-warning" role="status">
          <AppIcon name="Warning" size={15} strokeWidth={1.7} />
          <span>{t("This session may include secure credentials.")}</span>
        </div>
      )}
      {repository && (
        <div className="share-warning" role="note">
          <AppIcon name="Warning" size={15} strokeWidth={1.7} />
          <span>
            This session is from a local repository. Sharing may expose code to
            anyone with the link.
          </span>
        </div>
      )}
    </div>
  );
}

/** Share chat / Share session over the window, for the open conversation. */
export function ConversationShareDialog({
  conversation,
  status,
  capabilityPending = false,
  onClose,
}: {
  conversation: ShareTarget;
  status: SharingStatus;
  capabilityPending?: boolean;
  onClose: () => void;
}) {
  const link = useConversationShare(
    conversation,
    capabilityPending ? undefined : status,
  );
  // Looked for in what the session said and ran; sharing is not stopped by it.
  const secrets = useMemo(
    () =>
      conversation.mode === "code" &&
      scanSecrets(conversationTexts(conversation as Conversation)).length > 0,
    [conversation],
  );
  const [requireRepositoryAccess, setRequireRepositoryAccess] = useState(false);
  useEffect(() => {
    if (conversation.mode !== "code") return;
    let live = true;
    void Promise.resolve()
      .then(() => api.codeSharingSettings())
      .then((settings) => {
        if (live) setRequireRepositoryAccess(settings.requireRepositoryAccess);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversation.mode]);
  const state = {
    ...(capabilityPending
      ? { ...link.state, busy: true, checking: true }
      : link.state),
    secrets,
    requireRepositoryAccess,
  };
  // Chat shares from a popover under the header.
  if (conversation.mode !== "code")
    return (
      <Suspense fallback={null}>
        <ChatSharePopover
          status={status}
          state={state}
          onClose={onClose}
          onAccess={(mode) => void link.setAccess(mode)}
          onInvite={link.invite}
          onUninvite={(email) => void link.uninvite(email)}
          onCopy={() => {
            const shared = state.share;
            if (shared)
              void link.copy(
                shared.access === "invited"
                  ? (shared.inviteUrl ?? shared.url)
                  : shared.url,
              );
            else if (shared === null) void link.copyNew();
          }}
          onUpdate={() => void link.share(false)}
          onUsagePolicy={link.openPolicy}
          onRetry={() => void link.reload()}
        />
      </Suspense>
    );
  const text = shareDialogText(conversation.mode);
  return (
    <Modal title={text.title} onClose={onClose}>
      <ConversationShareView
        conversation={conversation}
        status={status}
        state={state}
        onPublic={() =>
          void link.share(false).then((done) => {
            if (done)
              showToast(
                t(
                  requireRepositoryAccess
                    ? "Shared session. Visible to anyone with repository access and the link."
                    : "Shared session. Visible to anyone with the link.",
                ),
              );
          })
        }
        onPrivate={() => void link.stop()}
        onCopy={() => state.share && void link.copy(state.share.url)}
        onUpdate={() => void link.share(false)}
        onUsagePolicy={link.openPolicy}
        onOpenLink={link.openPolicy}
      />
    </Modal>
  );
}

// The bridge already drops Electron's "Error invoking remote method" prefix.
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
