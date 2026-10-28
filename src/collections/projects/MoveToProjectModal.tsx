import { FolderInput } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Users } from "../../ui/glyphs";
import type { Conversation, Project } from "../../../shared/types";
import { Modal } from "../../ui/Controls";
import { Skeleton } from "../../ui/Skeleton";
import { AppIcon } from "../../ui/app-icon";
import { formatText, t } from "../../i18n";
import { useApp } from "../../app/AppContext";
import {
  closeProjectMove,
  useProjectMoveRequest,
} from "./project-move-request";
import { createMoveProject, moveProjectChats } from "./project-move";
import "./project-move.css";

type MoveProject = Project & { isPrivate?: boolean };

export function moveTargets(
  projects: readonly MoveProject[],
  query: string,
  currentProjectId?: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return projects
    .filter(
      (project) =>
        !project.archivedAt &&
        project.id !== currentProjectId &&
        (!search || project.name.toLocaleLowerCase().includes(search)),
    )
    .slice(0, 30);
}

/** Search, create and list states. */
export function ProjectMoveList({
  projects,
  query,
  searchQuery = query,
  currentProjectId,
  loading,
  hasError,
  creating,
  onPick,
  onCreate,
}: {
  projects: readonly MoveProject[];
  query: string;
  searchQuery?: string;
  currentProjectId?: string;
  loading?: boolean;
  hasError?: boolean;
  creating?: boolean;
  onPick: (project: Project) => void;
  onCreate: (name: string) => void;
}) {
  const [active, setActive] = useState<string>();
  if (loading)
    return (
      <div
        className="project-move-skeleton"
        role="status"
        aria-label={t("Loading")}
      >
        {["80%", "60%", "70%", "75%"].map((width) => (
          <Skeleton key={width} width={width} height={26} />
        ))}
      </div>
    );
  if (hasError)
    return <p className="project-move-empty">{t("Failed to load projects")}</p>;
  const targets = moveTargets(projects, searchQuery, currentProjectId);
  if (!targets.length && !query && !searchQuery)
    return (
      <p className="project-move-empty">
        {t(currentProjectId ? "No other projects" : "No projects yet")}
      </p>
    );
  return (
    <>
      {targets.map((project) => (
        <button
          key={project.id}
          type="button"
          role="option"
          aria-selected={active === project.id}
          onFocus={() => setActive(project.id)}
          disabled={creating}
          className="project-move-row"
          onClick={() => onPick(project)}
          aria-label={
            project.isPrivate === false
              ? formatText("{projectName}, Shared", {
                  projectName: project.name,
                })
              : project.name
          }
        >
          <AppIcon name="Projects" />
          <span>{project.name}</span>
          {project.isPrivate === false && (
            <small>
              <Users size={12} />
              {t("Shared")}
            </small>
          )}
        </button>
      ))}
      {query && (
        <button
          type="button"
          role="option"
          aria-selected={active === `create_${query}`}
          onFocus={() => setActive(`create_${query}`)}
          disabled={creating}
          className="project-move-row"
          aria-label={formatText("Create project {projectName}", {
            projectName: query,
          })}
          onClick={() => onCreate(query)}
        >
          <AppIcon name="Plus" />
          <span>
            {t("Create")}{" "}
            <small>
              <AppIcon name="Projects" />
              {query}
            </small>
          </span>
        </button>
      )}
    </>
  );
}

export function MoveToProjectModal({
  rows,
  projects,
  onClose,
  onPick,
  onCreate,
  onError,
}: {
  rows: readonly Conversation[];
  projects: readonly Project[];
  onClose: () => void;
  onPick: (project: Project) => void;
  onCreate: (name: string) => Promise<Project>;
  onError: (error: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const picked = useRef(false);
  const creatingNow = useRef(false);
  const live = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const currentProjectId = rows.length === 1 ? rows[0].projectId : undefined;
  const current = projects.find((project) => project.id === currentProjectId);
  const sessions = rows.every((row) => row.mode === "code");
  const pick = (project: Project) => {
    if (picked.current) return;
    picked.current = true;
    onPick(project);
  };
  return (
    <Modal
      className="project-move-modal"
      title={
        rows.length > 1
          ? formatText(
              sessions ? "Move {count} sessions" : "Move {count} chats",
              { count: rows.length },
            )
          : t("Move to project")
      }
      onClose={() => {
        live.current = false;
        onClose();
      }}
    >
      <p className="project-move-description">
        {current
          ? formatText(
              sessions
                ? "This session is in {projectName}. Select a different project to move it to."
                : "This chat is in {projectName}. Select a different project to move it to.",
            )
              .split("{projectName}")
              .map((part, index) => (
                <Fragment key={index}>
                  {index > 0 && (
                    <span className="project-move-current">{current.name}</span>
                  )}
                  {part}
                </Fragment>
              ))
          : t("Select a project.")}
      </p>
      <div
        className="project-move-picker"
        aria-label={t("Select a project")}
        onKeyDown={(event) => {
          if (
            !["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(
              event.key,
            )
          )
            return;
          const buttons = [
            ...(list.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? []),
          ];
          if (!buttons.length) return;
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (event.key === "Enter") {
            if (index < 0) {
              event.preventDefault();
              buttons[0].click();
            }
            return;
          }
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : index < 0
                  ? event.key === "ArrowUp"
                    ? buttons.length - 1
                    : 0
                  : (index +
                      (event.key === "ArrowUp" ? -1 : 1) +
                      buttons.length) %
                    buttons.length;
          buttons[next]?.focus();
        }}
      >
        <label className="project-move-search">
          <AppIcon name="Search" />
          <input
            autoFocus
            value={query}
            disabled={creating}
            placeholder={t("Search or create a project")}
            aria-label={t("Search or create a project")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          ref={list}
          role="listbox"
          aria-label={t("Projects")}
          className="project-move-list"
        >
          <ProjectMoveList
            projects={projects}
            query={query}
            searchQuery={search}
            currentProjectId={currentProjectId}
            creating={creating}
            onPick={pick}
            onCreate={(name) => {
              if (creatingNow.current || picked.current) return;
              creatingNow.current = true;
              setCreating(true);
              void onCreate(name)
                .then((project) => {
                  if (live.current) pick(project);
                })
                .catch((error) => {
                  if (live.current) onError(error);
                })
                .finally(() => {
                  creatingNow.current = false;
                  if (live.current) setCreating(false);
                });
            }}
          />
        </div>
        {creating && (
          <div className="project-move-creating" role="status">
            <CreatingProjectIcon />
            {t("Creating project…")}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ProjectMoveOverlay() {
  const app = useApp();
  const request = useProjectMoveRequest();
  const projects = useMemo(() => {
    const latest = new Map<string, number>();
    for (const row of app.snapshot.conversations) {
      if (row.projectId)
        latest.set(
          row.projectId,
          Math.max(latest.get(row.projectId) ?? 0, row.updatedAt),
        );
    }
    // An archived project takes no new chats.
    return app.snapshot.projects
      .filter((p) => !p.archivedAt)
      .sort(
        (left, right) =>
          (latest.get(right.id) ?? 0) - (latest.get(left.id) ?? 0),
      );
  }, [app.snapshot.projects, app.snapshot.conversations]);
  if (!request) return null;
  return (
    <MoveToProjectModal
      key={request.id}
      rows={request.rows}
      projects={projects}
      onClose={closeProjectMove}
      onError={app.report}
      onCreate={(name) => createMoveProject(app, name)}
      onPick={(project) => {
        closeProjectMove();
        void moveProjectChats(app, request.rows, project)
          .then((failed) => request.done?.(failed))
          .catch(app.report);
      }}
    />
  );
}

/** While the project is created: a folder with a line dropping into it. */
function CreatingProjectIcon() {
  return (
    <FolderInput
      size={32}
      strokeWidth={1.5}
      aria-hidden="true"
      className="project-move-animation"
    />
  );
}
