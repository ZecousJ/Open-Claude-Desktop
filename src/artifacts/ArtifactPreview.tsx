import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "../ui/ArtifactTypes";
import { MarkdownDocument } from "./MarkdownDocument";
import { artifactKind, frameKinds } from "./artifact-kind";
import {
  completeMessageType,
  completeResultType,
  htmlDocument,
  previewMessageType,
} from "./preview-document";
import { useCapabilities } from "./capabilities";
import { buildPreviewDocument, useDarkTheme } from "./preview-runtimes";
import { ArtifactRuntimeError } from "./ArtifactRuntimeError";
import { CsvPreview, FilePreviewCard, ImagePreview } from "./NativePreviews";
import { useGeneratedBytes } from "./useGeneratedBytes";
import { useArtifactTools } from "./useArtifactTools";
import { useArtifactScheduledTasks } from "./useArtifactScheduledTasks";
import { artifactToolIdentity } from "../../shared/artifact-tools";
import {
  artifactDataMessage,
  artifactDataResult,
  artifactDataChanged,
  type ArtifactDataRequest,
} from "../../shared/artifact-data";
import { t } from "../i18n";
import { useInlinedHtml } from "./useInlinedHtml";

/** Delayed CDS md spinner; its label is not visible copy. */
export function ArtifactFrameLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="file-preview-loading">
      <span role="status" className="artifact-frame-loading">
        {visible && (
          <>
            <span className="artifact-frame-spinner" aria-hidden="true" />
            <span className="sr-only">{t("Loading artifact…")}</span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * The rendered view of an artifact: a sandboxed frame for web, React,
 * Mermaid, PDF and Word documents; native views for Markdown, images and
 * tables; a file card with Download for anything else.
 */
export function ArtifactPreview({
  artifact,
  refresh,
  onError,
  onTryFix,
  onDownload,
  asDocument,
}: {
  artifact: Artifact;
  refresh: number;
  onError: (error: unknown) => void;
  onTryFix?: (message: string) => Promise<void>;
  onDownload: () => void;
  /** A Code or Cowork session's file: Markdown reads as a document, with its contents rail. */
  asDocument?: boolean;
}) {
  const kind = artifactKind(artifact);
  const framed = useInlinedHtml(artifact, kind === "html");
  // Contents left out for size: the card says so (nothing to render).
  if (artifact.contentOmitted)
    return <FilePreviewCard artifact={artifact} onDownload={onDownload} />;
  if (kind === "markdown")
    return <MarkdownDocument text={artifact.content} asDocument={asDocument} />;
  if (kind === "csv")
    return <CsvPreview text={artifact.content} name={artifact.name} />;
  if (kind === "image") return <ImagePreview artifact={artifact} />;
  if (!frameKinds.has(kind))
    return <FilePreviewCard artifact={artifact} onDownload={onDownload} />;
  return (
    <FramePreview
      artifact={framed}
      refresh={refresh}
      onError={onError}
      onTryFix={onTryFix}
    />
  );
}

/**
 * An HTML file the conversation made, with the stylesheets and scripts it
 * loads from files the conversation also made put inline (shared/
 * inline-assets.ts): the frame has no folder to load them from.
 */
function FramePreview({
  artifact,
  refresh,
  onError,
  onTryFix,
}: {
  artifact: Artifact;
  refresh: number;
  onError: (error: unknown) => void;
  onTryFix?: (message: string) => Promise<void>;
}) {
  const desktop =
    typeof window !== "undefined" &&
    Boolean(window.desktop?.createArtifactPreview);
  const [loadedKey, setLoadedKey] = useState<string>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [preview, setPreview] = useState<{ key: string; url: string }>();
  // Refresh leaves the loaded page on screen, dimmed under the spinner, until
  // the reloaded one is ready.
  const [stale, setStale] = useState<string>();
  const loadedPage = useRef<{ document: string; url: string }>(undefined);
  const staleUrl = useRef<string>(undefined);
  const frame = useRef<HTMLIFrameElement>(null);
  const readBytes = useGeneratedBytes();
  const dark = useDarkTheme();
  const { aiArtifacts } = useCapabilities();
  const document = `${artifact.sourceDigest ?? ""}:${artifact.content}:${dark}:${aiArtifacts}`;
  const key = `${document}:${refresh}`;
  const loaded = loadedKey === key;
  const toolDialog = useArtifactTools(
    frame,
    artifactToolIdentity(artifact),
    key,
  );
  const taskDialog = useArtifactScheduledTasks(
    frame,
    artifactToolIdentity(artifact),
    key,
    artifact.name,
  );
  const release = (url: string | undefined) => {
    if (url) void window.desktop.releaseArtifactPreview(url).catch(() => {});
  };
  useEffect(() => {
    setRuntimeError(undefined);
    if (!desktop) return;
    const previous = loadedPage.current;
    loadedPage.current = undefined;
    release(staleUrl.current);
    staleUrl.current =
      previous?.document === document ? previous.url : undefined;
    if (!staleUrl.current) release(previous?.url);
    setStale(staleUrl.current);
    setPreview(undefined);
    let disposed = false;
    let url: string | undefined;
    void buildPreviewDocument(artifact, {
      dark,
      bytes: () => readBytes(artifact),
      claude: aiArtifacts,
    })
      .then((content) => window.desktop.createArtifactPreview(content))
      .then((value) => {
        if (disposed) {
          release(value);
          return;
        }
        url = value;
        setPreview({ key, url: value });
      })
      .catch((error) => {
        if (!disposed) {
          setLoadedKey(key);
          setRuntimeError(
            error instanceof Error ? error.message : t("The request failed."),
          );
          onError(error);
        }
      });
    return () => {
      disposed = true;
      // A loaded page stays until the next preview decides whether it is
      // the one a refresh keeps on screen.
      if (url && loadedPage.current?.url !== url) release(url);
    };
    // The key covers content, snapshot, refresh and theme; the artifact object changes identity on every update.
  }, [key, desktop, onError, readBytes, aiArtifacts]);
  useEffect(
    () => () => {
      release(loadedPage.current?.url);
      release(staleUrl.current);
    },
    [],
  );
  useEffect(() => {
    if (!loaded || !stale) return;
    release(stale);
    staleUrl.current = undefined;
    setStale(undefined);
  }, [loaded, stale]);
  useEffect(() => {
    function message(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      if (
        event.data?.type === artifactDataMessage &&
        Number.isSafeInteger(event.data.id)
      ) {
        const id = event.data.id;
        const identity = artifactToolIdentity(artifact);
        void window.desktop
          .artifactData(identity, event.data.request as ArtifactDataRequest)
          .then(
            (result) => {
              target.postMessage({ type: artifactDataResult, id, result }, "*");
              if (["set", "delete"].includes(event.data.request?.method))
                window.dispatchEvent(
                  new CustomEvent(artifactDataChanged, { detail: identity }),
                );
            },
            (error: unknown) =>
              target.postMessage(
                {
                  type: artifactDataResult,
                  id,
                  error: t(
                    error instanceof Error
                      ? error.message
                      : "The request failed.",
                  ),
                },
                "*",
              ),
          );
      }
      if (
        event.data?.type === previewMessageType &&
        typeof event.data.message === "string"
      )
        setRuntimeError(event.data.message);
      // AI-powered artifacts: the frame's window.claude.complete.
      if (
        aiArtifacts &&
        event.data?.type === completeMessageType &&
        typeof event.data.prompt === "string"
      ) {
        const id = event.data.id;
        const answer = (value: { text: string } | { error: string }) =>
          target.postMessage({ type: completeResultType, id, ...value }, "*");
        window.desktop
          .artifactComplete(event.data.prompt)
          .then((text) => answer({ text }))
          .catch((error: unknown) =>
            answer({
              error:
                error instanceof Error ? error.message : "The request failed.",
            }),
          );
      }
    }
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, [aiArtifacts, artifactToolIdentity(artifact)]);
  const current = preview?.key === key ? preview : undefined;
  return (
    <div
      className="file-preview"
      aria-busy={!loaded}
      data-refreshing={Boolean(stale) || undefined}
    >
      {toolDialog}
      {taskDialog}
      {stale && (
        <iframe
          key={stale}
          className="file-preview-stale"
          title="Artifact preview (refreshing)"
          sandbox="allow-scripts"
          src={stale}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}
      {(current || !desktop) && (
        <iframe
          key={current?.url ?? key}
          ref={frame}
          title={t("User-generated artifact content")}
          sandbox="allow-scripts"
          src={current?.url}
          srcDoc={
            desktop ? undefined : htmlDocument(artifact.content, aiArtifacts)
          }
          onLoad={() => {
            if (current) loadedPage.current = { document, url: current.url };
            requestAnimationFrame(() =>
              requestAnimationFrame(() => setLoadedKey(key)),
            );
          }}
          style={{
            visibility: loaded ? "visible" : "hidden",
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
      {!loaded && <ArtifactFrameLoading key={`loading:${key}`} />}
      {runtimeError && (
        <ArtifactRuntimeError
          message={runtimeError}
          onTryFix={onTryFix}
          onDismiss={() => setRuntimeError(undefined)}
          onError={onError}
        />
      )}
    </div>
  );
}
