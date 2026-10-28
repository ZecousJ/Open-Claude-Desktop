import { useAppDraft } from "../composer/draft-text";
import { api } from "../desktop-api";
import { Suspense, useEffect, useMemo, useRef } from "react";
import type { Attachment, Mode } from "../../shared/types";
import { ConversationManageDialog } from "../dialogs/ConversationManageDialog";
import { collectArtifacts } from "../artifacts/artifact-collection";
import { requestProject } from "../collections/open-requests";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { openArtifact } from "./ArtifactHost";
import { sendDraft } from "./composer-send";
import { useApp } from "./AppContext";
import { lazyPiece } from "../ui/lazy-piece";
import { moveProjectChats } from "../collections/projects/project-move";
import { showToast } from "../ui/toast-store";
import { t } from "../i18n";

// The project editor loads the first time it opens, off the first load.
const ProjectEditorDialog = lazyPiece(
  () => import("../dialogs/ProjectEditorDialog"),
  "ProjectEditorDialog",
);

// ⌘K search loads the first time it opens (the web app's first load).
const SearchPalette = lazyPiece(
  () => import("../collections/search/SearchPalette"),
  "SearchPalette",
);

/**
 * ⌘K: search over conversations, projects, routines and artifacts, and Compose,
 * which starts a new chat, task or session through the composer's own send once
 * the new draft holds the message.
 */
export function SearchOverlay() {
  const app = useApp();
  const { search, setSearch, snapshot } = app;
  const draftText = useAppDraft(app).text;
  const composing = useRef<{ mode: Mode; text: string }>(undefined);
  useEffect(() => {
    const pending = composing.current;
    if (
      pending &&
      app.page === "chat" &&
      !app.activeId &&
      app.mode === pending.mode &&
      draftText === pending.text
    ) {
      composing.current = undefined;
      void sendDraft(app);
    }
  });
  const artifacts = useMemo(
    () =>
      search === null
        ? []
        : collectArtifacts(
            app.listed,
            snapshot.artifactShares ?? [],
            snapshot.artifactLibrary,
          ),
    [
      search === null,
      snapshot.conversations,
      snapshot.artifactShares,
      snapshot.artifactLibrary,
    ],
  );
  const sources = useMemo(
    () => ({
      conversations: app.listed,
      approvals: snapshot.approvals,
      projects: snapshot.projects,
      artifacts,
    }),
    [app.listed, snapshot.projects, snapshot.approvals, artifacts],
  );
  // What is typed between ⌘K and the palette's first paint (its code loads the
  // first time) goes into its search field, not where the focus was.
  const open = search !== null;
  useEffect(() => {
    if (!open) return;
    const buffer = (event: KeyboardEvent) => {
      if (document.querySelector(".search-palette")) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing)
        return;
      if (event.key === "Backspace") {
        event.preventDefault();
        setSearch((current) =>
          current === null ? null : current.slice(0, -1),
        );
      } else if (event.key.length === 1) {
        event.preventDefault();
        event.stopPropagation();
        setSearch((current) => (current === null ? null : current + event.key));
      }
    };
    addEventListener("keydown", buffer, true);
    return () => removeEventListener("keydown", buffer, true);
  }, [open, setSearch]);
  if (search === null) return null;
  const close = () => setSearch(null);
  return (
    <Suspense fallback={null}>
      <SearchPalette
        mode={app.mode}
        entrypoint={app.searchEntrypoint}
        onEntrypointChange={app.setSearchEntrypoint}
        sources={sources}
        loadRoutines={() => api.listSchedules()}
        query={search}
        onQueryChange={setSearch}
        onOpen={(row) => {
          close();
          if (row.kind === "conversation")
            app.openConversation(row.conversation);
          else if (row.kind === "project") {
            requestProject(row.project.id);
            app.setPage("projects");
          } else if (row.kind === "routine") {
            requestScheduleConfirmation({
              description: "",
              openRoutineId: row.routine.id,
            });
            app.setPage("scheduled");
          } else openArtifact(app, row.artifact);
        }}
        onNew={(mode) => {
          close();
          app.newChat(mode);
        }}
        onCompose={(mode, text: string, files: Attachment[]) => {
          close();
          composing.current = { mode, text };
          app.newChat(mode);
          app.setText(text);
          app.setAttachments(files);
        }}
        onChooseFiles={() => api.chooseAttachments()}
        onRename={(conversation) => {
          close();
          app.setRename({ id: conversation.id, title: conversation.title });
        }}
        onArchive={(conversation) =>
          void app.patchConversation(conversation, {
            archived: !conversation.archived,
          })
        }
        onDelete={(conversation) => {
          close();
          app.confirmDelete(conversation);
        }}
        onClose={close}
      />
    </Suspense>
  );
}

export function RenameOverlay() {
  const app = useApp();
  const { rename, setRename } = app;
  if (!rename) return null;
  return (
    <ConversationManageDialog
      draft={rename}
      onChange={setRename}
      onClose={() => setRename(undefined)}
      conversation={app.snapshot.conversations.find(
        (value) => value.id === rename.id,
      )}
      onPatch={(conversation, patch) =>
        void app.patchConversation(conversation, patch)
      }
    />
  );
}

/** Creates or edits a project; a new project can take the conversation it was started from. */
export function ProjectEditorOverlay() {
  const app = useApp();
  const {
    snapshot,
    projectEditor,
    setProjectEditor,
    projectAssignee,
    setProjectAssignee,
    setSnapshot,
  } = app;
  const owner = useMemo(
    () => ({
      bridge: window.desktop,
      account: app.accountId,
      scope: app.controllerScope,
      editor: projectEditor?.id,
    }),
    [window.desktop, app.accountId, app.controllerScope, projectEditor?.id],
  );
  const latestOwner = useRef(owner);
  latestOwner.current = owner;
  const lifecycle = useRef({ active: true });
  useEffect(() => {
    const lease = { active: true };
    lifecycle.current = lease;
    return () => {
      lease.active = false;
    };
  }, []);
  if (!projectEditor) return null;
  return (
    <Suspense fallback={null}>
      <ProjectEditorDialog
        projects={snapshot.projects}
        providers={snapshot.settings.providers}
        onArchive={() => {
          const project = snapshot.projects.find(
            (value) => value.id === projectEditor.id,
          );
          if (!project) return;
          if (project.archivedAt) {
            void api
              .saveProject({ ...project, archivedAt: undefined })
              .then((saved) => {
                setSnapshot((current) =>
                  current
                    ? {
                        ...current,
                        projects: current.projects.map((value) =>
                          value.id === saved.id ? saved : value,
                        ),
                      }
                    : current,
                );
                setProjectEditor(undefined);
              })
              .catch(app.report);
          } else {
            setProjectEditor(undefined);
            void import("./CollectionPages")
              .then((pages) => pages.confirmArchiveProject(app, project))
              .catch(app.report);
          }
        }}
        onDelete={() => {
          const project = snapshot.projects.find(
            (value) => value.id === projectEditor.id,
          );
          if (!project) return;
          setProjectEditor(undefined);
          void import("./CollectionPages")
            .then((pages) => pages.confirmDeleteProject(app, project))
            .catch(app.report);
        }}
        project={projectEditor}
        coworkCreation={!projectAssignee}
        isExisting={snapshot.projects.some((p) => p.id === projectEditor.id)}
        onChange={setProjectEditor}
        onClose={() => {
          setProjectEditor(undefined);
          setProjectAssignee(undefined);
        }}
        onChooseFolder={(title) => api.chooseFolder(title)}
        onError={app.report}
        onSave={async (project, creation) => {
          const lease = lifecycle.current;
          const current = () => {
            const controller = app.currentController?.current;
            return (
              lease.active &&
              latestOwner.current === owner &&
              window.desktop === owner.bridge &&
              (!app.currentController ||
                Boolean(
                  controller &&
                  controller.accountId === owner.account &&
                  controller.controllerScope === owner.scope &&
                  controller.projectEditor?.id === owner.editor,
                ))
            );
          };
          const { saveProjectCreation } =
            await import("./save-project-creation");
          const saved = await saveProjectCreation(
            owner.bridge,
            project,
            creation,
            current,
          );
          if (!current()) return;
          const existed = snapshot.projects.some(
            (value) => value.id === saved.id,
          );
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  projects: current.projects.some(
                    (value) => value.id === saved.id,
                  )
                    ? current.projects.map((value) =>
                        value.id === saved.id ? saved : value,
                      )
                    : [...current.projects, saved],
                }
              : current,
          );
          setProjectEditor(undefined);
          const assignee = snapshot.conversations.find(
            (c) => c.id === projectAssignee,
          );
          if (existed) showToast(t("Settings saved."));
          setProjectAssignee(undefined);
          if (assignee) {
            await moveProjectChats(app, [assignee], saved);
          }
          // A new project opens once it is made; an edited one stays where it
          // is.
          if (!existed && !assignee) {
            requestProject(saved.id);
            app.setPage("projects");
          }
        }}
      />
    </Suspense>
  );
}
