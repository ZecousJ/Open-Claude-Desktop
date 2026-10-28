import { formatText, t, useT } from "../i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Globe,
  Link,
  Lock,
  Settings2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  X,
} from "../ui/glyphs";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import type { AccountProfile } from "../../shared/settings-api";
import { Menu } from "../ui/Menu";
import { SkeletonGroup } from "../ui/Skeleton";
import { useFocusReturn } from "../ui/dialog-stack";
import { shareDate } from "./share-date";
import type { ShareDialogState } from "./ConversationShareDialog";
import "./chat-share.css";
import {
  conversationShareUrl,
  conversationShareWritable,
} from "../sharing/share-link";
import { ShareEmailCombobox } from "../sharing/ShareEmailCombobox";

/** What the access row says for a chat's link. */
export function accessLabel(share: HostedShare | null | undefined) {
  return share?.status === "active" && share.access !== "invited"
    ? "Anyone with the link"
    : "Only people invited";
}

/**
 * Whether Copy link can work: a link exists, or one can be made (sharing
 * is on for the account). Not while the share is still being read.
 */
export function copyAllowed(
  share: HostedShare | null | undefined,
  canShare: boolean,
) {
  if (share === undefined) return false;
  return share ? Boolean(conversationShareUrl(share)) : canShare;
}

/**
 * Share chat: a 480px popover under the header with the title and a close
 * button, "Only messages up until now will be shared", the invite field, "Who
 * has access" with the access row and the owner, the usage note, and the
 * settings button beside a black Copy link. The access row opens "Share chat
 * settings", where the access is chosen: Only people invited or Anyone with the
 * link. Invitations use the service's real email protocol; no organization
 * directory is invented.
 */
export function ChatSharePopover({
  status,
  state,
  onClose,
  onAccess,
  onInvite,
  onUninvite,
  onCopy,
  onUpdate,
  onUsagePolicy,
  onRetry,
}: {
  status: SharingStatus;
  state: ShareDialogState;
  onClose: () => void;
  onAccess: (access: "link" | "invited") => void;
  /** Resolves true when the invitation stands (the field is emptied). */
  onInvite: (email: string) => Promise<boolean>;
  onUninvite: (email: string) => void;
  onCopy: () => void;
  onUpdate: () => void;
  onUsagePolicy: (url: string) => void;
  onRetry?: () => void;
}) {
  useT();
  // Closing gives the focus back to the Share button (a popover's return).
  useFocusReturn();
  const [view, setView] = useState<"main" | "settings">("main");
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const [profile, setProfile] = useState<{
    bridge: typeof bridge;
    account?: AccountProfile;
  }>();
  const account =
    profile && profile.bridge === bridge ? profile.account : undefined;
  const [choosing, setChoosing] = useState(false);
  /** The access chosen in the settings view, applied by Save. */
  const [pending, setPending] = useState<"link" | "invited">();
  const box = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLButtonElement>(null);
  const accessLabelId = useId(),
    accessValueId = useId();
  useLayoutEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);
  const { share, busy, copied, error, notice } = state;
  // Initial absence differs from a background read of a known share.
  // The source keeps the recipient editor mounted during the latter.
  const loading = share === undefined && !state.checkFailed;
  // "Anyone with the link": a public share; anything else reaches invited people only.
  const shared = share?.status === "active" && share.access !== "invited";
  const invites = share?.invites ?? [];
  const canInvite = conversationShareWritable(status, share);
  const publicAllowed = canInvite;
  useEffect(() => {
    let live = true;
    void Promise.resolve(bridge?.accountProfile?.())
      .then((account) => {
        if (live && window.desktop === bridge) setProfile({ bridge, account });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);
  // Closes on Escape and on a press outside, as a popover does.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !choosing) onClose();
    };
    const press = (event: MouseEvent) => {
      // The access menu is on <body>, outside this box: a press on one of
      // its options must not close the popover under it (as Escape, above).
      if (choosing) return;
      // The main trigger toggles this popup itself (shared16 G/handleShareClick).
      if (
        (event.target as Element | null)?.closest?.(
          ".conversation-share-trigger",
        )
      )
        return;
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", press);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", press);
    };
  }, [choosing, onClose]);
  const name = account?.fullName || account?.email?.split("@")[0] || "You";
  const policy = status.usagePolicyUrl;
  const [policyBefore, policyAfter] = t(
    "Don’t share personal information or third-party content without permission, and see our {usagePolicy}.",
  ).split("{usagePolicy}");
  const accessIcon = (link: boolean) =>
    link ? (
      <Globe size={20} strokeWidth={1.5} aria-hidden="true" />
    ) : (
      <Lock size={20} strokeWidth={1.5} aria-hidden="true" />
    );
  const chosen = pending ?? (shared ? "link" : "invited");
  const openSettings = () => {
    setPending(undefined);
    setView("settings");
  };
  return (
    <div
      ref={box}
      className="chat-share"
      role="dialog"
      tabIndex={-1}
      aria-label={view === "main" ? "Share session" : "Share chat settings"}
      aria-busy={loading || busy}
    >
      {view === "main" ? (
        <>
          <header>
            <h2>Share session</h2>
            <button
              type="button"
              className="chat-share-icon"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={20} strokeWidth={1.5} />
            </button>
          </header>
          <p className="chat-share-sub">
            Only messages up until now will be shared
          </p>
          {loading ? (
            <SkeletonGroup className="chat-share-loading" label={t("Loading")}>
              <div aria-hidden="true">
                <div className="chat-share-loading-invite">
                  <i className="sk" />
                  <i className="sk" />
                </div>
                <i className="sk chat-share-loading-label" />
                <div className="chat-share-loading-access">
                  <i className="sk" />
                  <i className="sk" />
                </div>
                <div className="chat-share-loading-person">
                  <i className="sk" />
                  <span>
                    <i className="sk" />
                    <i className="sk" />
                  </span>
                </div>
                <div className="chat-share-loading-note">
                  <i className="sk" />
                  <i className="sk" />
                </div>
                <div className="chat-share-loading-actions">
                  <i className="sk" />
                  <i className="sk" />
                </div>
              </div>
            </SkeletonGroup>
          ) : share === undefined && state.checkFailed ? (
            <div className="chat-share-check-error">
              <p className="chat-share-error" role="alert">
                {error}
              </p>
              {onRetry && (
                <button
                  type="button"
                  className="chat-share-retry"
                  onClick={onRetry}
                >
                  Try again
                </button>
              )}
            </div>
          ) : (
            <>
              <ShareEmailCombobox
                disabled={!canInvite || loading || Boolean(state.checkFailed)}
                busy={busy}
                existing={invites}
                onInvite={onInvite}
              />
              {!canInvite && (
                <p className="chat-share-notice" role="note">
                  {share?.status === "disabled"
                    ? share.disabledReason || t("Removed by the administrator")
                    : t(
                        status.blocked
                          ? "Sharing is disabled by your organization."
                          : "Your administrator has turned off sharing.",
                      )}
                </p>
              )}
              <div className="chat-share-label" id={accessLabelId}>
                Who has access
              </div>
              <button
                type="button"
                className="chat-share-access"
                aria-labelledby={`${accessLabelId} ${accessValueId}`}
                disabled={loading || busy}
                onClick={openSettings}
              >
                <span className="chat-share-access-icon">
                  {accessIcon(shared)}
                </span>
                <span id={accessValueId}>{accessLabel(share)}</span>
                <ChevronRight
                  size={16}
                  strokeWidth={1.5}
                  className="chat-share-chevron"
                  aria-hidden="true"
                />
              </button>
              <div className="chat-share-person">
                <span className="chat-share-avatar" aria-hidden="true">
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <span className="chat-share-who">
                  <span>
                    <span data-no-translate>{name}</span> <em>(you)</em>
                  </span>
                  {account?.email && (
                    <small data-no-translate>{account.email}</small>
                  )}
                </span>
                <span className="chat-share-role">Owner</span>
              </div>
              {invites.map((email) => (
                <div className="chat-share-person" key={email}>
                  <span className="chat-share-avatar" aria-hidden="true">
                    {email.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="chat-share-who">
                    <span data-no-translate>{email}</span>
                  </span>
                  <span className="chat-share-role">Can view</span>
                  <button
                    type="button"
                    className="chat-share-icon remove"
                    aria-label={formatText("Remove {name}", { name: email })}
                    disabled={busy}
                    onClick={() => onUninvite(email)}
                  >
                    <X size={16} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
              {notice && (
                <p className="chat-share-notice" role="status">
                  {notice}
                </p>
              )}
              {share?.stale && (
                <p className="chat-share-stale">
                  <span data-no-translate>
                    {formatText(
                      "Shared on {date}. New messages aren't included.",
                      {
                        date: shareDate(share.snapshotAt),
                      },
                    )}
                  </span>
                  {canInvite && (
                    <>
                      {" "}
                      <button type="button" disabled={busy} onClick={onUpdate}>
                        Update link
                      </button>
                    </>
                  )}
                </p>
              )}
              {error && (
                <p className="chat-share-error" role="alert">
                  {error}
                </p>
              )}
              {state.checkFailed && onRetry && (
                <button
                  type="button"
                  className="chat-share-retry"
                  onClick={onRetry}
                >
                  Try again
                </button>
              )}
              <p className="chat-share-note">
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
              <div className="chat-share-actions">
                <button
                  type="button"
                  className="chat-share-icon settings"
                  aria-label="Share settings"
                  disabled={loading || busy}
                  onClick={openSettings}
                >
                  <Settings2 size={20} strokeWidth={1.5} />
                </button>
                {/* With nothing shared yet, Copy link makes a link only the
                   people invited can open and copies it. */}
                <button
                  type="button"
                  className="chat-share-copy"
                  disabled={!copyAllowed(share, canInvite) || busy || loading}
                  title={
                    copyAllowed(share, canInvite)
                      ? undefined
                      : "Your administrator has turned off sharing chats."
                  }
                  onClick={onCopy}
                >
                  <Link size={20} strokeWidth={1.5} aria-hidden="true" />
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <header>
            <button
              type="button"
              className="chat-share-icon back"
              aria-label="Back"
              onClick={() => setView("main")}
            >
              <ChevronLeft size={20} strokeWidth={1.5} />
            </button>
            <h2>Share chat settings</h2>
            <button
              type="button"
              className="chat-share-icon"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={20} strokeWidth={1.5} />
            </button>
          </header>
          <div className="chat-share-label settings">Who has access</div>
          <button
            ref={select}
            type="button"
            className="chat-share-select"
            aria-haspopup="listbox"
            aria-expanded={choosing}
            disabled={loading || busy || !publicAllowed}
            onClick={() => setChoosing(!choosing)}
          >
            {accessIcon(chosen === "link")}
            <span>
              {chosen === "link"
                ? "Anyone with the link"
                : "Only people invited"}
            </span>
            <ChevronDown
              size={16}
              strokeWidth={1.5}
              className="chat-share-chevron"
              aria-hidden="true"
            />
          </button>
          {choosing && select.current && (
            <Menu
              label="Who has access"
              width={select.current.getBoundingClientRect().width}
              position={{
                left: select.current.getBoundingClientRect().left,
                top: select.current.getBoundingClientRect().bottom + 4,
              }}
              anchors={[select]}
              entries={[
                {
                  label: "Only people invited",
                  icon: <Lock size={20} strokeWidth={1.5} />,
                  checked: chosen === "invited",
                  onSelect: () => setPending("invited"),
                },
                {
                  label: "Anyone with the link",
                  icon: <Globe size={20} strokeWidth={1.5} />,
                  checked: chosen === "link",
                  disabled: !publicAllowed,
                  onSelect: () => setPending("link"),
                },
              ]}
              onClose={() => setChoosing(false)}
            />
          )}
          {!publicAllowed && (
            <p className="chat-share-note">
              {t(
                status.blocked
                  ? "Your administrator has turned off sharing for your account."
                  : "Your administrator has turned off sharing.",
              )}
            </p>
          )}
          {error && (
            <p className="chat-share-error" role="alert">
              {error}
            </p>
          )}
          <div className="chat-share-actions settings">
            <button
              type="button"
              className="chat-share-secondary"
              onClick={() => setView("main")}
            >
              Back
            </button>
            <button
              type="button"
              className="chat-share-copy"
              disabled={loading || busy || !publicAllowed}
              onClick={() => {
                if (chosen !== (shared ? "link" : "invited")) onAccess(chosen);
                setView("main");
              }}
            >
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}
