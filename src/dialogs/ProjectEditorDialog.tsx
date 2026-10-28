import { useEffect, useId, useRef, useState } from "react";
import { removeProjectFolder } from "../../shared/project-folders";
import { FolderOpen, FolderPlus, Plus, X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Project, Provider } from "../../shared/types";
import {
  ProjectIconPicker,
  ProjectSettingsDialog,
} from "./ProjectSettingsDialog";
import { projectTemplates } from "./project-templates";
import { formatText, t } from "../i18n";
import { useProjectCreationCapabilities } from "../collections/projects/project-detail-read";
import { Modal } from "../ui/Controls";
import { AppIcon } from "../ui/app-icon";
import { useHostCapability } from "../host/HostContext";
import "../collections/projects/projects.css";
import "./project-classic-context.css";
import {
  ProjectCreateDialog,
  type ProjectCreation,
} from "./ProjectCreateDialog";

/**
 * Chat's Create a project. Existing projects open Project settings. The folder
 * field needs folders on this computer (`localFolders`): the web app's projects
 * keep their instructions and knowledge only. Desktop creation uses Cowork
 * onboarding.
 */
export function ProjectEditorDialog({
  project,
  isExisting,
  onChange,
  onClose,
  onSave,
  onChooseFolder,
  onError,
  coworkCreation = true,
  projects = [],
  providers = [],
  onArchive,
  onDelete,
}: {
  project: Project;
  isExisting: boolean;
  onChange: (project: Project) => void;
  onClose: () => void;
  onSave: (project: Project, creation?: ProjectCreation) => Promise<void>;
  onChooseFolder: (title?: string) => Promise<string | null>;
  onError: (error: unknown) => void;
  coworkCreation?: boolean;
  projects?: Project[];
  providers?: Provider[];
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const localFolders = useHostCapability("localFolders");
  const access = useProjectCreationCapabilities(!isExisting);
  const folders = localFolders && access.capabilities?.localFolders === true;
  // shared-8 ql offers the folder row only when the context section is off.
  const classicFolders = folders && !access.capabilities?.contextFiles;
  const [contextFiles, setContextFiles] = useState<File[]>([]);
  const [saveError, setSaveError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const operation = useRef<{ fingerprint: string; id: string } | undefined>(
    undefined,
  );
  const saving = useRef(false);
  useEffect(() => {
    setBusy(false);
    saving.current = false;
    operation.current = undefined;
    setContextFiles([]);
    setSaveError("");
  }, [access.key]);
  const change = (next: Project) => {
    if (!access.capture().current() || saving.current) return;
    operation.current = undefined;
    setSaveError("");
    onChange(next);
  };
  const close = () => {
    if (!busy && !saving.current && access.capture().current()) onClose();
  };

  const pickFolder = async (title?: string) => {
    const owner = access.capture();
    if (!owner.current() || saving.current) return null;
    try {
      const folder = await onChooseFolder(title);
      return owner.current() && !saving.current ? folder : null;
    } catch (error) {
      if (owner.current()) onError(error);
      return null;
    }
  };
  const chooseFolder = async () => {
    const folder = await pickFolder();
    if (folder) change({ ...project, cwd: folder });
  };
  const name = useRef<HTMLInputElement>(null);
  const [template] = useState(() =>
    projectTemplates.find(
      (value) => t(value.description) === project.description,
    ),
  );
  // The capture has Create project enabled on the blank form: the original
  // checks on click. An empty name puts the cursor back in the name field and
  // "Project name is required" shows under it.
  const [missing, setMissing] = useState(false);
  const nameError = useId();
  // The dialog focuses its first control (the close button) after this
  // effect runs; the name field is what the capture shows focused.
  useEffect(() => {
    const frame = requestAnimationFrame(() => name.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [access.status]);
  if (isExisting)
    return (
      <ProjectSettingsDialog
        project={project}
        providers={providers}
        onChange={onChange}
        onClose={onClose}
        onSave={onSave}
        onArchive={onArchive}
        onDelete={onDelete}
        onError={onError}
      />
    );
  if (access.status !== "ready")
    return (
      <Modal title="Create a project" onClose={close}>
        {access.status === "pending" ? (
          <p role="status">
            <Spinner inheritColor size={16} />
            {t("Loading project options…")}
          </p>
        ) : (
          <div role="alert">
            <p>{t("Couldn’t load project options. Try again.")}</p>
            <button type="button" onClick={access.retry}>
              {t("Try again")}
            </button>
          </div>
        )}
      </Modal>
    );
  if (
    !isExisting &&
    folders &&
    coworkCreation &&
    access.capabilities?.routing === "legacy-local"
  )
    return (
      <ProjectCreateDialog
        projects={projects}
        project={project}
        onChange={onChange}
        onClose={onClose}
        onSave={onSave}
        onChooseFolder={onChooseFolder}
        onError={onError}
      />
    );
  return (
    <Modal
      title={template?.heading ?? "Create a project"}
      onClose={close}
      disablePointerDismissal={busy}
    >
      <form
        className={`prj-editor create${access.capabilities?.routing === "classic" ? " classic" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (!project.name.trim()) {
            setMissing(true);
            name.current?.focus();
            return;
          }
          const owner = access.capture();
          if (!owner.current() || saving.current) return;
          const files = access.capabilities?.contextFiles ? contextFiles : [];
          const fingerprint = JSON.stringify({
            project,
            files: files.map((file) => [
              file.name,
              file.size,
              file.lastModified,
            ]),
          });
          if (operation.current?.fingerprint !== fingerprint)
            operation.current = { fingerprint, id: crypto.randomUUID() };
          const creation = files.length
            ? {
                files: [],
                contextFiles: [...files],
                operationId: operation.current.id,
              }
            : undefined;
          saving.current = true;
          setBusy(true);
          setSaveError("");
          void onSave(project, creation)
            .catch((error) => {
              if (!owner.current()) return;
              setSaveError(
                error instanceof Error ? error.message : String(error),
              );
              onError(error);
            })
            .finally(() => {
              if (owner.current()) {
                saving.current = false;
                setBusy(false);
              }
            });
        }}
      >
        <div
          className={`prj-create-name${access.capabilities?.routing === "classic" ? "" : " prj-settings-dialog"}`}
        >
          {access.capabilities?.routing !== "classic" && (
            <div className="prj-settings">
              <ProjectIconPicker project={project} onChange={change} />
            </div>
          )}
          <label>
            {t(template?.question ?? "What are you working on?")}
            <input
              ref={name}
              aria-required="true"
              aria-invalid={missing && !project.name.trim() ? true : undefined}
              aria-describedby={
                missing && !project.name.trim() ? nameError : undefined
              }
              disabled={busy}
              maxLength={100}
              placeholder="Name your project"
              value={project.name}
              onChange={(event) =>
                change({ ...project, name: event.target.value })
              }
            />
            {missing && !project.name.trim() && (
              <span className="prj-field-error" id={nameError} role="alert">
                <AppIcon name="WarningCircle" size={16} />
                <span>{t("Project name is required")}</span>
              </span>
            )}
          </label>
        </div>
        <label>
          What are you trying to achieve?
          <textarea
            rows={3}
            disabled={busy}
            maxLength={2000}
            placeholder="Describe your project, goals, subject, etc..."
            value={project.description}
            onChange={(event) =>
              change({ ...project, description: event.target.value })
            }
          />
        </label>
        {!classicFolders ? null : !project.cwd ? (
          <button
            type="button"
            className="prj-use-folder"
            onClick={() => void chooseFolder()}
          >
            <FolderPlus size={17} strokeWidth={1.4} />
            Use a folder
          </button>
        ) : (
          <div className="prj-editor-folder">
            <span>Working folder</span>
            <div>
              <button
                type="button"
                className="prj-folder"
                title={project.cwd}
                onClick={() => void chooseFolder()}
              >
                <FolderOpen size={15} strokeWidth={1.5} />
                <span>{project.cwd || "Choose a local folder"}</span>
              </button>
              {project.cwd && (
                <button
                  type="button"
                  className="prj-folder-clear"
                  aria-label="Use the default workspace"
                  title="Use the default workspace"
                  // The project's next folder, if any, becomes the working one.
                  onClick={() =>
                    change(removeProjectFolder(project, project.cwd!))
                  }
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
        {access.capabilities?.contextFiles && (
          <section
            className="prj-create-field prj-create-context"
            role="group"
            aria-labelledby="create-project-context-label"
          >
            <span id="create-project-context-label">
              {t("Context")} <small>{t("optional")}</small>
            </span>
            {access.capabilities.contextFiles && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  aria-label={t("Upload files")}
                  data-testid="create-project-context-files"
                  disabled={busy}
                  onChange={(event) => {
                    if (!access.capture().current() || saving.current) return;
                    const incoming = Array.from(event.target.files ?? []);
                    setSaveError("");
                    operation.current = undefined;
                    setContextFiles((current) => {
                      const key = (file: File) =>
                        `${file.name}:${file.size}:${file.lastModified}`;
                      const seen = new Set(current.map(key));
                      return [
                        ...current,
                        ...incoming.filter((file) => {
                          const identity = key(file);
                          if (seen.has(identity)) return false;
                          seen.add(identity);
                          return true;
                        }),
                      ];
                    });
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="prj-context-add"
                  disabled={busy}
                  onClick={() => {
                    if (access.capture().current() && !saving.current)
                      picker.current?.click();
                  }}
                >
                  <Plus size={14} />
                  {t("Add context")}
                </button>
                {contextFiles.map((file, index) => (
                  <button
                    key={`${file.name}:${index}`}
                    type="button"
                    disabled={busy}
                    aria-label={formatText("Remove {fileName}", {
                      fileName: file.name,
                    })}
                    onClick={() => {
                      if (!access.capture().current() || saving.current) return;
                      setSaveError("");
                      operation.current = undefined;
                      setContextFiles((files) =>
                        files.filter((_, position) => index !== position),
                      );
                    }}
                  >
                    <span data-no-translate>{file.name}</span>
                    <X size={14} />
                  </button>
                ))}
              </>
            )}
          </section>
        )}
        {saveError && <p role="alert">{t(saveError)}</p>}
        {busy && <p role="status">{t("Creating project…")}</p>}
        <div className="prj-editor-actions">
          <button
            type="button"
            className="prj-cancel"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="prj-save" disabled={busy}>
            {busy && <Spinner inheritColor size={14} className="spin" />}
            Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}
