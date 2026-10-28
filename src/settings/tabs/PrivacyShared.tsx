import { formatText, useLocale, t } from "../../i18n";
import { useContext, useEffect } from "react";
import { Trash2 } from "../../ui/glyphs";
import type { SharedArtifact } from "../../../shared/settings-api";
import type { HostedShare } from "../../../shared/sharing-api";
import { AppContext } from "../../app/AppContext";
import { LoadingRows, PrivacySubpage } from "../privacy-subpage";
import { toastName } from "../undoable-remove";
import {
  usePrivacyRead,
  usePrivacyRemove,
  type PrivacyOwner,
} from "../privacy-owner";
import { sharedArtifactsNote, sharedDate, sharedChatAudience } from "./Privacy";

/**
 * Privacy → Shared chats: Name (opens the shared page; who can open it
 * underneath), Date shared, Location (Open chat) and Unshare, which takes the
 * row away at once with Undo on the toast.
 */
export function SharedChatsPage({
  owner,
  onBack,
  onError,
}: {
  owner: PrivacyOwner;
  onBack: () => void;
  onError: (error: unknown) => void;
}) {
  useLocale();
  const app = useContext(AppContext);
  // A failed read shows "Error loading shared content" in place of the table.
  const shares = usePrivacyRead(
    owner,
    (bridge) => bridge.hostedShares("conversation"),
    () => {},
  );
  const { hidden, remove } = usePrivacyRemove(owner);
  useEffect(
    () =>
      owner.bridge?.onEvent((event) => {
        if (
          event.type === "sharing" &&
          (!event.kind || event.kind === "conversation")
        )
          void shares.reload();
      }),
    [],
  );
  // The chat a link was made from, when it is on this computer.
  const local = (share: HostedShare) =>
    share.sourceKey
      ? app?.listed.find((item) => item.id === share.sourceKey)
      : undefined;
  return (
    <PrivacySubpage title="Shared chats" onBack={onBack}>
      <SharedChatsTable
        items={shares.value?.filter((share) => !hidden.has(share.id))}
        failed={shares.failed}
        canOpenChat={(share) => Boolean(local(share))}
        onOpenShare={(share) =>
          owner.current() &&
          void owner.bridge?.openShare(share.id).catch((error) => {
            if (owner.current()) onError(error);
          })
        }
        onOpenChat={(share) => {
          const conversation = local(share);
          if (!conversation || !app || !owner.current()) return;
          app.setSettingsOpen(false);
          app.openConversation(conversation);
        }}
        onUnshare={(share) => {
          const name = toastName(share.title || t("Untitled"));
          remove(share.id, {
            title: formatText("Unsharing “{name}”…", { name }),
            doneTitle: formatText("Unshared “{name}”", { name }),
            commit: () => owner.bridge!.revokeShare(share.id),
            onDone: () => void shares.reload(),
            onFailed: () =>
              onError(
                new Error(
                  formatText(
                    "Couldn’t unshare “{name}”. Try again in Settings → Privacy → Shared chats.",
                    { name },
                  ),
                ),
              ),
          });
        }}
      />
    </PrivacySubpage>
  );
}

/** The Shared chats table for a state; split out so it renders without a window. */
export function SharedChatsTable({
  items,
  failed,
  canOpenChat,
  onOpenShare,
  onOpenChat,
  onUnshare,
}: {
  /** undefined while loading. */
  items: HostedShare[] | undefined;
  failed: boolean;
  canOpenChat: (share: HostedShare) => boolean;
  onOpenShare: (share: HostedShare) => void;
  onOpenChat: (share: HostedShare) => void;
  onUnshare: (share: HostedShare) => void;
}) {
  if (failed)
    return (
      <p className="privacy-subpage-state">Error loading shared content</p>
    );
  if (items && !items.length)
    return <p className="privacy-subpage-state">No shared content found</p>;
  return (
    <table className="privacy-table" aria-label="Shared chats">
      <thead>
        <tr>
          <th>Name</th>
          <th className="date">Date shared</th>
          <th className="location">Location</th>
          <th className="end">Unshare</th>
        </tr>
      </thead>
      <tbody aria-busy={!items || undefined}>
        {!items ? (
          <LoadingRows />
        ) : (
          items.map((share) => {
            const name = share.title || t("Untitled Conversation");
            const active = share.status === "active";
            return (
              <tr key={share.id}>
                <td className="name">
                  {active && share.url ? (
                    <button
                      type="button"
                      className="privacy-link strong"
                      title={name}
                      onClick={() => onOpenShare(share)}
                    >
                      <span data-no-translate>{name}</span>
                    </button>
                  ) : (
                    <span
                      className="privacy-name"
                      title={name}
                      data-no-translate
                    >
                      {name}
                    </span>
                  )}
                  <span
                    className={`privacy-audience${active ? "" : " removed"}`}
                  >
                    {t(sharedChatAudience(share))}
                  </span>
                </td>
                <td className="date">{sharedDate(share.createdAt)}</td>
                <td className="location">
                  {canOpenChat(share) ? (
                    <button
                      type="button"
                      className="privacy-link"
                      onClick={() => onOpenChat(share)}
                    >
                      Open chat
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="end">
                  <button
                    type="button"
                    className="shared-links-icon"
                    aria-label={formatText("Unshare {name}", { name })}
                    onClick={() => onUnshare(share)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

/**
 * Privacy → Shared artifacts: the same table with Date published and Unpublish.
 * Claudex's artifact links are not tied to a chat, so Location says where the
 * link opens: "Public" (the Claudex service) or "This computer".
 */
export function SharedArtifactsPage({
  owner,
  hosted,
  onBack,
  onError,
}: {
  hosted: boolean;
  owner: PrivacyOwner;
  onBack: () => void;
  onError: (error: unknown) => void;
}) {
  useLocale();
  const shared = usePrivacyRead(
    owner,
    (bridge) => bridge.sharedArtifacts(),
    () => {},
  );
  const { hidden, remove } = usePrivacyRemove(owner);
  useEffect(
    () =>
      owner.bridge?.onEvent((event) => {
        if (event.type === "sharing" || event.type === "artifact-shares")
          void shared.reload();
      }),
    [],
  );
  return (
    <PrivacySubpage
      title="Shared artifacts"
      description={sharedArtifactsNote(hosted)}
      onBack={onBack}
    >
      <SharedArtifactsTable
        items={shared.value?.filter((item) => !hidden.has(item.identity))}
        failed={shared.failed}
        onOpen={(item) => {
          if (item.url && owner.current())
            void Promise.resolve(owner.bridge!.openExternal(item.url)).catch(
              (error) => {
                if (owner.current()) onError(error);
              },
            );
        }}
        onUnpublish={(item) => {
          const name = toastName(item.title || t("Untitled artifact"));
          remove(item.identity, {
            title: formatText("Unpublishing “{name}”…", { name }),
            doneTitle: formatText("Unpublished “{name}”", { name }),
            commit: () => owner.bridge!.stopSharingArtifact(item.identity),
            onDone: () => void shared.reload(),
            onFailed: () =>
              onError(
                new Error(t("Artifact couldn’t be unpublished. Try again.")),
              ),
          });
        }}
      />
    </PrivacySubpage>
  );
}

/** The Shared artifacts table for a state. */
export function SharedArtifactsTable({
  items,
  failed,
  onOpen,
  onUnpublish,
}: {
  items: SharedArtifact[] | undefined;
  failed: boolean;
  onOpen: (item: SharedArtifact) => void;
  onUnpublish: (item: SharedArtifact) => void;
}) {
  if (failed)
    return (
      <p className="privacy-subpage-state">
        Couldn’t load shared content. Refresh and try again.
      </p>
    );
  if (items && !items.length)
    return <p className="privacy-subpage-state">No shared content found</p>;
  return (
    <table className="privacy-table" aria-label="Shared artifacts">
      <thead>
        <tr>
          <th>Name</th>
          <th className="date">Date published</th>
          <th className="location">Location</th>
          <th className="end">Unpublish</th>
        </tr>
      </thead>
      <tbody aria-busy={!items || undefined}>
        {!items ? (
          <LoadingRows rows={1} />
        ) : (
          items.map((item) => {
            const name = item.title || "Untitled artifact";
            return (
              <tr key={item.identity}>
                <td className="name">
                  {item.url ? (
                    <button
                      type="button"
                      className="privacy-link strong"
                      title={name}
                      onClick={() => onOpen(item)}
                    >
                      <span data-no-translate>{name}</span>
                    </button>
                  ) : (
                    <span
                      className="privacy-name"
                      title={name}
                      data-no-translate
                    >
                      {name}
                    </span>
                  )}
                </td>
                <td className="date">{sharedDate(item.createdAt)}</td>
                <td className="location">
                  {item.scope === "public" ? "Public" : "This computer"}
                </td>
                <td className="end">
                  <button
                    type="button"
                    className="shared-links-icon"
                    aria-label={formatText("Unpublish {name}", { name })}
                    onClick={() => onUnpublish(item)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
