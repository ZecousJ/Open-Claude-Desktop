import { useMemo, useRef, useState } from "react";
import { Expand } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { openLightbox } from "../lightbox/open";
import type { Artifact } from "../ui/ArtifactTypes";
import { parseDelimited } from "./csv";
import { AppIcon } from "../ui/app-icon";
import { formatText, t, useT } from "../i18n";
import { useSnapshotUrl } from "./useGeneratedBytes";
import "./file-viewer-panel.css";
import { ImageActions } from "../ui/ImageActions";

/**
 * Images fit the panel; clicking toggles actual size. The corner button shows
 * the picture full screen (the lightbox), grown out of the panel's copy.
 */
export function ImagePreview({ artifact }: { artifact: Artifact }) {
  const { url, error } = useSnapshotUrl(artifact);
  const [actual, setActual] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  return (
    <div className="file-preview artifact-image-preview" data-actual={actual}>
      {url ? (
        <>
          <ImageActions src={url} fileName={artifact.name}>
            <button
              className="artifact-image-toggle"
              aria-label={actual ? "Fit to panel" : "Show actual size"}
              aria-pressed={actual}
              onClick={() => setActual((value) => !value)}
            >
              <img
                ref={image}
                src={url}
                alt={artifact.name}
                draggable={false}
              />
            </button>
          </ImageActions>
          <button
            className="artifact-image-full-screen"
            aria-label="View full screen"
            title="View full screen"
            onClick={() =>
              openLightbox([{ src: url, alt: artifact.name }], 0, image.current)
            }
          >
            <Expand size={15} />
          </button>
        </>
      ) : error ? (
        <p className="artifact-preview-message">{error}</p>
      ) : (
        <div
          className="file-preview-loading"
          role="status"
          aria-label="Loading preview"
        >
          <Spinner inheritColor size={20} />
        </div>
      )}
    </div>
  );
}

const maxTableRows = 1000;

/** CSV and TSV as a table with a sticky header row. */
export function CsvPreview({ text, name }: { text: string; name: string }) {
  // The header row plus the first 1,000 data rows.
  const { rows, truncated } = useMemo(
    () => parseDelimited(text, undefined, maxTableRows + 1),
    [text],
  );
  const [header, ...body] = rows;
  return (
    <div className="file-preview artifact-table-preview">
      {header ? (
        <div className="artifact-table-scroll">
          <table aria-label={name}>
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c}>{row[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {truncated && (
            <p className="artifact-preview-message">
              Showing the first 1,000 rows. Download the file to see all of it.
            </p>
          )}
        </div>
      ) : (
        <p className="artifact-preview-message">This file is empty.</p>
      )}
    </div>
  );
}

/**
 * Why a file is too large to show: its size in megabytes to one decimal, or the
 * plain sentence when the size is not known.
 */
export function tooLargeReason(sizeBytes: number | undefined) {
  return sizeBytes === undefined
    ? t("File is too large to preview")
    : formatText("{sizeMb} MB \u2014 too large to preview", {
        sizeMb: (sizeBytes / 1048576).toFixed(1),
      });
}

/**
 * A file the viewer cannot show: a round File badge, "No preview", why (the
 * file type by default, or its size when the contents were left out), and
 * Download file once there are bytes to download. Spreadsheets, slides and
 * archives land here; so does a file past the snapshot limits, which has no
 * bytes and so no Download.
 */
export function FilePreviewCard({
  artifact,
  onDownload,
}: {
  artifact: Artifact;
  onDownload: () => void;
}) {
  useT();
  const omitted = artifact.contentOmitted === true;
  return (
    <div className="file-preview file-preview-none">
      <span className="file-preview-none-badge">
        <AppIcon name="File" />
      </span>
      <div className="file-preview-none-text">
        <span className="file-preview-none-title">{t("No preview")}</span>
        <span className="file-preview-none-reason">
          {omitted
            ? tooLargeReason(artifact.bytes)
            : t("This file type can\u2019t be previewed.")}
        </span>
      </div>
      {!omitted && (
        <button className="file-preview-none-download" onClick={onDownload}>
          <AppIcon name="DownloadSmall" />
          {t("Download file")}
        </button>
      )}
    </div>
  );
}
