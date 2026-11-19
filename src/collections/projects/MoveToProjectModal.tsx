import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Users } from "../../ui/glyphs";
import type { Conversation, Project } from "../../../shared/types";
import { Modal } from "../../ui/Controls";
import { Skeleton } from "../../ui/Skeleton";
import { Anthropicon } from "../../ui/anthropicons";
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

/** Search, create and list states (live claude.ai bundle, 2026-10-14, c9d22852b-BCr1HnjD). */
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
          <Anthropicon name="Projects" />
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
          <Anthropicon name="Plus" />
          <span>
            {t("Create")}{" "}
            <small>
              <Anthropicon name="Projects" />
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
          <Anthropicon name="Search" />
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

/** Creating animation (live claude.ai bundle, 2026-10-14, c9d22852b-BCr1HnjD, Qr). */
function CreatingProjectIcon() {
  return (
    <svg
      width={32}
      height={32}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className="project-move-animation"
    >
      <path d="M15.8198 7C16.6885 7.00025 17.3624 7.73158 17.3178 8.57617L17.2993 8.74707L16.1332 15.7471C16.0126 16.4699 15.3865 16.9996 14.6538 17H5.34711C4.6142 16.9998 3.98833 16.47 3.86762 15.7471L2.7016 8.74707C2.54922 7.83277 3.25418 7 4.18109 7H15.8198ZM4.18109 8C3.87216 8 3.63722 8.27731 3.68793 8.58203L4.85394 15.582C4.89413 15.8229 5.10291 15.9998 5.34711 16H14.6538C14.8978 15.9996 15.1068 15.8228 15.1469 15.582L16.3129 8.58203L16.3188 8.46973C16.3036 8.21259 16.0899 8.00023 15.8198 8H4.18109Z" />
      {[
        {
          path: "M16.0004 5.5C16.0004 5.224 15.7764 5.00024 15.5004 5H4.50043C4.22428 5 4.00043 5.22386 4.00043 5.5C4.00043 5.77614 4.22428 6 4.50043 6H15.5004C15.7764 5.99976 16.0004 5.776 16.0004 5.5Z",
          translate: "0,-5; 0,-1; 0,1.5; 0,1.5",
          rotate: "6 10 5.5; 0 10 5.5; 0 10 5.5; 0 10 5.5",
          begin: "0s",
        },
        {
          path: "M14.5004 3.5C14.5004 3.224 14.2764 3.00024 14.0004 3H6.00043C5.72428 3 5.50043 3.22386 5.50043 3.5C5.50043 3.77614 5.72428 4 6.00043 4H14.0004C14.2764 3.99976 14.5004 3.776 14.5004 3.5Z",
          translate: "2,-5; 0,-1; 0,3.5; 0,3.5",
          rotate: "10 10 3.5; 0 10 3.5; 0 10 3.5; 0 10 3.5",
          begin: "0.5s",
        },
      ].map((line) => (
        <g key={line.begin} transform="translate(10, 10)">
          <path d={line.path} transform="translate(-10, -10)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values={line.translate}
              dur="2s"
              begin={line.begin}
              repeatCount="indefinite"
              additive="sum"
            />
            <animateTransform
              attributeName="transform"
              type="rotate"
              values={line.rotate}
              dur="2s"
              begin={line.begin}
              repeatCount="indefinite"
              additive="sum"
            />
            <animate
              attributeName="opacity"
              values="0;0.7;0"
              dur="2s"
              begin={line.begin}
              repeatCount="indefinite"
            />
          </path>
        </g>
      ))}
    </svg>
  );
}
