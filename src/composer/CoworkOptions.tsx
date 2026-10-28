import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Plus } from "../ui/glyphs";
import type { Conversation, Project } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { preference } from "../../shared/settings-extras";
import { useHost, useHostCapability } from "../host/HostContext";
import {
  FolderIcon,
  FolderPlusIcon,
  ProjectsIcon,
  SearchIcon,
} from "../ui/icons";
import { folderName, recentWorkFolders } from "./recentFolders";
import { requestFolderAccess } from "../cowork/useFolderAccess";
import { AppIcon } from "../ui/app-icon";
import { coworkPlaceRows, coworkPlaceUsage } from "./cowork-options-model";
import "./cowork-options.css";
import { ProjectPicker } from "./ProjectPicker";
import { NativeProjectPickerShell } from "./NativeProjectPickerShell";
import { useT } from "../i18n";

type Open = "place" | undefined;

/**
 * The project or folder picker under the home composer. The unified home has no
 * Output menu: Docs, Slides and Design are on by default and chosen from the
 * request. On the web there are no local folders, so the place is a project
 * ("Project", ref-web-chat-home) and its menu lists projects only.
 *
 * Chat's unified home is host aware: the web offers projects only; the desktop
 * also offers its real local folders (1016 shared-19 Yb/hW and shared-8 oD/ap).
 * A desktop Chat must not inherit the web-only picker.
 */
export function CoworkOptions({
  variant = "cowork",
  platform,
  cwd,
  setCwd,
  project,
  projects,
  onProject,
  onCreateProject,
  onNewProject,
  pickFolder,
  collapsed = false,
  projectsOnly = false,
}: {
  /** "chat": the unified home's host-specific project/folder picker. */
  variant?: "cowork" | "chat";
  /** Incognito Chat keeps project context without exposing local folders. */
  projectsOnly?: boolean;
  /**
   * A task window's composer: an icon-only trigger with a count badge once a
   * project or folder is chosen, its menu opening above.
   */
  collapsed?: boolean;
  platform: NodeJS.Platform;
  cwd?: string;
  setCwd: (cwd?: string) => void;
  project?: Project;
  projects: Project[];
  onProject: (id: string) => void;
  onCreateProject: (name?: string) => void;
  /** The chin picker opens the creation form with this optional initial name. */
  onNewProject?: (name?: string) => void;
  pickFolder: () => Promise<void>;
}) {
  const app = useContext(AppContext);
  const host = useHost();
  const t = useT();
  // While sync with the web is on, Cowork runs in the cloud (its own
  // workspace there): this computer's folders are not offered, as on the web.
  const chat = variant === "chat";
  const localFolders =
    useHostCapability("localFolders") &&
    !projectsOnly &&
    host.kind === "desktop" &&
    (chat || !(app && preference(app.snapshot.settings, "cloudSync")));
  const nativeChat = chat && localFolders;
  const conversations = app?.snapshot.conversations;
  const folders = useMemo(
    () => (localFolders ? recentWorkFolders(conversations ?? []) : []),
    [conversations, localFolders],
  );
  const [open, setOpen] = useState<Open>();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const placeButton = useRef<HTMLButtonElement>(null);
  const placeMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !placeMenu.current?.contains(event.target as Node)
      )
        setOpen(undefined);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open !== "place") {
      setQuery("");
    }
  }, [open]);
  const close = () => {
    setOpen(undefined);
    placeButton.current?.focus();
  };
  const keydown = (event: KeyboardEvent<HTMLDivElement>) =>
    menuKeydown(event, close);
  // Projects and folders in one list, the most recently used first.
  const places = useMemo(
    () =>
      coworkPlaceRows(
        projects,
        !localFolders
          ? []
          : cwd && !folders.includes(cwd)
            ? [cwd, ...folders]
            : folders,
        query,
        coworkPlaceUsage(conversations ?? []),
      ),
    [projects, localFolders, cwd, folders, query, conversations],
  );
  const choose = (action: () => void) => {
    action();
    close();
  };
  /**
   * Cowork asks before it uses a folder of the person's: the choice applies
   * once they allow it; Cancel keeps the previous choice.
   */
  const chooseFolder = (
    path: string | undefined,
    apply: () => void,
    projectId?: string,
  ) =>
    choose(() => {
      if (!path) return apply();
      // A project's folder: an "Allow" for the project already counts.
      requestFolderAccess(path, {
        notify: app?.notify,
        ...(projectId ? { projectId } : {}),
      }).then(
        (result) => {
          if (result === "granted") apply();
        },
        (e: unknown) => app?.report(e),
      );
    });
  // A native project with cwd is a local folder selection, so authorize it
  // before invoking the project callback (which also updates cwd). A project
  // without cwd remains project context and preserves an existing folder.
  // Web Chat uses ProjectPicker above this menu and never requests local
  // filesystem access. Source: shared-8 NF/selectWithTrustCheck.
  const pickPlace = (place: (typeof places)[number]) =>
    place.kind === "project"
      ? chat && !nativeChat
        ? choose(() => onProject(place.project.id))
        : chooseFolder(
            place.project.cwd,
            () => onProject(place.project.id),
            place.project.id,
          )
      : chooseFolder(place.path, () => setCwd(place.path));
  // Native Chat can retain project instructions plus an independent folder.
  // The official RE label prefers the project and counts its extra contexts.
  const onProjectFolder = Boolean(
    project && (chat || !cwd || cwd === project.cwd),
  );
  const extraNativeFolder = Boolean(
    nativeChat && project && cwd && cwd !== project.cwd,
  );
  const folderChecked = (path: string) =>
    (!onProjectFolder || extraNativeFolder) && cwd === path;
  const placeLabel = onProjectFolder
    ? `${project!.name}${extraNativeFolder ? " +1" : ""}`
    : cwd && localFolders
      ? folderName(cwd)
      : localFolders
        ? "Project or folder"
        : "Project";
  // A chosen project or folder shows as a chip with its glyph and a chevron;
  // Cowork's placeholder stays plain text, the Chat home's "Project" keeps its
  // caret (the live chin's project slot).
  const chosen = onProjectFolder
    ? "project"
    : cwd && localFolders
      ? "folder"
      : undefined;
  const menu = open === "place" && (
    <div
      ref={placeMenu}
      className="cowork-menu cowork-place-menu"
      role="menu"
      aria-label={localFolders ? "Project or folder" : "Project"}
      onKeyDown={keydown}
    >
      <label className="cowork-menu-search">
        <SearchIcon size={16} />
        <input
          autoFocus
          value={query}
          placeholder="Search projects"
          aria-label="Search projects"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter picks the first match.
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return;
            event.preventDefault();
            if (places[0]) pickPlace(places[0]);
          }}
        />
      </label>
      <div className="cowork-menu-list">
        {places.map((place) =>
          place.kind === "project" ? (
            <button
              key={place.project.id}
              role={nativeChat ? "menuitemcheckbox" : "menuitemradio"}
              aria-checked={onProjectFolder && project?.id === place.project.id}
              className="group"
              onClick={() => pickPlace(place)}
            >
              <AppIcon name="Projects" size="md" animated />
              <span className="cowork-menu-text">
                <strong>{place.project.name}</strong>
              </span>
              {onProjectFolder && project?.id === place.project.id && (
                <Check size={14} />
              )}
            </button>
          ) : (
            <button
              key={place.path}
              role={nativeChat ? "menuitemcheckbox" : "menuitemradio"}
              aria-checked={folderChecked(place.path)}
              title={place.path}
              onClick={() => pickPlace(place)}
            >
              <FolderIcon size={20} strokeWidth={1.25} />
              <span className="cowork-menu-text">
                <strong>{folderName(place.path)}</strong>
                <small>{place.path}</small>
              </span>
              {folderChecked(place.path) && <Check size={14} />}
            </button>
          ),
        )}
        {!places.length && (
          <p className="cowork-menu-empty">
            {query.trim() ? "No matches" : "No projects yet."}
          </p>
        )}
      </div>
      <div className="cowork-menu-separator" role="separator" />
      <button
        role="menuitem"
        onClick={() => choose(() => (onNewProject ?? onCreateProject)())}
      >
        <Plus size={20} strokeWidth={1.75} />
        <span className="cowork-menu-text">
          <strong>New project</strong>
        </span>
      </button>
      {localFolders && (
        <button role="menuitem" onClick={() => choose(() => void pickFolder())}>
          <FolderPlusIcon size={20} strokeWidth={1.25} />
          <span className="cowork-menu-text">
            <strong>Add folder</strong>
          </span>
        </button>
      )}
    </div>
  );
  if (nativeChat)
    return (
      <NativeProjectPickerShell
        project={project}
        projects={projects}
        onProject={onProject}
        onCreateProject={onNewProject ?? (() => onCreateProject())}
        collapsed={collapsed}
        platform={platform}
        cwd={cwd}
        setCwd={setCwd}
        pickFolder={pickFolder}
      />
    );
  if (chat)
    return (
      <ProjectPicker
        label={
          projectsOnly &&
          host.kind === "desktop" &&
          host.capabilities.localFolders
            ? t("Project or folder")
            : undefined
        }
        project={project}
        projects={projects}
        onProject={onProject}
        onCreateProject={onNewProject ?? (() => onCreateProject())}
        collapsed={collapsed}
        platform={platform}
      />
    );
  return (
    <div
      ref={root}
      className="cowork-options"
      data-variant={variant}
      data-picker-surface={nativeChat ? "desktop-chat" : undefined}
      data-collapsed={collapsed || undefined}
    >
      {collapsed ? (
        <button
          ref={placeButton}
          type="button"
          className={`cowork-place-collapsed${open === "place" ? " open" : ""}`}
          title={cwd ?? project?.cwd}
          aria-label={placeLabel}
          aria-haspopup="menu"
          aria-expanded={open === "place"}
          onClick={() => setOpen(open === "place" ? undefined : "place")}
        >
          {chosen === "folder" ? (
            <FolderIcon size={16} strokeWidth={1.25} />
          ) : (
            <ProjectsIcon size={16} strokeWidth={1.25} />
          )}
          {chosen && (
            <span className="cowork-place-badge" aria-hidden="true">
              1
            </span>
          )}
        </button>
      ) : (
        <button
          ref={placeButton}
          type="button"
          className={`${open === "place" ? "open" : ""} ${chosen ? "cowork-place-chosen" : ""}`}
          title={cwd ?? project?.cwd}
          aria-haspopup="menu"
          aria-expanded={open === "place"}
          onClick={() => setOpen(open === "place" ? undefined : "place")}
        >
          {!nativeChat && chosen === "project" && (
            <ProjectsIcon size={16} strokeWidth={1.25} />
          )}
          {!nativeChat && chosen === "folder" && (
            <FolderIcon size={16} strokeWidth={1.25} />
          )}
          <span data-no-translate={chosen ? true : undefined}>
            {placeLabel}
          </span>
          {(chosen || chat) && <ChevronDown size={12} strokeWidth={1.5} />}
        </button>
      )}
      {menu}
    </div>
  );
}

/** Escape closes a menu; the arrow keys move through its rows. */
export function menuKeydown(
  event: KeyboardEvent<HTMLDivElement>,
  close: () => void,
) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  );
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    index < 0
      ? event.key === "ArrowDown"
        ? 0
        : rows.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
        rows.length;
  rows[next]?.focus();
}
