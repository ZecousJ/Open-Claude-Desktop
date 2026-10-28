import { useEffect, useRef, useState } from "react";
import { Spinner } from "./Spinner";
import {
  visualizationDocument,
  visualizationSizeType,
} from "../artifacts/preview-document";
import { useDarkTheme } from "../artifacts/preview-runtimes";

/** Frames never grow past this (a runaway layout scrolls inside). */
const maxHeight = 1600;

/**
 * Settings → Capabilities → Inline visualizations: a reply's `visualization`
 * block (HTML or SVG) drawn in place, in the same sandboxed frame as an
 * artifact preview (no network, inline scripts only). While the block is
 * still arriving it waits under the preview's loading spinner.
 */
export function InlineVisualization({
  code,
  complete,
}: {
  code: string;
  /** The block's closing fence has arrived. */
  complete: boolean;
}) {
  const dark = useDarkTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string>();
  const [height, setHeight] = useState(0);
  const desktop =
    typeof window !== "undefined" &&
    Boolean(window.desktop?.createArtifactPreview);
  const document = complete ? visualizationDocument(code, dark) : "";
  useEffect(() => {
    if (!desktop || !document) return;
    let disposed = false;
    let made: string | undefined;
    void window.desktop
      .createArtifactPreview(document)
      .then((value) => {
        made = value;
        if (disposed)
          void window.desktop.releaseArtifactPreview(value).catch(() => {});
        else setUrl(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      setUrl(undefined);
      if (made)
        void window.desktop.releaseArtifactPreview(made).catch(() => {});
    };
  }, [desktop, document]);
  useEffect(() => {
    function message(event: MessageEvent) {
      if (
        event.source === frame.current?.contentWindow &&
        event.data?.type === visualizationSizeType &&
        typeof event.data.height === "number"
      )
        setHeight(Math.min(maxHeight, Math.max(0, event.data.height)));
    }
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, []);
  const ready = complete && (desktop ? Boolean(url) : true);
  return (
    <div className="inline-visualization" aria-busy={!height}>
      {ready && (
        <iframe
          ref={frame}
          title="Visualization"
          sandbox="allow-scripts"
          src={desktop ? url : undefined}
          srcDoc={desktop ? undefined : document}
          style={{ height: height || undefined, opacity: height ? 1 : 0 }}
        />
      )}
      {!height && (
        <div
          className="file-preview-loading"
          role="status"
          aria-label="Drawing visualization"
        >
          <Spinner inheritColor size={20} />
        </div>
      )}
    </div>
  );
}
