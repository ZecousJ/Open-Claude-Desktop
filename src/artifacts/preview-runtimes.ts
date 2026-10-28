import { useEffect, useState } from "react";
import type { Artifact } from "../ui/ArtifactTypes";
import { artifactKind } from "./artifact-kind";
import {
  docxDocument,
  officeDocument,
  htmlDocument,
  mermaidDocument,
  pdfDocument,
  reactDocument,
} from "./preview-document";

// Each runtime is its own lazily loaded chunk.
const loaders = {
  react: () => import("virtual:preview-runtime/react"),
  mermaid: () => import("virtual:preview-runtime/mermaid"),
  pdf: () => import("virtual:preview-runtime/pdf"),
  docx: () => import("virtual:preview-runtime/docx"),
  office: () => import("virtual:preview-runtime/office"),
};
const loaded = new Map<keyof typeof loaders, Promise<{ source: string }>>();
function runtime(name: keyof typeof loaders) {
  if (!loaded.has(name))
    loaded.set(
      name,
      loaders[name]().then(
        (module) => ({ source: module.default }),
        (error) => {
          loaded.delete(name);
          throw error;
        },
      ),
    );
  return loaded.get(name)!;
}
export const loadMermaidRuntime = () => runtime("mermaid");

/** JSX/TSX to a CommonJS factory body; the frame's runtime supplies `require`. */
export async function compileReact(
  source: string,
): Promise<{ code: string } | { error: string }> {
  const { transform } = await import("sucrase");
  try {
    return {
      code: transform(source, {
        transforms: ["jsx", "typescript", "imports"],
        jsxRuntime: "classic",
        production: true,
        filePath: "artifact.tsx",
      }).code,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The complete sandboxed document for a frame-rendered artifact. */
export async function buildPreviewDocument(
  artifact: Artifact,
  options: {
    dark: boolean;
    bytes: () => Promise<string>;
    /** AI-powered artifacts: HTML and React get `window.claude.complete`. */
    claude?: boolean;
  },
): Promise<string> {
  switch (artifactKind(artifact)) {
    case "react":
      return reactDocument(
        await runtime("react"),
        await compileReact(artifact.content),
        options.claude,
      );
    case "mermaid":
      return mermaidDocument(
        await runtime("mermaid"),
        artifact.content,
        options.dark,
      );
    case "pdf":
      return pdfDocument(
        await runtime("pdf"),
        await options.bytes(),
        options.dark,
      );
    case "docx":
      return docxDocument(
        await runtime("docx"),
        await options.bytes(),
        options.dark,
      );
    case "xlsx":
    case "pptx":
      return officeDocument(
        await runtime("office"),
        artifactKind(artifact) as "xlsx" | "pptx",
        await options.bytes(),
        options.dark,
      );
    default:
      return htmlDocument(artifact.content, options.claude);
  }
}

export function darkTheme() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme !== "light"
  );
}

/** The app theme, following changes so themed previews (Mermaid, PDF, Word) rebuild. */
export function useDarkTheme() {
  const [dark, setDark] = useState(darkTheme);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(darkTheme()));
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    setDark(darkTheme());
    return () => observer.disconnect();
  }, []);
  return dark;
}
