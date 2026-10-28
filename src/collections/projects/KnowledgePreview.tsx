import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KnowledgeFile,
  KnowledgePreview,
} from "../../../shared/collections-api";
import { Modal } from "../../ui/Controls";
import { Spinner } from "../../ui/Spinner";
import { currentLocale, t } from "../../i18n";
import { ChevronLeft, Download, X } from "../../ui/glyphs";
import { parseDelimited } from "../../artifacts/csv";
import { formatSize } from "./KnowledgeList";
import { previewMessageType } from "../../artifacts/preview-document";
import type { Artifact } from "../../ui/ArtifactTypes";

/** Binary identity is required by the existing preview dispatcher; a language
 * label alone selects a text fallback and would silently render empty HTML. */
export function knowledgePdfArtifact(
  content: KnowledgePreview & { kind: "pdf" },
): Artifact {
  return {
    id: "project-knowledge-preview",
    name: content.name,
    language: "pdf",
    mime: "application/pdf",
    blob: true,
    content: "",
  };
}

/** Project files remain reference data. HTML, SVG and source code are inert text;
 * only the existing isolated PDF runtime renders binary contents.
 * Open/loading/error/nonrenderable: 1016 ca12e49f2-B8zRz5-9:1086,1850. */
export function KnowledgePreviewDialog({
  projectId,
  file,
  owns,
  onClose,
  pane = false,
  twoPane = true,
  onRemove,
}: {
  projectId: string;
  file: KnowledgeFile;
  owns(): boolean;
  onClose(): void;
  /** Where the project can be edited: Remove takes the file out and closes the preview. */
  onRemove?: () => void;
  /** Inside the hub’s existing Context dialog; native embedded lists use a modal. */
  pane?: boolean;
  twoPane?: boolean;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (pane) closeButton.current?.focus();
  }, [pane, twoPane, file.name]);
  const bridge = useRef(window.desktop).current;
  const latestOwns = useRef(owns);
  latestOwns.current = owns;
  const [content, setContent] = useState<KnowledgePreview>();
  const [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const current = () =>
    live.current && window.desktop === bridge && latestOwns.current();
  useEffect(() => {
    live.current = true;
    let active = true;
    setContent(undefined);
    setFailed(false);
    void Promise.resolve()
      .then(() => {
        if (!active || !current()) return;
        return bridge.readProjectKnowledge(projectId, file.name);
      })
      .then((value) => {
        if (active && current() && value) {
          if (value.name !== file.name)
            throw new Error("Unexpected project file.");
          setContent(value);
        }
      })
      .catch(() => {
        if (active && current()) setFailed(true);
      });
    return () => {
      active = false;
      live.current = false;
    };
  }, [projectId, file.name, bridge, attempt]);
  if (!current()) return null;
  const download = () => {
    if (!current() || !content || content.kind === "unsupported") return;
    const bytes =
      content.kind === "text"
        ? new TextEncoder().encode(content.text)
        : Uint8Array.from(atob(content.base64), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name.split("/").pop() || file.name;
    anchor.click();
    // Keep the object URL alive until the browser has consumed the click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const body = (
    <>
      <div className="prj-knowledge-preview-body">
        {failed ? (
          <div className="prj-knowledge-preview-message" role="alert">
            <p>{t("Failed to load file.")}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (current()) setAttempt((value) => value + 1);
              }}
            >
              {t("Retry")}
            </button>
          </div>
        ) : !content ? (
          <div className="prj-knowledge-preview-message" role="status">
            <Spinner inheritColor size={20} />
            <span>{t("Loading file…")}</span>
          </div>
        ) : content.kind === "unsupported" ? (
          <div className="prj-knowledge-preview-message">
            <p>{t("No preview")}</p>
            <span>
              {t(
                content.reason === "too-large"
                  ? "File is too large to preview"
                  : content.reason === "encoding"
                    ? "This file is not UTF-8 text."
                    : content.reason === "invalid-pdf"
                      ? "This PDF could not be previewed."
                      : "This file type can’t be previewed.",
              )}
            </span>
          </div>
        ) : content.kind === "text" && /\.(csv|tsv)$/i.test(file.name) ? (
          <KnowledgeTable text={content.text} file={file} />
        ) : content.kind === "text" ? (
          <pre className="prj-knowledge-preview-text" tabIndex={0}>
            {content.text}
          </pre>
        ) : (
          <KnowledgePdfPreview content={content} owns={current} />
        )}
      </div>
      {!pane && content && content.kind !== "unsupported" && (
        <div className="button-row">
          {onRemove && (
            <button type="button" className="secondary" onClick={onRemove}>
              {t("Remove")}
            </button>
          )}
          <button type="button" className="secondary" onClick={download}>
            {t("Download file")}
          </button>
        </div>
      )}
    </>
  );
  if (!pane)
    return (
      <Modal
        title={file.name}
        titleIsUserData
        className="prj-knowledge-preview"
        wide
        onClose={onClose}
        back={{ label: t("Back to context"), onClick: onClose }}
      >
        {body}
      </Modal>
    );
  const name = file.name.split("/").pop() || file.name;
  const dot = name.lastIndexOf(".");
  const title = dot > 0 ? name.slice(0, dot) : name;
  const type = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  return (
    <section
      className="prj-knowledge-preview-pane"
      aria-label={file.name}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="prj-knowledge-preview-header">
        {!twoPane && (
          <button
            ref={closeButton}
            type="button"
            className="prj-knowledge-preview-close"
            aria-label={t("Back to context")}
            onClick={onClose}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        )}
        <h3>
          <span data-no-translate>{title}</span>
          <small>
            {type}
            {type && " · "}
            {formatSize(file.bytes)}
            {Number.isFinite(file.addedAt) && (
              <>
                {" "}
                ·{" "}
                <time dateTime={new Date(file.addedAt).toISOString()}>
                  {new Date(file.addedAt).toLocaleDateString(currentLocale(), {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </>
            )}
          </small>
        </h3>
        {onRemove && (
          <button
            type="button"
            className="prj-knowledge-preview-remove"
            onClick={onRemove}
          >
            {t("Remove")}
          </button>
        )}
        {content && content.kind !== "unsupported" && (
          <button
            type="button"
            className="prj-knowledge-preview-download"
            aria-label={t("Download file")}
            title={t("Download file")}
            onClick={download}
          >
            <Download size={16} aria-hidden="true" />
          </button>
        )}
        {twoPane && (
          <button
            ref={closeButton}
            type="button"
            className="prj-knowledge-preview-close"
            aria-label={t("Close preview")}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </header>
      {body}
    </section>
  );
}

function KnowledgeTable({ text, file }: { text: string; file: KnowledgeFile }) {
  const { rows, truncated } = parseDelimited(
    text,
    /\.tsv$/i.test(file.name) ? "\t" : ",",
    1001,
  );
  const [header, ...body] = rows;
  return (
    <div className="prj-knowledge-preview-table">
      {header ? (
        <table aria-label={file.name}>
          <thead>
            <tr>
              {header.map((value, index) => (
                <th key={index}>{value}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, index) => (
              <tr key={index}>
                {header.map((_, column) => (
                  <td key={column}>{row[column] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t("This file is empty.")}</p>
      )}
      {truncated && (
        <p>
          {t(
            "Showing the first 1,000 rows. Download the file to see all of it.",
          )}
        </p>
      )}
    </div>
  );
}

function KnowledgePdfPreview({
  content,
  owns,
}: {
  content: KnowledgePreview & { kind: "pdf" };
  owns(): boolean;
}) {
  const [source, setSource] = useState<string>(),
    [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null),
    latestOwns = useRef(owns);
  latestOwns.current = owns;
  useEffect(() => {
    let active = true;
    const message = (event: MessageEvent) => {
      if (
        active &&
        latestOwns.current() &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === previewMessageType
      )
        setFailed(true);
    };
    window.addEventListener("message", message);
    void import("../../artifacts/preview-runtimes")
      .then(({ buildPreviewDocument }) =>
        buildPreviewDocument(knowledgePdfArtifact(content), {
          dark: document.documentElement.dataset.theme !== "light",
          bytes: async () => content.base64,
        }),
      )
      .then((value) => {
        if (active && latestOwns.current()) setSource(value);
      })
      .catch(() => {
        if (active && latestOwns.current()) setFailed(true);
      });
    return () => {
      active = false;
      window.removeEventListener("message", message);
    };
  }, [content]);
  if (!owns()) return null;
  if (failed)
    return (
      <p className="prj-knowledge-preview-message" role="alert">
        {t("This PDF could not be previewed.")}
      </p>
    );
  return (
    <>
      {!loaded && (
        <div className="prj-knowledge-preview-message" role="status">
          <Spinner inheritColor size={20} />
          <span>{t("Loading preview")}</span>
        </div>
      )}
      {source && (
        <iframe
          ref={frame}
          title={t("Project knowledge PDF preview")}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={source}
          onLoad={() => {
            if (owns()) setLoaded(true);
          }}
        />
      )}
    </>
  );
}
