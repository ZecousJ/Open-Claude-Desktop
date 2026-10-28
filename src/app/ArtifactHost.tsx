import { api } from "../desktop-api";
import { onArtifactThreadRequest } from "../artifacts/artifact-comment-message";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Conversation } from "../../shared/types";
import { latestGeneratedFiles } from "../../shared/generated-files";
import type { Artifact } from "../ui/components";
import { sameArtifact } from "../artifacts/artifact-context";
import { collectArtifacts } from "../artifacts/artifact-collection";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { fixRequest } from "../artifacts/artifact-actions";
import {
  artifactVersions,
  sameArtifactWrite,
} from "../artifacts/artifact-versions";
import { rewritingFile } from "../artifacts/generating";
import { collapsesSidebar, restoresSidebar } from "../artifacts/narrow-layout";
import { useApp, type AppController } from "./AppContext";
import { lazyPiece } from "../ui/lazy-piece";
import { artifactRouteId } from "../artifacts/artifact-route-model";
import {
  artifactChatAction,
  relatedArtifactSessions,
} from "../artifacts/related-sessions";

// The file viewer loads the first time an artifact opens, off the first load,
// as the original's viewer arrives with its own chunk; the Artifacts page is
// its own route and loads when opened.
const loadArtifactViewer = () => import("../artifacts/FileViewer");
const ArtifactPanel = lazyPiece(loadArtifactViewer, "ArtifactPanel");
const ArtifactsPage = lazyPiece(
  () => import("../artifacts/ArtifactsPage"),
  "ArtifactsPage",
);

/** The file viewer beside the conversation. */
export function ArtifactPanelHost({ artifact }: { artifact: Artifact }) {
  const app = useApp();
  // A Cowork output on screen is no longer new in the Progress card's list.
  useEffect(() => {
    if (artifact.conversationId)
      app.artifactPresentation.current.opened(
        artifact.conversationId,
        artifact.sourcePath,
      );
  }, [artifact.conversationId, artifact.sourcePath]);
  useNarrowSidebar(app);
  // Expanded, the conversation on screen beside the artifact can float over it;
  // the Artifacts page has no conversation to float.
  const chatBeside = Boolean(
    app.active && (artifact.conversationId ?? app.activeId) === app.active.id,
  );
  return (
    <Suspense fallback={null}>
      <ArtifactPanel
        artifact={artifact}
        chatBeside={chatBeside}
        {...viewerProps(app)}
      />
    </Suspense>
  );
}

/**
 * In a very narrow window the viewer takes the sidebar's room while it is open
 * and gives it back on close, unless the user reopened the sidebar meanwhile.
 * Only the opening width counts: resizing later is left to the sidebar's own
 * auto-collapse.
 */
function useNarrowSidebar(app: AppController) {
  const sidebar = useRef(app.sidebarView);
  sidebar.current = app.sidebarView;
  useEffect(() => {
    const collapsed = collapsesSidebar(innerWidth, sidebar.current.open);
    if (collapsed) sidebar.current.toggle();
    return () => {
      if (restoresSidebar(collapsed, sidebar.current.open))
        sidebar.current.show();
    };
  }, []);
}

/** The Artifacts page: the gallery and the file viewer it opens. */
export function ArtifactsRoute() {
  const app = useApp();
  const { snapshot, listed } = app;
  const openFromGallery = (value: Artifact) => {
    // An artifact made in a conversation opens there, beside it; one without a
    // conversation opens on its own page.
    if (
      app.host?.kind === "web" &&
      !value.shareRequest &&
      relatedArtifactSessions(app.snapshot, value).length
    ) {
      artifactChatAction(app, value)();
      return;
    }
    if (app.host?.kind === "web" && app.setArtifactRouteId) {
      app.setArtifactRouteId(artifactRouteId(value));
      app.setMode("chat");
      app.setArtifact(undefined);
      app.setPage("artifact");
    } else openArtifact(app, value);
  };
  const artifacts = useMemo(
    () =>
      collectArtifacts(
        listed,
        snapshot.artifactShares ?? [],
        snapshot.artifactLibrary,
      ),
    [snapshot.conversations, snapshot.artifactShares, snapshot.artifactLibrary],
  );
  return (
    <Suspense fallback={null}>
      <ArtifactsPage
        artifacts={artifacts}
        projects={snapshot.projects}
        artifact={app.host?.kind === "web" ? undefined : app.artifact}
        onOpenArtifact={openFromGallery}
        onImportArtifact={async (token) => {
          const result = await api.importSharedArtifact(token);
          app.setSnapshot((current) =>
            current ? { ...current, artifactLibrary: result.library } : current,
          );
          openFromGallery({
            ...result.artifact,
            id: result.artifact.libraryId,
            surface: "artifact",
            sharedWithYou: true,
          });
          app.setArtifactWidth(68);
        }}
        onChat={(value) => artifactChatAction(app, value)()}
        onCreate={(prompt, kind) => {
          if (kind) {
            void import("../artifacts/create-blank-artifact")
              .then(({ createBlankArtifact }) => createBlankArtifact(app, kind))
              .catch(app.report);
            return;
          }
          app.newChat();
          app.setText(
            prompt ?? "Create a personal homepage as a complete HTML file.",
          );
        }}
        {...viewerProps(app)}
      />
    </Suspense>
  );
}

/** What the file viewer does, wherever it is shown. */
export function viewerProps(app: AppController) {
  return {
    onComment: (comment: string) => sendArtifactComment(app, comment),
    // Library copies are independent of their origin, so only conversation
    // artifacts can ask their agent for a fix.
    onTryFix: artifactConversation(app)
      ? (error: string) => tryFixingArtifact(app, error)
      : undefined,
    authorName: app.snapshot.settings.name,
    onShareRequestConsumed: () =>
      app.setArtifact((value) =>
        value?.shareRequest ? { ...value, shareRequest: undefined } : value,
      ),
    onDuplicate: (value: Artifact) => duplicateArtifact(app, value),
    onPin: (value: Artifact) => pinArtifact(app, value),
    onDelete: (value: Artifact) => requestArtifactDelete(app, value),
    width: app.artifactWidth,
    onResize: app.setArtifactWidth,
    onClose: () => closeArtifact(app),
    onError: app.report,
    onNotify: app.notify,
    // Switch artifact in the title menu: the conversation's own.
    siblings: () => conversationArtifacts(app),
    onSwitch: (value: Artifact) =>
      openArtifact(app, { ...value, surface: "artifact" }),
    // The version switcher: a generated file's snapshots on this branch.
    versionsOf: (value: Artifact) => {
      if (!value.sourcePath || value.libraryId) return [];
      const conversation = app.snapshot.conversations.find(
        (c) => c.id === (value.conversationId ?? app.activeId),
      );
      return conversation
        ? artifactVersions(conversation.turns, value.sourcePath)
        : [];
    },
    onRestore: async (value: Artifact) => {
      const conversationId = value.conversationId ?? app.activeId;
      if (
        !conversationId ||
        !value.sourcePath ||
        !value.sourceDigest ||
        value.libraryId
      )
        return false;
      return api.restoreArtifactVersion(
        conversationId,
        value.sourcePath,
        value.sourceDigest,
      );
    },
  };
}

/**
 * The artifacts of the open artifact's conversation; a library copy has
 * none. The header reads it on every render (the Switch between artifacts
 * button), so it is worked out again only when the conversation gains a
 * turn, an item or a written file, a turn settles, the title or sharing or
 * the library changes, not on every streamed delta.
 */
function conversationArtifacts(app: AppController): Artifact[] {
  const conversation = artifactConversation(app);
  if (!conversation) return [];
  const last = conversation.turns.at(-1);
  const shares = app.snapshot.artifactShares ?? [];
  const library = app.snapshot.artifactLibrary;
  const written =
    last?.items.reduce(
      (n, item) => n + (item.generatedFiles?.length ?? 0),
      0,
    ) ?? 0;
  const key = `${conversation.id}:${conversation.title}:${conversation.turns.length}:${last?.status}:${last?.items.length}:${written}`;
  if (
    siblingCache?.key === key &&
    siblingCache.shares === shares &&
    siblingCache.library === library
  )
    return siblingCache.value;
  const value = collectArtifacts([conversation], shares, library).filter(
    (item) => !item.libraryId,
  );
  siblingCache = { key, shares, library, value };
  return value;
}
let siblingCache:
  | {
      key: string;
      shares: unknown;
      library: unknown;
      value: Artifact[];
    }
  | undefined;

function artifactConversation(app: AppController): Conversation | undefined {
  const { artifact } = app;
  return artifact && !artifact.libraryId
    ? app.snapshot.conversations.find(
        (c) => c.id === (artifact.conversationId ?? app.activeId),
      )
    : undefined;
}

/**
 * Shows an artifact beside the conversation; the one already shown closes
 * instead. Transcript cards retain their explicit snapshot; ordinary file
 * and gallery opens follow the latest version on this branch.
 */
export function openArtifact(app: AppController, value: Artifact) {
  const { artifact } = app;
  if (
    !value.shareRequest &&
    value.surface === "artifact" &&
    artifact?.surface === "artifact" &&
    sameArtifact(value, artifact) &&
    (!value.versionPinned || sameArtifactWrite(value, artifact))
  ) {
    closeArtifact(app);
    return;
  }
  const surface = value.surface ?? "file";
  const c = app.snapshot.conversations.find(
    (c) => c.id === (value.conversationId ?? app.activeId),
  );
  if (value.sourcePath && c) {
    const file = latestGeneratedFiles(c.turns).get(value.sourcePath);
    const current = file && generatedArtifact(file);
    if (
      value.versionPinned &&
      value.sourceDigest &&
      (!current || !sameArtifactWrite(value, current))
    ) {
      // The card carries saved text or a binary snapshot digest. Even a
      // deleted branch file must not replace that explicit historical write.
      value = {
        ...value,
        conversationId: c.id,
        surface,
        generating: undefined,
      };
    } else if (current)
      value = {
        ...current,
        conversationId: c.id,
        surface,
        shareRequest: value.shareRequest,
      };
    else if (file || !value.sourceDigest) {
      // A picture the agent viewed or drew is no file change of the branch
      // (none is listed under its path): it opens from the snapshot it carries.
      app.report(
        new Error(
          file?.error ??
            "The generated file is no longer available on this branch.",
        ),
      );
      return;
    }
  }
  // Activity stays expanded underneath the viewer, including when its title
  // menu switches to another document in the same conversation.
  if (c)
    app.artifactPresentation.current.restoreProgressAfterClose(
      c.id,
      app.panel === "progress" && c.mode !== "code" && activityInFlow(app),
      c.mode !== "code" &&
        activityInFlow(app) &&
        app.active?.id === c.id &&
        (artifact?.conversationId ?? (artifact ? app.activeId : undefined)) ===
          c.id &&
        viewerOnlyPanel(app),
    );
  rememberViewerTrigger();
  app.setArtifactWidth(surface === "artifact" ? 68 : 50);
  app.setArtifact(value);
  if (
    value.libraryId &&
    app.snapshot.artifactLibrary.copies.some(
      (copy) => copy.libraryId === value.libraryId && copy.sharedArtifactToken,
    )
  ) {
    const libraryId = value.libraryId;
    void api
      .refreshImportedArtifact(libraryId)
      .then((result) => {
        app.setSnapshot((current) =>
          current?.artifactLibrary.copies.some(
            (copy) => copy.libraryId === libraryId,
          )
            ? { ...current, artifactLibrary: result.library }
            : current,
        );
        app.setArtifact((current) =>
          current?.libraryId === libraryId
            ? {
                ...current,
                name: result.artifact.name,
                content: result.artifact.content,
                language: result.artifact.language,
              }
            : current,
        );
      })
      .catch(app.report);
  }
  if (app.panel === "progress") app.setPanel(null);
}

/*
 * The viewer gives the focus back when it closes: to what opened it (the card,
 * a row), else to the composer when the focus was lost with the panel. Fields
 * do not count as openers: the composer is the fallback for them.
 */
let viewerTrigger: HTMLElement | null = null;
const fields =
  'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])';

function rememberViewerTrigger() {
  const focused = document.activeElement;
  viewerTrigger =
    focused instanceof HTMLElement &&
    focused !== document.body &&
    !focused.matches(fields) &&
    !focused.closest(".artifact-panel")
      ? focused
      : null;
}

function returnViewerFocus(app: AppController) {
  const trigger = viewerTrigger;
  viewerTrigger = null;
  requestAnimationFrame(() => {
    if (trigger?.isConnected && !trigger.closest("[inert]")) {
      trigger.focus({ preventScroll: true });
      return;
    }
    const focused = document.activeElement;
    const lost =
      !focused ||
      focused === document.body ||
      Boolean(focused.closest("[inert]"));
    // Not on a touch screen, where focusing the composer raises the keyboard.
    if (lost && !globalThis.matchMedia?.("(pointer: coarse)").matches)
      app.composer.current?.focus({ preventScroll: true });
  });
}

/** Only the in-flow Activity expansion comes back when its viewer closes. */
function activityInFlow(app: AppController) {
  // The web phone's Activity is an overlay, not retained expansion in flow
  // (shared-16: xa); use the same breakpoint as the existing sheet rules.
  return !(
    app.host?.kind === "web" &&
    globalThis.matchMedia?.("(max-width: 639.98px)").matches
  );
}

/** No other tool pane may be displaced when Activity returns. */
function viewerOnlyPanel(app: AppController) {
  return (
    app.panel === null ||
    (app.panel === "artifact" &&
      app.toolPanels.dock.every((panel) => panel === "artifact"))
  );
}

export function closeArtifact(app: AppController) {
  const c = app.snapshot.conversations.find(
    (c) => c.id === (app.artifact?.conversationId ?? app.activeId),
  );
  if (c) app.artifactPresentation.current.dismiss(c);
  app.setArtifact(undefined);
  returnViewerFocus(app);
  app.toolPanels.close("artifact");
  const restore = c && app.artifactPresentation.current.takeRestore(c.id);
  if (
    restore &&
    c.mode !== "code" &&
    activityInFlow(app) &&
    app.active?.id === c.id &&
    viewerOnlyPanel(app)
  )
    app.setPanel("progress");
}

async function tryFixingArtifact(app: AppController, error: string) {
  if (!app.artifact) return;
  await sendAboutArtifact(app, fixRequest(app.artifact, error), "a fix");
}

async function sendArtifactComment(app: AppController, comment: string) {
  const { artifact } = app;
  if (!artifact) return;
  const context = artifact.sourcePath
    ? `File: ${artifact.sourcePath}\nSnapshot: ${artifact.sourceDigest ?? ""}`
    : `Artifact content:\n${artifact.content.slice(0, 100000)}`;
  await sendAboutArtifact(
    app,
    `Comment on artifact "${artifact.name}":\n${comment}\n\n${context}`,
    "a comment",
  );
}

/** Sends a message about the open artifact to its conversation and shows that conversation. */
async function sendAboutArtifact(
  app: AppController,
  text: string,
  what: string,
) {
  const { artifact } = app;
  if (!artifact) return;
  const conversation = app.snapshot.conversations.find(
    (c) => c.id === (artifact.conversationId ?? app.activeId),
  );
  if (!conversation)
    throw new Error(
      `Open this artifact from its conversation to send ${what}.`,
    );
  if (app.sending || conversation.turns.some((t) => t.status === "inProgress"))
    throw new Error(`Wait for the current response before sending ${what}.`);
  app.setSending(true);
  try {
    const c = await api.send({
      conversationId: conversation.id,
      text,
      mode: conversation.mode,
      cwd: conversation.cwd,
      projectId: conversation.projectId,
      providerId: conversation.providerId,
      model: conversation.model,
      attachments: [],
    });
    app.upsert(c);
    app.openConversation(c);
  } finally {
    app.setSending(false);
  }
}

async function duplicateArtifact(app: AppController, value: Artifact) {
  const actions = await loadArtifactViewer();
  return actions.duplicateArtifact(app, value);
}

export async function pinArtifact(app: AppController, value: Artifact) {
  const actions = await loadArtifactViewer();
  return actions.pinArtifact(app, value);
}

function requestArtifactDelete(app: AppController, value: Artifact) {
  void loadArtifactViewer()
    .then((actions) => actions.requestArtifactDelete(app, value))
    .catch(app.report);
}

/**
 * Keeps an open generated file at its latest version, shows it generating while
 * the agent rewrites it, and closes it once it is gone.
 */
export function useGeneratedArtifactSync(
  conversations: Conversation[] | undefined,
  artifact: Artifact | undefined,
  setArtifact: Dispatch<SetStateAction<Artifact | undefined>>,
) {
  useEffect(() => {
    if (!artifact?.sourcePath || !artifact.conversationId) return;
    const c = conversations?.find((c) => c.id === artifact.conversationId);
    if (!c) {
      setArtifact(undefined);
      return;
    }
    if (artifact.versionPinned) return;
    const file = latestGeneratedFiles(c.turns).get(artifact.sourcePath);
    const current = file && generatedArtifact(file);
    if (!current) {
      setArtifact(undefined);
      return;
    }
    // While the agent rewrites the open file the panel shows its generating
    // state.
    const generating = rewritingFile(c!.turns, artifact.sourcePath);
    if (
      current.sourceDigest !== artifact.sourceDigest ||
      current.updatedAt !== artifact.updatedAt ||
      generating !== Boolean(artifact.generating)
    )
      setArtifact({
        ...current,
        conversationId: c!.id,
        surface: artifact.surface,
        shareRequest: artifact.shareRequest,
        generating: generating || undefined,
      });
  }, [conversations, artifact]);
}

/** View thread on a comment message opens its artifact. */
export function useArtifactThreadRequests() {
  const app = useApp();
  const latest = useRef(app);
  latest.current = app;
  useEffect(
    () =>
      onArtifactThreadRequest(({ conversationId, name }) => {
        const current = latest.current;
        const conversation = current.snapshot.conversations.find(
          (c) => c.id === conversationId,
        );
        if (!conversation) return;
        const artifact = collectArtifacts(
          [conversation],
          current.snapshot.artifactShares ?? [],
          current.snapshot.artifactLibrary,
        ).find((item) => item.name === name);
        if (artifact)
          openArtifact(current, {
            ...artifact,
            conversationId,
            surface: "artifact",
          });
      }),
    [],
  );
}
