import { Fragment, useContext, useState } from "react";
import type {
  UploadedFileItem,
  UploadedFilesPage,
} from "../../../shared/privacy-data-api";
import { AppContext } from "../../app/AppContext";
import { currentLocale, formatText, t, useLocale } from "../../i18n";
import { ChevronDown, ChevronRight, Trash2 } from "../../ui/glyphs";
import type { PrivacyOwner } from "../privacy-owner";
import { usePrivacyRead, usePrivacyRemove } from "../privacy-owner";
import { LoadingRows, PrivacySubpage } from "../privacy-subpage";
import { toastName } from "../undoable-remove";

/** "17 KB", "21.1 KB", "17.9 MB" as the live list writes sizes (one
 * decimal, a whole number without it). */
function fileSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit ? Math.round(value * 10) / 10 : value;
  return `${rounded} ${units[unit]}`;
}

/**
 * Privacy → Uploaded files: "← Privacy", the title and what deleting does, then
 * Name (with its size under it), Uploaded, Surface, Location ("1 chat", or —
 * when no chat holds it), the trash, and a chevron that lists the chats.
 * Deleting is the same undoable removal as Shared chats ("Deleting “…”…" with
 * Undo). The list is the attachment copies this host stores for the account.
 */
export default function UploadedFilesManager({
  owner,
  onBack,
  onError,
}: {
  owner: PrivacyOwner;
  onBack(): void;
  onError(error: unknown): void;
}) {
  useLocale();
  const app = useContext(AppContext);
  const files = usePrivacyRead(
    owner,
    async (bridge) => {
      const items: UploadedFileItem[] = [];
      let page: UploadedFilesPage | undefined;
      do {
        page = await bridge.uploadedFiles(
          page?.nextCursor ? { cursor: page.nextCursor } : undefined,
        );
        items.push(...page.items);
      } while (page.nextCursor);
      return items;
    },
    () => {},
  );
  const { hidden, remove } = usePrivacyRemove(owner);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openChat = (conversationId: string) => {
    const conversation = app?.listed.find((item) => item.id === conversationId);
    if (!conversation || !app || !owner.current()) return;
    app.setSettingsOpen(false);
    app.openConversation(conversation);
  };
  const items = files.value?.filter((item) => !hidden.has(item.id));
  return (
    <PrivacySubpage
      title="Uploaded files"
      description={t(
        "Deleting a file removes it from storage. Text already extracted into a chat isn’t removed. To fully remove it, delete the chat.",
      )}
      onBack={onBack}
    >
      {files.failed ? (
        <p className="privacy-subpage-state">
          {t("Couldn’t load uploaded files. Refresh and try again.")}
        </p>
      ) : items && !items.length ? (
        <p className="privacy-subpage-state">{t("No uploaded files found")}</p>
      ) : (
        <table
          className="privacy-table privacy-uploads"
          aria-label={t("Uploaded files")}
        >
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th className="uploaded">{t("Uploaded")}</th>
              <th className="surface">{t("Surface")}</th>
              <th className="location">{t("Location")}</th>
              <th className="delete">{t("Delete")}</th>
              <th className="expand">
                <span className="sr-only">{t("Expand")}</span>
              </th>
            </tr>
          </thead>
          <tbody aria-busy={!items || undefined}>
            {!items ? (
              <LoadingRows cells={6} />
            ) : (
              items.map((item) => {
                const expanded = open.has(item.id);
                const chats = item.locations.length;
                return (
                  <Fragment key={item.id}>
                    <tr>
                      <td className="name">
                        <span className="privacy-file">
                          <span
                            className="privacy-name"
                            title={item.name}
                            data-no-translate
                          >
                            {item.name}
                          </span>
                          <span className="privacy-size">
                            {fileSize(item.bytes)}
                          </span>
                        </span>
                      </td>
                      <td className="uploaded">
                        {item.uploadedAt === null
                          ? "—"
                          : new Date(item.uploadedAt).toLocaleDateString(
                              currentLocale(),
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                      </td>
                      <td className="surface">
                        <span className="privacy-badge">
                          {item.surface === "code" ? t("Code") : t("Chat")}
                        </span>
                      </td>
                      <td className="location">
                        {chats
                          ? chats === 1
                            ? t("1 chat")
                            : formatText("{count} chats", { count: chats })
                          : "—"}
                      </td>
                      <td className="delete">
                        <button
                          type="button"
                          className="shared-links-icon"
                          aria-label={formatText("Delete {name}", {
                            name: item.name,
                          })}
                          onClick={() => {
                            const name = toastName(item.name);
                            remove(item.id, {
                              title: formatText("Deleting “{name}”…", { name }),
                              doneTitle: formatText("Deleted “{name}”", {
                                name,
                              }),
                              commit: () =>
                                owner.bridge!.deleteUploadedFile(item.id),
                              onDone: () => void files.reload(),
                              onFailed: onError,
                            });
                          }}
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                        </button>
                      </td>
                      <td className="expand">
                        {chats > 0 && (
                          <button
                            type="button"
                            className="shared-links-icon privacy-expand"
                            aria-expanded={expanded}
                            aria-label={formatText(
                              expanded
                                ? "Hide chats for {name}"
                                : "Show chats for {name}",
                              { name: item.name },
                            )}
                            onClick={() => toggle(item.id)}
                          >
                            {expanded ? (
                              <ChevronDown size={14} strokeWidth={1.75} />
                            ) : (
                              <ChevronRight size={14} strokeWidth={1.75} />
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="privacy-chats">
                        <td colSpan={6}>
                          <ul>
                            {item.locations.map((location, index) => (
                              <li key={location.conversationId}>
                                <button
                                  type="button"
                                  className="privacy-link"
                                  title={location.title || undefined}
                                  onClick={() =>
                                    openChat(location.conversationId)
                                  }
                                >
                                  {formatText("Open chat {number}", {
                                    number: index + 1,
                                  })}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      )}
    </PrivacySubpage>
  );
}
