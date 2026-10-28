import { useTryPluginChat } from "../plugins/try-plugin-chat";
import { requestProject } from "../collections/open-requests";
import { api } from "../desktop-api";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerHost } from "./ComposerHost";
import { CustomizePage } from "../collections/customize/CustomizePage";
import type { Project } from "../../shared/types";
import { ProjectsPage } from "../collections/projects/ProjectsPage";
import { RoutinesPage } from "../collections/routines/RoutinesPage";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { ApiPage } from "../collections/api/ApiPage";
import { ServiceStatusPage } from "../collections/status/ServiceStatusPage";
import { SharedChatPage } from "../collections/shared/SharedChatPage";
import { HistoryPage } from "../collections/history/HistoryPage";
import {
  bulkResultMessages,
  runEach,
} from "../collections/history/bulk-actions";
import { useApp, type AppController } from "./AppContext";
import { formatText, t } from "../i18n";
import { showToast } from "../ui/toast-store";
import { requestProjectMove } from "../collections/projects/project-move-request";
import { markedUnreadByHand } from "../conversation/unread";
import { useHost } from "../host/HostContext";
import { formatWebRoute, parseWebRoute } from "../web/routes";
import {
  customizePath,
  defaultCustomizePlace,
  type CustomizePlace,
} from "../web/customize-route";

function readCustomizePlace(): CustomizePlace {
  if (typeof location === "undefined") return defaultCustomizePlace;
  const route = parseWebRoute(location.pathname, location.search);
  return route.kind === "page" && route.page === "customize"
    ? (route.customize ?? defaultCustomizePlace)
    : defaultCustomizePlace;
}

export function CustomizeRoute() {
  const app = useApp();
  const web = useHost().kind === "web";
  const [place, setPlace] = useState(readCustomizePlace);
  const tryPlugin = useTryPluginChat({ routeKey: JSON.stringify(place) });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!web) return;
    const read = () => setPlace(readCustomizePlace());
    addEventListener("popstate", read);
    addEventListener("hashchange", read);
    return () => {
      removeEventListener("popstate", read);
      removeEventListener("hashchange", read);
    };
  }, [web]);
  const show = (next: CustomizePlace) => {
    if (!mounted.current) return;
    setPlace(next);
    if (!web) return;
    const address = customizePath(next) + location.hash;
    if (address !== `${location.pathname}${location.search}${location.hash}`)
      history.pushState({ ...(history.state ?? {}), claudex: 1 }, "", address);
  };
  return (
    <CustomizePage
      route={web ? place : undefined}
      onRouteChange={web ? show : undefined}
      settings={app.snapshot.settings}
      onOpenSettings={app.openSettingsTab}
      onUsePlugin={tryPlugin}
      onUseSkill={(name: string) => {
        app.newChat();
        app.setText(`Use the ${name} skill to `);
      }}
      onConfirmRemove={(skill, remove) =>
        app.setConfirm({
          title: formatText("Remove {x}?", { x: skill.name }),
          titleIsUserData: true,
          body: "Its folder is deleted from this profile. Chats that used it are kept.",
          action: remove,
        })
      }
      onError={app.report}
    />
  );
}

interface ScheduledPlace {
  view: "yours" | "templates";
  detailId?: string;
}

function readScheduledPlace(): ScheduledPlace {
  if (typeof location === "undefined") return { view: "yours" };
  const route = parseWebRoute(location.pathname, location.search);
  if (route.kind !== "page" || route.page !== "scheduled")
    return { view: "yours" };
  return { view: route.view ?? "yours", detailId: route.taskId };
}

/** Scheduled list, templates and detail addresses share the real task data. */
export function ScheduledRoute() {
  const app = useApp();
  const { snapshot } = app;
  const web = useHost().kind === "web";
  const [place, setPlace] = useState(readScheduledPlace);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latestPlace = useRef(place);
  latestPlace.current = place;
  useEffect(() => {
    if (!web) return;
    const onPop = () => {
      const next = readScheduledPlace();
      latestPlace.current = next;
      setPlace(next);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [web]);
  const show = (next: ScheduledPlace) => {
    // A save/delete can finish after its editor and page were left.
    if (!mounted.current) return;
    latestPlace.current = next;
    setPlace(next);
    const url = formatWebRoute({
      kind: "page",
      page: "scheduled",
      view: next.view === "templates" ? "templates" : undefined,
      taskId: next.detailId,
    });
    const destination = url && `${url}${location.hash}`;
    if (
      destination &&
      `${location.pathname}${location.search}${location.hash}` !== destination
    )
      history.pushState(history.state ?? { claudex: 1 }, "", destination);
  };
  return (
    <RoutinesPage
      view={web ? place.view : undefined}
      onViewChange={
        web
          ? (view) =>
              show({
                view,
                detailId:
                  view === latestPlace.current.view
                    ? latestPlace.current.detailId
                    : undefined,
              })
          : undefined
      }
      detailId={web ? place.detailId : undefined}
      onDetailChange={
        web ? (detailId) => show({ view: "yours", detailId }) : undefined
      }
      settings={snapshot.settings}
      conversations={snapshot.conversations}
      approvals={snapshot.approvals}
      onError={app.report}
      onChooseFolder={() => api.chooseFolder()}
      projects={snapshot.projects}
      onOpenProject={(id: string) => {
        requestProject(id);
        app.setPage("projects");
      }}
      onOpenConversation={(id: string) => {
        const conversation = snapshot.conversations.find((c) => c.id === id);
        if (conversation) app.openConversation(conversation);
        else app.report(new Error("That run's chat is no longer available."));
      }}
      onConfirmDelete={(routine, remove) =>
        app.setConfirm({
          title: "Delete scheduled task?",
          confirm: "Delete",
          danger: true,
          body: formatText(
            "Delete “{taskName}”? Any sessions from this task will be archived.",
            { taskName: routine.name },
          ),
          action: remove,
        })
      }
    />
  );
}

export function SharedRoute() {
  return <SharedChatPage />;
}

export function ApiRoute() {
  return <ApiPage />;
}

export function StatusRoute() {
  return <ServiceStatusPage />;
}

export function ProjectsRoute() {
  const app = useApp();
  return (
    <ProjectsPage
      projects={app.snapshot.projects}
      conversations={app.listed}
      onNewProject={(template) => {
        if (!template) return app.startProject();
        app.setProjectEditor({
          id: crypto.randomUUID(),
          name: "",
          description: t(template.description),
          instructions: "",
          createdAt: Date.now(),
        });
      }}
      onEditProject={app.setProjectEditor}
      onDeleteProject={(project) => confirmDeleteProject(app, project)}
      onArchiveProject={(project) => confirmArchiveProject(app, project)}
      onOpenConversation={app.openConversation}
      renderComposer={(project) => <ProjectComposer project={project} />}
      onSaveProject={async (project) => {
        const saved = await api.saveProject(project);
        app.setSnapshot((current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((p) =>
                  p.id === saved.id ? saved : p,
                ),
              }
            : current,
        );
      }}
      onChooseFolder={() => api.chooseFolder()}
      onScheduled={() => app.setPage("scheduled")}
      onNewTask={(project) => {
        requestScheduleConfirmation({
          description: "",
          blank: true,
          projectId: project.id,
          cwd: project.cwd,
        });
        app.setPage("scheduled");
      }}
      onOpenTask={(routine) => {
        requestScheduleConfirmation({ description: "", routineId: routine.id });
        app.setPage("scheduled");
      }}
    />
  );
}

/**
 * The project page's composer: the app's own, as a new draft in the project, so
 * sending starts a chat there and opens it.
 */
function ProjectComposer({ project }: { project: Project }) {
  const app = useApp();
  useEffect(() => {
    if (app.activeId) app.setActiveId(undefined);
    if (app.mode === "code") app.setMode("chat");
    app.setProjectId(project.id);
    app.setEffort(undefined);
    if (project.cwd) app.setCwd(project.cwd);
  }, [project.id]);
  return <ComposerHost projectOverview />;
}

/**
 * Archive project: it leaves the list for the Archived tab; its chats, tasks
 * and files stay.
 */
export function confirmArchiveProject(app: AppController, project: Project) {
  app.setConfirm({
    title: "Archive project",
    body: formatText(
      "“{spaceName}” will be removed from your projects. Tasks, scheduled tasks, and files won’t be deleted.",
      { spaceName: project.name },
    ),
    confirm: "Archive",
    action: async () => {
      try {
        const saved = await api.saveProject({
          ...project,
          archivedAt: Date.now(),
        });
        app.setSnapshot((current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((p) =>
                  p.id === saved.id ? saved : p,
                ),
              }
            : current,
        );
        showToast(t("Project archived"));
      } catch (error) {
        app.report(
          new Error(t("Failed to archive project. You can try again."), {
            cause: error,
          }),
        );
      }
    },
  });
}

/** Confirmation title. */
export function confirmDeleteProject(app: AppController, project: Project) {
  app.setConfirm({
    title: "Delete project?",
    confirm: "Delete",
    body: formatText(
      "“{spaceName}” will be deleted. Its chats stay in your history, outside any project.",
      { spaceName: project.name },
    ),
    action: async () => {
      await api.deleteProject(project.id);
      app.setSnapshot((current) =>
        current
          ? {
              ...current,
              projects: current.projects.filter((p) => p.id !== project.id),
              conversations: current.conversations.map((c) =>
                c.projectId === project.id ? { ...c, projectId: undefined } : c,
              ),
            }
          : current,
      );
      if (app.projectId === project.id) app.setProjectId(undefined);
    },
  });
}

export function HistoryRoute() {
  const app = useApp();
  return (
    <HistoryPage
      mode={app.mode}
      conversations={app.listed}
      projects={app.snapshot.projects}
      onNewChat={() => app.newChat()}
      onOpenConversation={app.openConversation}
      onArchive={(ids, archived) => bulkArchive(app, ids, archived)}
      onConfirmArchive={(ids, done) => {
        const count = ids.filter((id) =>
          app.listed.some((row) => row.id === id && row.mode === "cowork"),
        ).length;
        app.setConfirm({
          title: "Archive selected tasks?",
          confirm: "Archive",
          danger: false,
          body: formatText(
            count === 1
              ? "1 task will be moved to Archived."
              : "{count} tasks will be moved to Archived.",
            { count },
          ),
          action: async () => done(await bulkArchive(app, ids, true)),
        });
      }}
      onUpdateSelection={async (ids, patch) => {
        const { failed, error } = await runEach(ids, async (id) => {
          if (patch.unread) markedUnreadByHand.add(id);
          try {
            app.upsert(await api.updateConversation(id, patch));
          } catch (error) {
            if (patch.unread) markedUnreadByHand.delete(id);
            throw error;
          }
        });
        if (failed.length) app.report(error);
        return failed;
      }}
      approvalIds={app.approvalIds}
      onMoveToProject={requestProjectMove}
      onDelete={(ids, done) => confirmBulkDelete(app, ids, done)}
      onRename={(conversation) =>
        app.setRename({ id: conversation.id, title: conversation.title })
      }
    />
  );
}

/**
 * Deletes the rows chosen on the History page after one confirmation. A
 * failure does not stop the rest; the failed rows are reported together
 * and handed back so the page keeps just them selected.
 */
export function confirmBulkDelete(
  app: AppController,
  ids: string[],
  done: (failed: string[]) => void,
) {
  const count = ids.length;
  const stay = app.page;
  const { activeId } = app;
  app.setConfirm({
    title: "Delete selected?",
    confirm: "Delete",
    body: formatText(
      count === 1
        ? "1 item will be permanently deleted. This cannot be undone."
        : "{count} items will be permanently deleted. This cannot be undone.",
      { count },
    ),
    action: async () => {
      const { failed } = await runEach(ids, async (id) => {
        await api.deleteConversation(id);
        app.setSnapshot((current) =>
          current
            ? {
                ...current,
                conversations: current.conversations.filter(
                  (value) => value.id !== id,
                ),
              }
            : current,
        );
      });
      // Clear the deleted open conversation without leaving the page.
      if (activeId && ids.includes(activeId) && !failed.includes(activeId)) {
        app.newChat();
        app.setPage(stay);
      }
      for (const message of bulkResultMessages("delete", count, failed.length))
        showToast(message);
      done(failed);
    },
  });
}

/** Archives or restores History rows; reports and returns the failures. */
async function bulkArchive(
  app: AppController,
  ids: string[],
  archived: boolean,
) {
  const { failed } = await runEach(ids, async (id) =>
    app.upsert(await api.updateConversation(id, { archived })),
  );
  for (const message of bulkResultMessages(
    archived ? "archive" : "unarchive",
    ids.length,
    failed.length,
  ))
    showToast(message);
  return failed;
}
