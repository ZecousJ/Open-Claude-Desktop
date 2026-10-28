import { Suspense, type ComponentType } from "react";
import { useApp, type AppController } from "./AppContext";
import { ArtifactPanelHost } from "./ArtifactHost";
import { PanelBoundary } from "./PanelBoundary";
import { lazyPiece } from "../ui/lazy-piece";

// The Code tool panels load when one opens (not part of the first load).
const ToolPanelHost = lazyPiece(
  () => import("./ToolPanelHost"),
  "ToolPanelHost",
);

/**
 * A panel a round-two package adds beside the conversation (the third slot,
 * for example R45e's Research panel in Chat and Cowork). The package keeps
 * whether it is open in its own state and makes sure it does not show
 * together with a panel it replaces.
 */
export interface RightPanelSlot {
  /** Whether the panel shows in this render. */
  shown(app: AppController): boolean;
  /** Changes when another panel or conversation shows (resets a failed panel). */
  resetKey(app: AppController): string;
  /** Closes the panel (the error fallback's Close). */
  close(app: AppController): void;
  /** The panel; it reads the window's state with useApp(). */
  Component: ComponentType;
}

const slots = new Map<string, RightPanelSlot>();

/** Adds a panel to the third slot, from the package's `*.slot.tsx` module. */
export function registerRightPanel(id: string, slot: RightPanelSlot) {
  slots.set(id, slot);
}

/**
 * The panels beside the conversation: the file viewer, or one Code tool panel,
 * then any registered panel. Each sits in its own error boundary, so a panel
 * that fails to render never blanks the window.
 */
export function RightPanels() {
  const app = useApp();
  const { artifact, panel, active, setArtifact, setPanel } = app;
  return (
    <>
      {artifact && !active && (
        <PanelBoundary
          resetKey={`${artifact.conversationId ?? ""}:${artifact.id}`}
          onClose={() => setArtifact(undefined)}
        >
          <ArtifactPanelHost artifact={artifact} />
        </PanelBoundary>
      )}{" "}
      {(panel || artifact) && active && (
        <PanelBoundary
          resetKey={`${panel}:${active.id}`}
          onClose={() => {
            setPanel(null);
            setArtifact(undefined);
          }}
        >
          <Suspense fallback={null}>
            <ToolPanelHost panel={panel ?? "artifact"} active={active} />
          </Suspense>
        </PanelBoundary>
      )}
      {[...slots].map(
        ([id, slot]) =>
          slot.shown(app) && (
            <PanelBoundary
              key={id}
              resetKey={`${id}:${slot.resetKey(app)}`}
              onClose={() => slot.close(app)}
            >
              <slot.Component />
            </PanelBoundary>
          ),
      )}
    </>
  );
}
