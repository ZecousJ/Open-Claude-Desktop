import type { Conversation, Snapshot } from "../../shared/types";
import { isDeviceExecutionCopy } from "../../shared/chat-devices-api";
import type { AppController } from "../app/AppContext";
import type { Artifact } from "../ui/ArtifactTypes";
import { collectArtifacts } from "./artifact-collection";
import { artifactRouteId, findRoutedArtifact } from "./artifact-route-model";
import { deferFileTransition } from "../files/file-transitions";
import { formatText, t } from "../i18n";

type ArtifactSnapshot = Pick<
  Snapshot,
  "conversations" | "artifactLibrary" | "artifactShares"
>;
const visibleConversations = (snapshot: ArtifactSnapshot) =>
  snapshot.conversations.filter(
    (c) => !c.incognito && !isDeviceExecutionCopy(c),
  );
function ownedArtifact(snapshot: ArtifactSnapshot, artifact: Artifact) {
  return findRoutedArtifact(
    collectArtifacts(
      visibleConversations(snapshot),
      snapshot.artifactShares ?? [],
      snapshot.artifactLibrary ?? { version: 1, copies: [], pinned: [] },
    ),
    artifactRouteId(artifact),
  );
}

/** The current protocol records one owning conversation, or a saved copy's
 * explicit originConversationId. Imports have no local origin. Matching titles,
 * contents, paths in another conversation, or the selected chat is not a link.
 * A graph of multiple related sessions is not present in this protocol. */
export function relatedArtifactSessions(
  snapshot: ArtifactSnapshot,
  artifact: Artifact,
): Conversation[] {
  const owned = ownedArtifact(snapshot, artifact);
  if (!owned) return [];
  let id = owned.conversationId;
  if (owned.libraryId) {
    const copies = snapshot.artifactLibrary.copies.filter(
      (copy) => copy.libraryId === owned.libraryId,
    );
    if (copies.length !== 1 || copies[0].sharedArtifactToken) return [];
    id = copies[0].originConversationId;
  }
  const candidates = visibleConversations(snapshot).filter((c) => c.id === id);
  return candidates.length === 1 ? candidates : [];
}

export function artifactChatLabel(count: number | undefined) {
  if (count === undefined) return t("Chat with Claudex");
  return formatText(
    count === 1
      ? "{action} · {count} session here"
      : "{action} · {count} sessions here",
    { action: t("Chat with Claudex"), count },
  );
}

/** Revalidate the actual identity and owner when a deferred editor navigation
 * resumes. Retained callbacks cannot open another account or an obsolete route. */
function artifactNavigationOwner(app: AppController, artifact: Artifact) {
  const account = app.accountId,
    scope = app.controllerScope,
    bridge = window.desktop;
  const page = app.page,
    route = app.artifactRouteId,
    activeId = app.activeId,
    mode = app.mode,
    selection = app.artifact ? artifactRouteId(app.artifact) : undefined;
  const current = () => {
    const now = app.currentController ? app.currentController.current : app;
    if (
      !now ||
      now.accountId !== account ||
      now.controllerScope !== scope ||
      window.desktop !== bridge ||
      now.page !== page ||
      now.activeId !== activeId ||
      now.mode !== mode ||
      (page !== "artifact" &&
        selection &&
        (!now.artifact || artifactRouteId(now.artifact) !== selection)) ||
      (page === "artifact" && now.artifactRouteId !== route)
    )
      return;
    const owned = ownedArtifact(now.snapshot, artifact);
    return owned ? { app: now, artifact: owned } : undefined;
  };
  return current;
}

export function guardArtifactNavigation(
  app: AppController,
  artifact: Artifact,
  action: () => void,
) {
  const current = artifactNavigationOwner(app, artifact);
  return () => {
    if (current()) action();
  };
}

export function artifactChatAction(app: AppController, artifact: Artifact) {
  const current = artifactNavigationOwner(app, artifact);
  const resume = () => {
    const context = current();
    if (!context) return;
    const { app: now, artifact: owned } = context;
    const sessions = relatedArtifactSessions(now.snapshot, owned);
    if (sessions.length) {
      const conversation = sessions[0];
      now.openConversation(
        conversation,
        !owned.libraryId && conversation.mode !== "code"
          ? { artifactId: artifactRouteId(owned) }
          : undefined,
      );
      if (owned.libraryId || conversation.mode === "code")
        now.setArtifact({ ...owned, surface: "artifact" });
    } else {
      now.newChat("chat");
      now.setArtifact({ ...owned, surface: "artifact" });
    }
  };
  return () => {
    if (current() && !deferFileTransition(resume)) resume();
  };
}
