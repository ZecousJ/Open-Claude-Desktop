import type { AppController } from "../app/AppContext";
import type { ArtifactOutputKind } from "../../shared/artifact-output";
/** Current official Code: a home draft retains text; an existing session
 * opens a new empty draft. Neither path creates an artifact before send. */
export function startCodeTemplate(
  app: AppController,
  kind: ArtifactOutputKind,
): boolean {
  if (app.mode !== "code") return false;
  const start = () => {
    app.composerDraft.setDraftArtifactOutput(kind);
    requestAnimationFrame(() => app.composer.current?.focus());
  };
  if (app.active || app.page !== "chat")
    app.newChat("code", undefined, false, start);
  else start();
  return true;
}
