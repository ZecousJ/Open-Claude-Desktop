import { createRoot } from "react-dom/client";
import { useLayoutEffect } from "react";
import type { Artifact } from "../ui/ArtifactTypes";
import { ArtifactSource } from "./ArtifactSource";
import { MarkdownDocument } from "./MarkdownDocument";
import { CsvPreview, FilePreviewCard } from "./NativePreviews";
import { artifactKind, frameKinds } from "./artifact-kind";
import { htmlDocument, inlineScript, scriptJson } from "./preview-document";
import { t } from "../i18n";

export function NativePopout({
  artifact,
  imageUrl,
  onReady,
}: {
  artifact: Artifact;
  imageUrl?: string;
  onReady?: () => void;
}) {
  useLayoutEffect(() => onReady?.(), [onReady]);
  const kind = artifactKind(artifact);
  return (
    <div className="artifact-panel file-viewer" data-expanded="true">
      {artifact.contentOmitted || kind === "file" ? (
        <FilePreviewCard artifact={artifact} onDownload={() => {}} />
      ) : kind === "markdown" ? (
        <MarkdownDocument text={artifact.content} />
      ) : kind === "csv" ? (
        <CsvPreview text={artifact.content} name={artifact.name} />
      ) : kind === "image" ? (
        <div
          className="file-preview artifact-image-preview"
          data-actual="false"
        >
          <button
            className="artifact-image-toggle"
            aria-label={t("Show actual size")}
            aria-pressed="false"
          >
            <img src={imageUrl} alt={artifact.name} draggable={false} />
          </button>
        </div>
      ) : (
        <ArtifactSource artifact={artifact} />
      )}
    </div>
  );
}

// Pop-out is gated by the host, not kind.
export async function popoutDocument(
  artifact: Artifact,
  bytes: () => Promise<string>,
) {
  const kind = artifactKind(artifact);
  if (frameKinds.has(kind) && !artifact.contentOmitted) {
    const { buildPreviewDocument, darkTheme } =
      await import("./preview-runtimes");
    return buildPreviewDocument(artifact, { dark: darkTheme(), bytes });
  }
  const imageUrl =
    kind === "image"
      ? `data:${artifact.mime || "image/png"};base64,${await bytes()}`
      : undefined;
  const styles = Array.from(document.styleSheets, (sheet) => {
    try {
      return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
    } catch {
      return "";
    }
  }).join("\n");
  const theme =
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const container = document.createElement("div");
  let rejectRender: (error: unknown) => void = () => {};
  const root = createRoot(container, {
    onUncaughtError: (error) => rejectRender(error),
  });
  let markup: string;
  try {
    await new Promise<void>((resolve, reject) => {
      rejectRender = reject;
      root.render(
        <NativePopout
          artifact={artifact}
          imageUrl={imageUrl}
          onReady={resolve}
        />,
      );
    });
    markup = container.innerHTML;
  } finally {
    root.unmount();
  }
  return htmlDocument(
    `<html data-theme="${theme}"><style>${styles.replace(/<\/style/gi, "<\\/style")}</style>${markup}${inlineScript(
      `document.querySelector('.file-preview-none-download')?.addEventListener('click',()=>parent.postMessage({type:'claudex-popout-download'},'*'));` +
        `document.querySelector('.artifact-image-toggle')?.addEventListener('click',event=>{const button=event.currentTarget;const preview=button.closest('.artifact-image-preview');const actual=preview.dataset.actual!=='true';preview.dataset.actual=String(actual);button.setAttribute('aria-pressed',String(actual));button.setAttribute('aria-label',actual?${scriptJson(t("Fit to panel"))}:${scriptJson(t("Show actual size"))});});`,
    )}</html>`,
  );
}
