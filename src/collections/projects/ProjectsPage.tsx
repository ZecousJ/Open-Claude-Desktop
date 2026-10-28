import { useLocale } from "../../i18n";
import { api } from "../../desktop-api";
import { surface } from "../../../shared/host";
import { formatWebRoute, parseWebRoute } from "../../web/routes";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ProjectOverview } from "./ProjectOverview";
import { Archive, Pencil, Pin, PinOff, Trash2 } from "../../ui/glyphs";
import type { Conversation, Project } from "../../../shared/types";
import { projectKind } from "../../../shared/project-kind";
import type { Routine } from "../../../shared/routines";
import { useHost } from "../../host/HostContext";
import { PageMenu, type PageMenuEntry } from "../PageMenu";
import {
  clearProjectRequest,
  onProjectRequest,
  projectRequest,
} from "../open-requests";
import { useWideColumn } from "../useWideColumn";
import {
  projectGroups,
  projectChats,
  projectSortLabels,
  visibleProjects,
  type ProjectSort,
  type ProjectView,
} from "./project-list";
import { useResultsKeys } from "../useResultsKeys";
import "./projects.css";
import { type ProjectTemplate } from "../../dialogs/project-templates";
import { useProjectCatalogState } from "../../composer/useProjectCatalogState";
import { ProjectDetailReadState } from "./ProjectReadState";
import {
  useProjectDetailRead,
  useProjectCreationCapabilities,
} from "./project-detail-read";
import { ProjectDetailsDialog } from "../../dialogs/ProjectDetailsDialog";
import { AppContext } from "../../app/AppContext";
import { projectPlaceURL, useProjectListQuery } from "./project-list-url";
import { projectsPageView } from "./ProjectsPageView";

export type OpenMenu =
  | { kind: "sort" }
  | {
      kind: "project";
      project: Project;
      anchor: HTMLElement;
      onMemory?: () => void;
      /** The project page's own ⋮, beside its pin button. */
      page?: boolean;
    };

type ProjectActions = {
  onOpenWindow?: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onArchiveProject: (project: Project) => void;
  onSaveProject: (project: Project) => Promise<void>;
};

// Conditional checkbox after sort radios.
export function projectSortMenuEntries(
  sort: ProjectSort,
  onSort: (sort: ProjectSort) => void,
  grouping?: { checked: boolean; onSelect: () => void },
): PageMenuEntry[] {
  return [
    ...(Object.keys(projectSortLabels) as ProjectSort[]).map((value) => ({
      label: projectSortLabels[value],
      checked: sort === value,
      onSelect: () => onSort(value),
    })),
    ...(grouping
      ? [
          { separator: true as const },
          {
            label: "Group by type",
            checked: grouping.checked,
            checkedRole: "checkbox" as const,
            onSelect: grouping.onSelect,
          },
        ]
      : []),
  ];
}

// A project's menu: Pin or Unpin, Edit details, a rule, Archive and Delete in
// red; the project page's own ⋮ leaves Pin to the pin button beside it.
export function projectCardMenuEntries(
  project: Project,
  actions: ProjectActions,
  { pin = true }: { pin?: boolean } = {},
): PageMenuEntry[] {
  return [
    ...(actions.onOpenWindow
      ? [
          {
            label: "Open in new window",
            onSelect: () => actions.onOpenWindow?.(project),
          },
        ]
      : []),
    ...(project.archivedAt || !pin
      ? []
      : [
          {
            label: project.pinned ? "Unpin" : "Pin",
            icon: project.pinned ? PinOff : Pin,
            onSelect: () =>
              void actions.onSaveProject({
                ...project,
                pinned: !project.pinned,
              }),
          },
        ]),
    {
      label: "Edit details",
      icon: Pencil,
      onSelect: () => actions.onEditProject(project),
    },
    { separator: true },
    project.archivedAt
      ? {
          label: "Unarchive",
          icon: Archive,
          onSelect: () =>
            void actions.onSaveProject({ ...project, archivedAt: undefined }),
        }
      : {
          label: "Archive",
          icon: Archive,
          onSelect: () => actions.onArchiveProject(project),
        },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      onSelect: () => actions.onDeleteProject(project),
    },
  ];
}

/**
 * Projects: search, sort (Last updated, Date created, Alphabetical), New
 * project and two columns of cards with name, description and last activity;
 * each card's ⋮ edits or archives. A project opens in place with its
 * instructions, folder, files and chats, and starts new chats in it. Its files
 * are kept in the profile and chats in the project read them when they need to
 * (R13-D).
 */
export function ProjectsPage({
  projects,
  conversations,
  onNewProject,
  onDeleteProject,
  onArchiveProject,
  onOpenConversation,
  renderComposer,
  onSaveProject,
  onChooseFolder,
  onScheduled,
  onNewTask,
  onOpenTask,
}: {
  projects: Project[];
  conversations: Conversation[];
  onNewProject: (template?: ProjectTemplate) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  /** Archive asks first; Unarchive brings it straight back. */
  onArchiveProject: (project: Project) => void;
  onOpenConversation: (conversation: Conversation) => void;
  /** The app's composer, starting chats in the open project. */
  renderComposer: (project: Project) => ReactNode;
  onSaveProject: (project: Project) => Promise<void>;
  onChooseFolder: () => Promise<string | null>;
  onScheduled: () => void;
  onNewTask?: (project: Project) => void;
  onOpenTask?: (routine: Routine) => void;
}) {
  useLocale();
  const projectRead = useProjectCatalogState();
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const detailsScope = useMemo(
    () => ({}),
    [app?.accountId, app?.controllerScope, bridge],
  );
  const [details, setDetails] = useState<{ id: string; scope: object }>();
  const detailsProject =
    details?.scope === detailsScope
      ? projects.find((p) => p.id === details.id)
      : undefined;
  const host = useHost();
  const {
    search: query,
    setSearch,
    clearSearch,
    sort,
    setSort,
    grouped,
    setGrouped,
    view,
    setView,
  } = useProjectListQuery(host.kind === "web");
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || Boolean(query);
  const setQuery = (value: string | null) => {
    if (value === null) {
      clearSearch();
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
      setSearch(value);
    }
  };
  // Keep a restored empty archive reachable until the person leaves that tab.
  const anyArchived = view === "archived" || projects.some((p) => p.archivedAt);
  const tab: ProjectView = anyArchived ? view : "mine";
  const [menu, setMenu] = useState<OpenMenu>();
  const [openId, setOpenId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    if (params.get("window") === "project")
      return params.get("id") ?? undefined;
    const route =
      typeof location === "undefined"
        ? undefined
        : parseWebRoute(location.pathname, location.search);
    return route?.kind === "project" ? route.id : projectRequest();
  });
  useEffect(() => {
    clearProjectRequest();
    return onProjectRequest(setOpenId);
  }, []);
  useEffect(() => {
    if (surface !== "web") return;
    const route = parseWebRoute(location.pathname, location.search);
    const path = formatWebRoute(
      openId
        ? { kind: "project", id: openId }
        : { kind: "page", page: "projects" },
    )!;
    if (location.pathname === path) return;
    // A canonical place change owns its pathname, not unrelated query/hash state.
    const url = projectPlaceURL(openId, location);
    // Route-driven opens are already in history; a card or Back-to-projects click adds a place.
    const samePlace = route.kind === "project" ? route.id === openId : !openId;
    history[samePlace ? "replaceState" : "pushState"](history.state, "", url);
  }, [openId]);
  const column = useRef<HTMLDivElement>(null);
  const sortAnchor = useRef<HTMLSpanElement>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  // Down Arrow in the search goes to the first card, Escape in the cards back.
  const keys = useResultsKeys(searchInput, grid, () => setQuery(null));
  // The live claude.ai keeps search behind its icon at every width.
  const wide = useWideColumn(column, Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (searching && !wide) searchInput.current?.focus();
  }, [searching]);
  const detailRead = useProjectDetailRead(openId, projects, projectRead);
  const projectCreation = useProjectCreationCapabilities();
  const open = detailRead.status === "ready" ? detailRead.project : undefined;
  useEffect(() => {
    if (
      new URLSearchParams(globalThis.location?.search ?? "").get("window") ===
        "project" &&
      open
    )
      document.title = open.name;
  }, [open?.name]);
  const rows = useMemo(
    () => visibleProjects(projects, conversations, query ?? "", sort, tab),
    [projects, conversations, query, sort, tab],
  );
  const groupingAvailable =
    tab === "mine" &&
    (host.capabilities.localFolders ||
      projects.some((project) => projectKind(project) !== "chat"));
  const groups = projectGroups(rows, groupingAvailable && grouped);

  const menuEntries = (current: OpenMenu): PageMenuEntry[] =>
    current.kind === "sort"
      ? projectSortMenuEntries(
          sort,
          (value) => {
            setSort(value);
          },
          groupingAvailable
            ? {
                checked: grouped,
                onSelect: () => {
                  setGrouped(!grouped);
                },
              }
            : undefined,
        )
      : [
          ...projectCardMenuEntries(
            current.project,
            {
              onOpenWindow:
                host.kind === "desktop"
                  ? (project) =>
                      void api
                        .openProjectWindow(project.id)
                        .catch(console.error)
                  : undefined,
              onSaveProject,
              onEditProject: (project) =>
                setDetails({ id: project.id, scope: detailsScope }),
              onArchiveProject,
              onDeleteProject,
            },
            { pin: !current.page },
          ),
          ...(current.onMemory
            ? [
                { separator: true as const },
                { label: "Memory", onSelect: current.onMemory },
              ]
            : []),
        ];
  const pageMenu = menu && (
    <PageMenu
      label={
        menu.kind === "sort" ? "Sort projects" : `${menu.project.name} actions`
      }
      width={menu.kind === "sort" ? 164 : 132}
      anchor={menu.kind === "sort" ? sortAnchor : menuAnchor}
      entries={menuEntries(menu)}
      onClose={() => setMenu(undefined)}
    />
  );
  const projectMenu = (
    project: Project,
    anchor: HTMLElement,
    onMemory?: () => void,
    page?: boolean,
  ) => {
    menuAnchor.current = anchor;
    setMenu(
      menu?.kind === "project" && menu.project.id === project.id
        ? undefined
        : { kind: "project", project, anchor, onMemory, page },
    );
  };

  const detailsDialog = detailsProject && (
    <ProjectDetailsDialog
      key={detailsProject.id}
      project={detailsProject}
      onClose={() => setDetails(undefined)}
      onSave={onSaveProject}
    />
  );
  if (open)
    return (
      <>
        <ProjectOverview
          key={open.id}
          project={open}
          chats={projectChats(open, conversations)}
          composer={renderComposer(open)}
          menuOpen={menu?.kind === "project"}
          onBack={() => setOpenId(undefined)}
          onMenu={(anchor, onMemory) =>
            projectMenu(open, anchor, onMemory, true)
          }
          onSave={onSaveProject}
          onChooseFolder={onChooseFolder}
          onScheduled={onScheduled}
          onNewTask={onNewTask}
          onOpenTask={onOpenTask}
          onOpenConversation={onOpenConversation}
        />
        {detailsDialog}
        {pageMenu}
      </>
    );

  if (detailRead.status !== "list" && detailRead.status !== "ready")
    return (
      <ProjectDetailReadState
        read={detailRead}
        onBack={() => setOpenId(undefined)}
        backHref={
          host.kind === "web" && typeof location !== "undefined"
            ? projectPlaceURL(undefined, location)
            : undefined
        }
      />
    );
  const projectsPageViewView = projectsPageView({
    anyArchived,
    column,
    conversations,
    detailsDialog,
    grid,
    grouped,
    groupingAvailable,
    groups,
    host,
    keys,
    menu,
    onNewProject,
    onSaveProject,
    pageMenu,
    projectCreation,
    projectMenu,
    projectRead,
    query,
    rows,
    searchInput,
    searching,
    setMenu,
    setOpenId,
    setQuery,
    setSearchOpen,
    setView,
    sort,
    sortAnchor,
    tab,
    wide,
  });
  return projectsPageViewView;
}
