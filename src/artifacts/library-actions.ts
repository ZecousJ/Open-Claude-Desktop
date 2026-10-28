import { api } from "../desktop-api";
import { artifactIdentity } from "./artifact-metadata";
import type { AppController } from "../app/AppContext";
import type { Artifact } from "../ui/ArtifactTypes";

export async function duplicateArtifact(app: AppController, value: Artifact) {
  const bridge = window.desktop,
    account = app.accountId,
    scope = app.controllerScope;
  const current = () => {
    const now = app.currentController?.current ?? app;
    return Boolean(
      now &&
      now.accountId === account &&
      now.controllerScope === scope &&
      window.desktop === bridge,
    );
  };
  if (value.blankArtifact && value.conversationId) {
    const document = await bridge.readBlankArtifact({
      conversationId: value.conversationId,
      artifactId: value.blankArtifact.id,
    });
    if (!current()) return;
    value = { ...value, content: document.content };
  }
  const result = await bridge.duplicateArtifact({
    name: value.name,
    language: value.language,
    content: value.content,
    originConversationId: value.conversationId,
  });
  if (!current()) return;
  app.setSnapshot((current) =>
    current ? { ...current, artifactLibrary: result.library } : current,
  );
  app.setArtifact({
    ...result.artifact,
    id: result.artifact.libraryId,
    libraryId: result.artifact.libraryId,
    conversationId: result.artifact.originConversationId,
    surface: "artifact",
  });
  app.setArtifactWidth(68);
  app.setPage("artifacts");
}

export async function pinArtifact(app: AppController, value: Artifact) {
  const identity = artifactIdentity(value),
    pinned = !app.snapshot.artifactLibrary.pinned.includes(identity);
  const library = await api.pinArtifact(identity, pinned);
  app.setSnapshot((current) =>
    current ? { ...current, artifactLibrary: library } : current,
  );
}

export function requestArtifactDelete(app: AppController, value: Artifact) {
  if (!value.libraryId) return;
  app.setConfirm({
    title: "Delete artifact?",
    body: "This permanently removes the artifact. It can't be undone.",
    action: async () => {
      const library = await api.deleteArtifactCopy(value.libraryId!);
      app.setSnapshot((current) =>
        current
          ? {
              ...current,
              artifactLibrary: library,
              artifactShares: current.artifactShares.filter(
                (share) => share.identity !== artifactIdentity(value),
              ),
            }
          : current,
      );
      if (app.artifact?.libraryId === value.libraryId)
        app.setArtifact(undefined);
    },
  });
}
