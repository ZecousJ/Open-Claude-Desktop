import { deferFileTransition } from "../files/file-transitions";
import type { AppController } from "../app/AppContext";
import type { ArtifactOutputKind } from "../../shared/artifact-output";
import { artifactRouteId } from "./artifact-route-model";
import { blankArtifactCreateLease } from "./blank-artifact-request";
import { blankConversationArtifact } from "./blank-artifact-model";
import { t } from "../i18n";
export const blankConversationTitles = {
  docs: "Untitled document",
  slides: "Untitled presentation",
  design: "Untitled design",
  dashboard: "Untitled dashboard",
} as const;
export async function createBlankArtifact(
  app: AppController,
  kind: ArtifactOutputKind,
) {
  if (deferFileTransition(() => void createBlankArtifact(app, kind))) return;
  let deferred = false;
  const lease = blankArtifactCreateLease(app),
    bridge = window.desktop,
    paired = app.page === "chat" && Boolean(app.active);
  try {
    if (!lease.current()) return;
    const result = await bridge.createBlankArtifact({
      requestId: crypto.randomUUID(),
      kind,
      name: t(blankConversationTitles[kind]),
      providerId: app.providerId,
      model: app.model,
    });
    if (!lease.current()) return;
    const artifact = blankConversationArtifact(result.conversation);
    if (!artifact)
      throw new Error("This artifact is not available in this account.");
    const open = () => {
      try {
        if (!lease.current()) return;
        app.upsert(result.conversation);
        if (paired) {
          app.openConversation(result.conversation);
          app.setArtifact(artifact);
        } else {
          app.setActiveId(result.conversation.id);
          app.setMode("chat");
          app.setArtifact(undefined);
          app.setArtifactRouteId?.(artifactRouteId(artifact));
          app.setPage("artifact");
        }
      } finally {
        lease.release();
      }
    };
    deferred = deferFileTransition(open);
    if (!deferred) open();
  } catch (error) {
    if (lease.current()) app.report(error);
  } finally {
    if (!deferred) lease.release();
  }
}
