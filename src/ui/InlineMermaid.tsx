import { useEffect, useRef, useState } from "react";
import {
  loadMermaidRuntime,
  useDarkTheme,
} from "../artifacts/preview-runtimes";
import {
  markdownMermaidDocument,
  mermaidResultType,
} from "../artifacts/markdown-mermaid-document";
import { t } from "../i18n";

export function InlineMermaid({
  code,
  streaming,
}: {
  code: string;
  streaming: boolean;
}) {
  const dark = useDarkTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [result, setResult] = useState<{
    key: string;
    document?: string;
    height?: number;
    error?: boolean;
  }>();
  const key = `${dark}:${code}`;
  const current = result?.key === key ? result : undefined;
  const refused = code.length > 20_000;
  useEffect(() => {
    if (streaming || refused) return;
    let disposed = false;
    const timeout = setTimeout(() => {
      disposed = true;
      setResult({ key, error: true });
    }, 30_000);
    function message(event: MessageEvent) {
      if (
        disposed ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== mermaidResultType
      )
        return;
      if (event.data.error) {
        clearTimeout(timeout);
        setResult({ key, error: true });
      } else if (
        typeof event.data.height === "number" &&
        Number.isFinite(event.data.height) &&
        event.data.height > 0
      ) {
        clearTimeout(timeout);
        setResult((previous) =>
          previous?.key === key
            ? { ...previous, height: event.data.height }
            : previous,
        );
      }
    }
    window.addEventListener("message", message);
    void loadMermaidRuntime()
      .then((runtime) => {
        if (!disposed)
          setResult({
            key,
            document: markdownMermaidDocument(runtime, code, dark),
          });
      })
      .catch(() => {
        if (!disposed) {
          clearTimeout(timeout);
          setResult({ key, error: true });
        }
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      window.removeEventListener("message", message);
    };
  }, [code, dark, key, refused, streaming]);
  if (streaming || refused || current?.error)
    return (
      <pre data-mermaid className="markdown-mermaid-source" dir="ltr">
        {code}
      </pre>
    );
  return (
    <div
      className={`markdown-mermaid${current?.height ? "" : " is-loading"}`}
      dir="ltr"
      data-mermaid
      role="img"
      aria-label={t("Mermaid diagram")}
    >
      {current?.document && (
        <iframe
          key={key}
          ref={frame}
          title={t("Mermaid diagram")}
          sandbox="allow-scripts"
          srcDoc={current.document}
          style={{
            height: current.height ?? 64,
            visibility: current.height ? "visible" : "hidden",
          }}
        />
      )}
    </div>
  );
}
