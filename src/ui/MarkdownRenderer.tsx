import { Suspense } from "react";
import type { Options } from "react-markdown";
import { lazyPiece, preloadPiece } from "./lazy-piece";

export type MarkdownRendererProps = Options & {
  preset?: "reply" | "gfm";
};

// Empty while loading, as the lazy UI.
const Renderer = lazyPiece(() => import("./MarkdownRendererContent"));

export const preloadMarkdownRenderer = () => preloadPiece(Renderer);

export function MarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <Suspense fallback={null}>
      <Renderer {...props} />
    </Suspense>
  );
}
