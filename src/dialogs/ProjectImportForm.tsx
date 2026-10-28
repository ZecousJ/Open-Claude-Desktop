import { useEffect, useId, useRef, useState } from "react";
import { FolderPlus, Info, X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import type { Project } from "../../shared/types";
import { importableChatProjects } from "../../shared/project-import";
import { api } from "../desktop-api";
import { formatText, t } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { MemoryIcon } from "../ui/SettingsIcons";
import { WithTooltip } from "../ui/Tooltip";
import type { ProjectCreation } from "./ProjectCreateDialog";

/** Multi-project import. */
export function ProjectImportForm({
  project,
  projects,
  onChange,
  onSave,
  onChooseFolder,
  onError,
  onBack,
  memoryOn,
  memoryReason,
}: {
  project: Project;
  projects: Project[];
  onChange: (project: Project) => void;
  onSave: (project: Project, creation: ProjectCreation) => Promise<void>;
  onChooseFolder: (title?: string) => Promise<string | null>;
  onError: (error: unknown) => void;
  onBack: () => void;
  memoryOn: boolean;
  memoryReason: string;
}) {
  const [selected, setSelected] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [named, setNamed] = useState(false);
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const available = importableChatProjects(projects).filter(
    (value) => !selected.some((item) => item.id === value.id),
  );
  const matches = available.filter((value) =>
    value.name.toLowerCase().includes(query.toLowerCase().trim()),
  );
  const highlighted = Math.min(active, Math.max(0, matches.length - 1));
  const select = (value: Project) => {
    setSelected([...selected, value]);
    setQuery("");
    setOpen(false);
    setActive(0);
    search.current?.blur();
    if (!selected.length) {
      if (!named) onChange({ ...project, name: value.name });
      requestAnimationFrame(() => {
        name.current?.focus();
        name.current?.select();
      });
    }
  };
  const chooseFolder = async () => {
    try {
      const folder = await onChooseFolder(
        t("Choose where to create the project folder"),
      );
      if (folder) setLocation(folder);
    } catch (error) {
      onError(error);
    }
  };
  return (
    <>
      <p className="prj-create-description">
        {t(
          "Bring a project you made in Chat over to Cowork. Changes in Cowork won’t affect your project in Chat.",
        )}
      </p>
      <form
        className="prj-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !selected.length || !project.name.trim() || !location)
            return;
          setBusy(true);
          setOpen(false);
          void onSave(
            { ...project, name: project.name.trim() },
            {
              location,
              files: [],
              projectIds: selected.map((value) => value.id),
            },
          )
            .catch(onError)
            .finally(() => setBusy(false));
        }}
      >
        <div className="prj-import-context">
          <div
            className="prj-create-field prj-import-picker"
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setOpen(false);
            }}
          >
            <label htmlFor={`${listId}-input`}>{t("Projects from Chat")}</label>
            {selected.map((value) => (
              <div className="prj-import-selected" key={value.id}>
                <AppIcon name="Projects" />
                <span>{value.name}</span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={formatText("Remove chat project {name}", {
                    name: value.name,
                  })}
                  onClick={() =>
                    setSelected(selected.filter((item) => item.id !== value.id))
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className="prj-import-search">
              <input
                id={`${listId}-input`}
                ref={search}
                type="text"
                role="combobox"
                autoComplete="off"
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={
                  open && matches.length
                    ? `${listId}-${highlighted}`
                    : undefined
                }
                placeholder={t("Search projects in Chat…")}
                value={query}
                disabled={busy}
                onFocus={() => setOpen(true)}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOpen(true);
                  setActive(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                  } else if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp"
                  ) {
                    event.preventDefault();
                    setOpen(true);
                    setActive(
                      Math.max(
                        0,
                        Math.min(
                          matches.length - 1,
                          highlighted + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                      ),
                    );
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (open && matches[highlighted])
                      select(matches[highlighted]);
                  }
                }}
              />
              {open && (
                <div
                  id={listId}
                  role="listbox"
                  aria-label={t("Projects from Chat")}
                  className="prj-import-results"
                >
                  {matches.length ? (
                    matches.map((value, index) => (
                      <button
                        id={`${listId}-${index}`}
                        key={value.id}
                        type="button"
                        role="option"
                        aria-selected={index === highlighted}
                        onPointerMove={() => setActive(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => select(value)}
                      >
                        <AppIcon name="Projects" />
                        <span>{value.name}</span>
                      </button>
                    ))
                  ) : (
                    <div role="status">
                      {t(
                        available.length
                          ? "No matching projects"
                          : "No Chat projects to import",
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {selected.map((value) => (
            <ImportPreview
              key={value.id}
              project={value}
              showName={selected.length > 1}
              onError={onError}
            />
          ))}
        </div>
        {selected.length > 0 && (
          <>
            <label className="prj-create-field">
              {t("Name")}
              <input
                ref={name}
                type="text"
                required
                disabled={busy}
                placeholder={t("Project name")}
                value={project.name}
                onChange={(event) => {
                  setNamed(true);
                  onChange({ ...project, name: event.target.value });
                }}
              />
            </label>
            <div className="prj-create-field">
              <div className="prj-create-location-label">
                <span>{t("Choose project location")}</span>
                <WithTooltip label="Choose where to save this project on your computer.">
                  {(props) => (
                    <button
                      {...props}
                      type="button"
                      aria-label={t("About project storage")}
                    >
                      <Info size={16} />
                    </button>
                  )}
                </WithTooltip>
              </div>
              <button
                type="button"
                className="prj-create-location"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                <FolderPlus size={20} />
                <span>
                  {location
                    ? `${location.replace(/[/\\]$/, "")}${project.name.trim() ? `/${project.name.trim()}` : ""}`
                    : t("Select a folder...")}
                </span>
              </button>
            </div>
          </>
        )}
        <div className="prj-create-footer">
          <WithTooltip label={memoryReason}>
            {(props) => (
              <span
                {...props}
                tabIndex={0}
                role="status"
                className={`prj-create-memory ${memoryOn ? "on" : ""}`}
              >
                <MemoryIcon size={16} />
                {t(memoryOn ? "Memory is on" : "Memory is off")}
              </span>
            )}
          </WithTooltip>
          <div>
            <button
              type="button"
              className="prj-create-back"
              disabled={busy}
              onClick={onBack}
            >
              {t("Back")}
            </button>
            <button
              type="submit"
              className="prj-create-submit"
              disabled={
                busy || !selected.length || !project.name.trim() || !location
              }
            >
              {busy && <Spinner inheritColor size={16} className="spin" />}
              {t("Create")}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

function ImportPreview({
  project,
  showName,
  onError,
}: {
  project: Project;
  showName: boolean;
  onError: (error: unknown) => void;
}) {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    let cancelled = false;
    void api
      .listProjectKnowledge(project.id)
      .then((knowledge) => {
        if (!cancelled) setCount(knowledge.files.length);
      })
      .catch((error) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, onError]);
  const instructions = project.instructions.trim();
  if (count === undefined)
    return (
      <SkeletonGroup label={t("Loading")}>
        <Skeleton height={72} />
      </SkeletonGroup>
    );
  if (!instructions && !count) return null;
  return (
    <div className="prj-import-preview">
      {showName && (
        <div className="prj-import-preview-name">{project.name}</div>
      )}
      {instructions && (
        <>
          <div className="prj-import-caption">{t("Instructions")}</div>
          <div className="prj-import-instructions">{instructions}</div>
        </>
      )}
      {count > 0 && (
        <div className="prj-import-caption">
          {count === 1
            ? t("1 document")
            : formatText("{count} documents", { count })}
        </div>
      )}
    </div>
  );
}
