import { Suspense, type ComponentProps } from "react";
import { lazyPiece, preloadPiece } from "../ui/lazy-piece";
import type { ArtifactCard as Card } from "./ArtifactCard";

// The artifact card (with its sheet glyphs) is not part of the first load:
// it arrives with the first transcript that holds an artifact, and the app
// fetches it once it is idle (preloadArtifactCard), so it is usually there
// before it is needed.
const LoadedCard = lazyPiece(() => import("./ArtifactCard"), "ArtifactCard");

export function ArtifactCard(props: ComponentProps<typeof Card>) {
  return (
    <Suspense fallback={null}>
      <LoadedCard {...props} />
    </Suspense>
  );
}

export function preloadArtifactCard(): Promise<void> {
  return preloadPiece(LoadedCard).then(
    () => undefined,
    () => undefined,
  );
}
