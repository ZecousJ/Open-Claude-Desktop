import { useConversationServices } from "../conversation/ConversationServices";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { File, X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { formatText, t } from "../i18n";
import { ImageActions } from "../ui/ImageActions";
import { GithubMark } from "../ui/GithubMark";
import type { Attachment } from "../../shared/types";
import "../../shared/composer-api";
import { formatBytes } from "../../shared/format-bytes";
import {
  formatLines,
  shortenAttachmentName,
} from "../../shared/attachment-detail";
import { openImageGroup } from "../lightbox/open";
import { PastedCard } from "./PastedCard";
import {
  attachmentPreviewUrl,
  excerptLabel,
  pastedText,
} from "./attachment-input";
import { removeAttachment } from "./attachment-motion";

/** The path over two card lines, keeping its start and its end. */
function middleCut(path: string) {
  return path.length > 26
    ? `${path.slice(0, 13)}…\u200b${path.slice(-12)}`
    : path;
}

/** A file still being read or kept, shown until it becomes an attachment. */
export interface PendingAttachment {
  key: string;
  name: string;
  image?: boolean;
  preview?: string;
}

/** Thumbnails for image attachments: pasted/dropped ones locally, picked ones from the main process. */
function useImagePreviews(attachments: Attachment[]) {
  const services = useConversationServices();
  const [loaded, setLoaded] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (services.attachmentPreviewSync) return;
    let current = true;
    for (const attachment of attachments) {
      if (attachment.kind !== "image" || attachment.id in loaded) continue;
      if (attachmentPreviewUrl(attachment.id)) continue;
      void services
        .attachmentPreview(attachment.id)
        .catch(() => null)
        .then(
          (url) =>
            current &&
            setLoaded((value) => ({ ...value, [attachment.id]: url })),
        );
    }
    return () => {
      current = false;
    };
  }, [attachments, services]);
  return (id: string) =>
    services.attachmentPreviewSync
      ? services.attachmentPreviewSync(id)
      : (attachmentPreviewUrl(id) ?? loaded[id] ?? null);
}

/**
 * A thumbnail's picture: transparent and blurred until it has loaded, then
 * clear over 400ms.
 */
function ThumbnailImage({ src, name }: { src: string; name?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <img
        ref={(image) => {
          // A cached picture may be complete before React listens for load.
          if (image?.complete && image.naturalWidth > 0 && !loaded)
            setLoaded(true);
        }}
        src={src}
        alt=""
        draggable={false}
        data-loaded={loaded || undefined}
        onLoad={() => setLoaded(true)}
      />
      {!loaded && (
        <span role="status" className="sr-only">
          {name
            ? formatText("Loading attached image {name}", { name })
            : t("Loading attached image")}
        </span>
      )}
    </>
  );
}

export function attachedImageLabel(index: number, uploading = false) {
  return formatText(
    uploading
      ? "View attached image {n} (uploading)"
      : "View attached image {n}",
    { n: index + 1 },
  );
}

function LoadingImage({ name }: { name?: string }) {
  return (
    <span role="status" className="attachment-image-loading">
      <Spinner inheritColor size={16} className="spin" aria-hidden="true" />
      <span className="sr-only">
        {name
          ? formatText("Loading attached image {name}", { name })
          : t("Loading attached image")}
      </span>
    </span>
  );
}

/** The name on up to two lines; a cut name breaks after its ellipsis. */
function AttachmentName({ name }: { name: string }) {
  const short = shortenAttachmentName(name);
  const cut = short === name ? -1 : short.indexOf("…");
  return (
    <strong title={name}>
      {cut < 0 ? (
        short
      ) : (
        <>
          <span className="attachment-name-head">
            {short.slice(0, cut + 1)}
          </span>
          {short.slice(cut + 1)}
        </>
      )}
    </strong>
  );
}

/**
 * The composer's attachments: image thumbnails that open a preview, pasted text
 * as a Pasted card, other files as name-and-size cards, and a spinner card for
 * a file still being added.
 */
export function AttachmentList({
  attachments,
  pending,
  onRemove,
  showPaths,
  restoreKey,
  children,
}: {
  attachments: Attachment[];
  pending: PendingAttachment[];
  /** Missing in a sent message: the cards show without ×. */
  onRemove?: (id: string) => void;
  /**
   * Code names a file card by its path, cut in the middle, with the full path
   * as a tooltip.
   */
  showPaths?: boolean;
  /**
   * The draft shown; when it changes, the cards already there are restored
   * ones and appear without the entrance a newly added card has.
   */
  restoreKey?: string;
  children?: ReactNode;
}) {
  const services = useConversationServices();
  const preview = useImagePreviews(attachments);
  const list = useRef<HTMLDivElement>(null);
  const ids = () => new Set(attachments.map((a) => a.id));
  const [restored, setRestored] = useState(ids);
  const [shownKey, setShownKey] = useState(restoreKey);
  if (shownKey !== restoreKey) {
    setShownKey(restoreKey);
    setRestored(ids());
  }
  if (!attachments.length && !pending.length && !children) return null;
  return (
    <div className="attachment-list" ref={list}>
      {attachments.map((a, index) => {
        const remove =
          onRemove &&
          (() => removeAttachment(list.current, a.id, () => onRemove(a.id)));
        const motion = {
          "data-attachment": a.id,
          "data-restored": restored.has(a.id) || undefined,
        };
        if (a.pasted)
          return (
            <PastedCard
              key={a.id}
              name={a.name}
              text={pastedText(a.id)}
              badge={excerptLabel(a.id) ? "Excerpt" : undefined}
              title={excerptLabel(a.id)}
              onRemove={remove}
              attachmentId={a.id}
              restored={restored.has(a.id)}
            />
          );
        const url = a.kind === "image" ? preview(a.id) : null;
        if (a.kind === "image")
          return (
            <ImageActions key={a.id} src={url} fileName={a.name}>
              <div className="attachment-thumbnail" key={a.id} {...motion}>
                <button
                  className="attachment-thumbnail-open"
                  aria-label={attachedImageLabel(index)}
                  title={
                    a.name || formatText("Attached image {n}", { n: index + 1 })
                  }
                  aria-busy={!url || undefined}
                  disabled={!url}
                  onClick={(event) =>
                    services.openAttachment
                      ? void services.openAttachment(a.id).catch(() => {})
                      : openImageGroup(
                          event.currentTarget.closest(".attachment-list"),
                          event.currentTarget,
                          ".attachment-thumbnail-open img",
                          t("Attached image"),
                        )
                  }
                >
                  {url ? (
                    <ThumbnailImage src={url} name={a.name} />
                  ) : (
                    <LoadingImage name={a.name} />
                  )}
                </button>
                {remove && (
                  <button
                    className="attachment-remove"
                    aria-label={formatText("Remove {name}", { name: a.name })}
                    onClick={remove}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                )}
              </div>
            </ImageActions>
          );
        // A file is a 120px tile like the Pasted card: its name on two lines (a
        // long one cut in the middle), the number of lines (the size when the
        // file was not counted) and the extension as the label; × on hover.
        const extension = /\.([a-z0-9]{1,8})$/i.exec(a.name)?.[1];
        return (
          <div
            className="pasted-card attachment-tile"
            key={a.id}
            title={a.path}
            {...motion}
          >
            <div className="attachment-tile-text">
              {showPaths ? (
                <strong>{middleCut(a.path)}</strong>
              ) : (
                <AttachmentName name={a.name} />
              )}
              {!showPaths && (
                <small>
                  {a.github ? (
                    <span data-no-translate>{a.github.branch}</span>
                  ) : a.lines === undefined ? (
                    formatBytes(a.size)
                  ) : (
                    formatLines(a.lines)
                  )}
                </small>
              )}
            </div>
            <span className="pasted-card-label">
              {a.github ? (
                <GithubMark />
              ) : extension ? (
                extension.toUpperCase()
              ) : (
                <File size={11} />
              )}
            </span>
            {remove && (
              <button
                className="attachment-remove"
                aria-label={formatText("Remove {name}", { name: a.name })}
                onClick={remove}
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        );
      })}
      {/* A file still being added grows into the row and, after half a
          second, pulses until it is kept (the original's upload tile). */}
      {pending.map((item, index) =>
        item.image ? (
          <div
            className="attachment-thumbnail pending"
            key={item.key}
            aria-busy="true"
          >
            <button
              className="attachment-thumbnail-open"
              aria-label={attachedImageLabel(attachments.length + index, true)}
              disabled={!item.preview}
              onClick={(event) =>
                openImageGroup(
                  event.currentTarget.closest(".attachment-list"),
                  event.currentTarget,
                  ".attachment-thumbnail-open img",
                  t("Attached image"),
                )
              }
            >
              {item.preview && (
                <ThumbnailImage src={item.preview} name={item.name} />
              )}
              <span role="status" className="attachment-image-uploading">
                <Spinner
                  inheritColor
                  size={16}
                  className="spin"
                  aria-hidden="true"
                />
                <span className="sr-only">{t("Uploading image")}</span>
              </span>
            </button>
          </div>
        ) : (
          <div className="attachment pending" key={item.key} aria-busy="true">
            <div>
              <strong>{item.name}</strong>
              <small>Adding…</small>
            </div>
          </div>
        ),
      )}
      {children}
    </div>
  );
}

/**
 * What a sent message carries: the composer's tiles, read-only, in a row above
 * the bubble at its right edge. An image is its thumbnail and opens the same
 * preview; any other file is the 120px tile with its name, size and extension.
 * The original's tile shows a page thumbnail for a PDF; Claudex does not render
 * one, so it stays the file tile.
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: Attachment[];
}) {
  const services = useConversationServices();
  const preview = useImagePreviews(attachments);
  if (!attachments.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((a, index) => {
        const url = a.kind === "image" ? preview(a.id) : null;
        if (a.kind === "image")
          return (
            <ImageActions key={a.id} src={url} fileName={a.name}>
              <div className="attachment-thumbnail" key={a.id}>
                <button
                  className="attachment-thumbnail-open"
                  aria-label={attachedImageLabel(index)}
                  title={
                    a.name || formatText("Attached image {n}", { n: index + 1 })
                  }
                  aria-busy={!url || undefined}
                  disabled={!url}
                  onClick={(event) =>
                    services.openAttachment
                      ? void services.openAttachment(a.id).catch(() => {})
                      : openImageGroup(
                          event.currentTarget.closest(".message-attachments"),
                          event.currentTarget,
                          ".attachment-thumbnail-open img",
                          t("Attached image"),
                        )
                  }
                >
                  {url ? (
                    <ThumbnailImage src={url} name={a.name} />
                  ) : (
                    <LoadingImage name={a.name} />
                  )}
                </button>
              </div>
            </ImageActions>
          );
        const extension = /\.([a-z0-9]{1,8})$/i.exec(a.name)?.[1];
        return (
          <div
            className="pasted-card attachment-tile"
            key={a.id}
            role={services.openAttachment ? "button" : undefined}
            tabIndex={services.openAttachment ? 0 : undefined}
            onClick={
              services.openAttachment
                ? () => void services.openAttachment!(a.id).catch(() => {})
                : undefined
            }
            onKeyDown={
              services.openAttachment
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ")
                      void services.openAttachment!(a.id).catch(() => {});
                  }
                : undefined
            }
          >
            <div className="attachment-tile-text">
              <strong>{a.name}</strong>
              <small>{formatBytes(a.size)}</small>
            </div>
            <span className="pasted-card-label">
              {extension ? extension.toUpperCase() : <File size={11} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}
