import { useRef, useState, type KeyboardEvent } from "react";
import { Archive, Trash2 } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Project, Provider } from "../../shared/types";
import { chatEffortLabels, chatEffortLevels } from "../../shared/chat-effort";
import { Modal } from "../ui/Controls";
import { SelectField } from "../settings/controls";
import { useDismiss } from "../ui/useDismiss";
import "../settings/settings.css";
import { t, useLocale } from "../i18n";
import { projectColors, projectIcons } from "./project-icons";
import "./project-settings.css";

export function ProjectIcon({ project }: { project: Project }) {
  const icon =
    projectIcons[project.icon as keyof typeof projectIcons] ??
    projectIcons.Projects;
  return (
    <span className="prj-settings-icon" data-color={project.color}>
      <icon.icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

function moveRadio(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key))
    return;
  event.preventDefault();
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]',
    ),
  );
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const rtl = document.documentElement.dir === "rtl";
  const forward =
    event.key === "ArrowDown" ||
    event.key === (rtl ? "ArrowLeft" : "ArrowRight");
  const next =
    buttons[(index + (forward ? 1 : -1) + buttons.length) % buttons.length];
  next?.click();
  next?.focus();
}

export function ProjectIconPicker({
  project,
  onChange,
}: {
  project: Project;
  onChange: (project: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss([root], open, () => setOpen(false));
  const [search, setSearch] = useState("");
  const icons = Object.entries(projectIcons).filter(([name, icon]) =>
    `${name} ${t(icon.label)}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="prj-settings-icon-control" ref={root}>
      <button
        type="button"
        aria-label={t("Customize project icon and color")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ProjectIcon project={project} />
      </button>
      {open && (
        <div
          className="prj-settings-icon-picker"
          data-color={project.color}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            autoFocus
            aria-label={t("Search icons")}
            placeholder={t("Search icons")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div
            className="prj-settings-icons"
            role="radiogroup"
            aria-label={t("Project icon")}
            onKeyDown={moveRadio}
          >
            {icons.map(([name, icon], index) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-label={t(icon.label)}
                title={t(icon.label)}
                aria-checked={(project.icon ?? "Projects") === name}
                tabIndex={
                  (project.icon ?? "Projects") === name ||
                  (!icons.some(
                    ([value]) => value === (project.icon ?? "Projects"),
                  ) &&
                    index === 0)
                    ? 0
                    : -1
                }
                onClick={() =>
                  onChange({
                    ...project,
                    icon: name === "Projects" ? undefined : name,
                  })
                }
              >
                <icon.icon size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            ))}
            {!icons.length && <p>{t("No icons match your search")}</p>}
          </div>
          <div
            className="prj-settings-colors"
            role="radiogroup"
            aria-label={t("Project color")}
            onKeyDown={moveRadio}
          >
            {[undefined, ...Object.keys(projectColors)].map((color) => (
              <button
                key={color ?? "none"}
                type="button"
                role="radio"
                aria-label={t(
                  color
                    ? projectColors[color as keyof typeof projectColors]
                    : "No color",
                )}
                aria-checked={project.color === color}
                tabIndex={project.color === color ? 0 : -1}
                onClick={() => onChange({ ...project, color })}
              >
                <span data-color={color} />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              onChange({ ...project, icon: undefined, color: undefined })
            }
          >
            {t("Reset icon and color")}
          </button>
        </div>
      )}
    </div>
  );
}

// General and Advanced.
export function ProjectSettingsDialog({
  project,
  providers,
  onChange,
  onClose,
  onSave,
  onArchive,
  onDelete,
  onError,
}: {
  project: Project;
  providers: Provider[];
  onChange: (project: Project) => void;
  onClose: () => void;
  onSave: (project: Project) => Promise<void>;
  onArchive: () => void;
  onDelete: () => void;
  onError: (error: unknown) => void;
}) {
  useLocale();
  const [section, setSection] = useState("General");
  const [busy, setBusy] = useState(false);
  const models = providers.flatMap((provider) =>
    [...new Set([provider.model, ...provider.models])]
      .filter(Boolean)
      .map((model) => ({ providerId: provider.id, model })),
  );
  const selectedModel = models.findIndex(
    (model) =>
      model.providerId === project.defaultProviderId &&
      model.model === project.defaultModel,
  );
  return (
    <Modal
      title={t("Project settings")}
      onClose={onClose}
      pending={busy}
      className="prj-settings-dialog"
    >
      <form
        className="prj-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !project.name.trim()) return;
          setBusy(true);
          void onSave({
            ...project,
            name: project.name.trim(),
            instructions: project.instructions.trim(),
          })
            .catch((error) =>
              onError(
                new Error(
                  t("Couldn’t save settings. Click Save again to retry."),
                  { cause: error },
                ),
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        <nav aria-label={t("Settings sections")}>
          <span className="prj-settings-nav-title">{t("Settings")}</span>
          {["General", "Advanced"].map((name) => (
            <button
              type="button"
              key={name}
              aria-current={section === name ? "page" : undefined}
              onClick={() => setSection(name)}
            >
              {t(name)}
            </button>
          ))}
        </nav>
        <div className="prj-settings-content">
          <h3>{t(section)}</h3>
          {section === "General" ? (
            <>
              <div className="prj-settings-name">
                <label htmlFor="project-settings-name">
                  {t("Name and icon")}
                </label>
                <div>
                  <ProjectIconPicker project={project} onChange={onChange} />
                  <input
                    id="project-settings-name"
                    aria-label={t("Name")}
                    required
                    maxLength={200}
                    value={project.name}
                    onChange={(event) =>
                      onChange({ ...project, name: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="prj-settings-row">
                <div>
                  {t("Model")}
                  {project.defaultModel && (
                    <button
                      className="prj-settings-reset"
                      type="button"
                      onClick={() =>
                        onChange({
                          ...project,
                          defaultModel: undefined,
                          defaultProviderId: undefined,
                        })
                      }
                    >
                      {t("Use default")}
                    </button>
                  )}
                </div>
                <SelectField
                  label={t("Model")}
                  width={224}
                  value={String(selectedModel)}
                  options={[
                    { value: "-1", label: t("Default") },
                    ...models.map((model, index) => ({
                      value: String(index),
                      label: model.model,
                    })),
                  ]}
                  onChange={(value) => {
                    const model = models[Number(value)];
                    onChange({
                      ...project,
                      defaultModel: model?.model,
                      defaultProviderId: model?.providerId,
                    });
                  }}
                />
              </div>
              <div className="prj-settings-row">
                <div>
                  {t("Effort")}
                  {project.defaultEffort && (
                    <button
                      className="prj-settings-reset"
                      type="button"
                      onClick={() =>
                        onChange({ ...project, defaultEffort: undefined })
                      }
                    >
                      {t("Use default")}
                    </button>
                  )}
                </div>
                <SelectField
                  label={t("Effort")}
                  width={224}
                  value={project.defaultEffort ?? ""}
                  options={[
                    { value: "", label: t("Default") },
                    ...chatEffortLevels.map((effort) => ({
                      value: effort,
                      label: t(chatEffortLabels[effort]),
                    })),
                  ]}
                  onChange={(value) =>
                    onChange({
                      ...project,
                      defaultEffort: chatEffortLevels.find(
                        (effort) => effort === value,
                      ),
                    })
                  }
                />
              </div>
              <label className="prj-settings-instructions">
                {t("Project instructions")}
                <textarea
                  rows={4}
                  maxLength={100000}
                  placeholder={t(
                    "Think step by step and show reasoning for complex problems. Use specific examples.",
                  )}
                  value={project.instructions}
                  onChange={(event) =>
                    onChange({ ...project, instructions: event.target.value })
                  }
                />
              </label>
            </>
          ) : (
            <>
              <div className="prj-settings-row">
                <span>
                  {t(
                    project.archivedAt
                      ? "Unarchive project"
                      : "Archive project",
                  )}
                </span>
                <button type="button" onClick={onArchive}>
                  <Archive size={16} />
                  {t(project.archivedAt ? "Unarchive" : "Archive")}
                </button>
              </div>
              <h4>{t("Danger zone")}</h4>
              <div className="prj-settings-row">
                <span>{t("Delete project")}</span>
                <button
                  type="button"
                  className="prj-settings-delete"
                  onClick={onDelete}
                >
                  <Trash2 size={16} />
                  {t("Delete")}
                </button>
              </div>
            </>
          )}
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="prj-save"
            disabled={busy || !project.name.trim()}
          >
            {busy && <Spinner inheritColor size={14} className="spin" />}
            {t("Save")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
