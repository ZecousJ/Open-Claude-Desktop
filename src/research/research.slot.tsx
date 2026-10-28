/**
 * The Research side panel (R4, design R45 §4.4) in the third right-panel
 * slot, and Research's stylesheet (the chip and transcript card use it
 * too). Loaded by src/main.tsx before the first render; its stylesheet
 * comes after the app's own.
 *
 * Whether the panel is open lives in useResearchDraft's store, which
 * RightPanels does not watch: the slot is mounted whenever a conversation
 * is open and neither the file viewer nor a tool panel is, and the host
 * reads the store and renders nothing while the panel is closed. Opening a
 * tool panel or a file hides it; opening it closes them (openResearchPanel).
 */
import { registerRightPanel } from "../app/RightPanels";
import { useApp } from "../app/AppContext";
import { Suspense } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import {
  getResearchPanel,
  setResearchPanel,
  useResearchPanel,
} from "./useResearchDraft";
import "./research.css";

const ResearchPanel = lazyPiece(
  () => import("./ResearchPanel"),
  "ResearchPanel",
);

function ResearchPanelHost() {
  const app = useApp();
  const target = useResearchPanel();
  const conversation = app.active;
  const turn =
    target && conversation?.id === target.conversationId
      ? conversation.turns.find((t) => t.id === target.turnId)
      : undefined;
  if (!target || !conversation || !turn) return null;
  return (
    <Suspense fallback={null}>
      <ResearchPanel
        conversation={conversation}
        turn={turn}
        target={target}
        notify={app.notify}
      />
    </Suspense>
  );
}

registerRightPanel("research", {
  shown: (app) => {
    const replaced = !!app.panel || !!app.artifact;
    // A tool panel or file opened over it closes it, so closing that one
    // later does not bring Research back unasked.
    if (replaced && getResearchPanel())
      queueMicrotask(() => setResearchPanel(undefined));
    return !!app.active && !replaced;
  },
  resetKey: (app) => {
    const target = getResearchPanel();
    return `${app.active?.id ?? ""}:${target?.turnId ?? ""}`;
  },
  close: () => setResearchPanel(undefined),
  Component: ResearchPanelHost,
});
