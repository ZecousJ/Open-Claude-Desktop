import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DiffScope } from "../../shared/types";
import type { DiffFile } from "../diff/diff-model";
import { formatText, t, tc } from "../i18n";
import { Modal } from "../ui/Controls";
import "./image-compare.css";

export function Figure({
  label,
  alt,
  src,
}: {
  label: string;
  alt: string;
  /** undefined while it loads; null when there is none. */
  src: string | null | undefined;
}) {
  const [loaded, setLoaded] = useState<{
    src: string;
    size: { width: number; height: number } | null;
  }>();
  const size = loaded?.src === src ? loaded?.size : undefined;
  return (
    <figure className="image-compare-figure">
      <figcaption>
        <span className="image-compare-label">{label}</span>
        {size && (
          <span className="image-compare-size">
            {formatText("{width} × {height}", size)}
          </span>
        )}
      </figcaption>
      <div
        className="image-compare-frame"
        aria-busy={src === undefined || undefined}
      >
        {src === null || size === null ? (
          <span className="image-compare-missing">
            {t("Image not available")}
          </span>
        ) : src ? (
          <img
            src={src}
            alt={alt}
            onLoad={(event) =>
              setLoaded({
                src,
                size: {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                },
              })
            }
            onError={() => setLoaded({ src, size: null })}
            draggable={false}
          />
        ) : null}
      </div>
    </figure>
  );
}

/**
 * View image: an image file's version before the change beside the one after —
 * "Deleted" alone for a removed file, "Added" alone for a new one — each with
 * its size, in a 320px frame.
 */
export default function ImageCompareDialog({
  conversationId,
  file,
  scope,
  onClose,
}: {
  conversationId: string;
  file: DiffFile;
  scope?: DiffScope;
  onClose: () => void;
}) {
  const [before, setBefore] = useState<string | null>();
  const [after, setAfter] = useState<string | null>();
  const removed = file.status === "deleted";
  const added = file.status === "added";
  useEffect(() => {
    let live = true;
    const read = (
      side: "before" | "after",
      path: string,
      set: typeof setBefore,
    ) =>
      void Promise.resolve(
        window.desktop?.changedImage?.(conversationId, path, side, scope),
      )
        .then((url) => live && set(url ?? null))
        .catch(() => live && set(null));
    if (!added) read("before", file.oldPath ?? file.path, setBefore);
    if (!removed) read("after", file.path, setAfter);
    return () => {
      live = false;
    };
  }, [conversationId, file.path, file.oldPath, added, removed, scope]);
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return createPortal(
    <Modal title={name} onClose={onClose} wide className="image-compare">
      <div
        className="image-compare-grid"
        data-both={(!added && !removed) || undefined}
      >
        {!added && (
          <Figure
            label={removed ? t("Deleted") : t("Before")}
            alt={formatText("{name} before the change", { name })}
            src={before}
          />
        )}
        {!removed && (
          <Figure
            label={added ? tc("file status", "Added") : t("After")}
            alt={formatText("{name} after the change", { name })}
            src={after}
          />
        )}
      </div>
    </Modal>,
    document.body,
  );
}
