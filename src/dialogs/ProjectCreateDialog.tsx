import { useRef, useState, type ReactNode } from "react";
import {
  File as FileIcon,
  FolderPlus,
  Info,
  Folder,
  Plus,
  X,
} from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Project } from "../../shared/types";
import { Modal } from "../ui/Controls";
import { WithTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";
import { MemoryIcon } from "../ui/SettingsIcons";
import { formatText, t, useLocale } from "../i18n";
import { memoryText, useMemory } from "../memory/useMemory";
import { ProjectImportForm } from "./ProjectImportForm";
import { ProjectIconPicker } from "./ProjectSettingsDialog";
import "./project-create.css";

export interface ProjectCreation {
  location?: string;
  files: File[];
  projectIds?: string[];
  contextFiles?: File[];
  contextText?: string;
  operationId?: string;
}

/** Cowork onboarding. */
export function ProjectCreateDialog({
  project,
  onChange,
  onClose,
  onSave,
  onChooseFolder,
  onError,
  projects = [],
}: {
  project: Project;
  onChange: (project: Project) => void;
  onClose: () => void;
  onSave: (project: Project, creation: ProjectCreation) => Promise<void>;
  onChooseFolder: (title?: string) => Promise<string | null>;
  onError: (error: unknown) => void;
  projects?: Project[];
}) {
  useLocale();
  const [step, setStep] = useState<"chooser" | "new" | "folder" | "import">(
    "chooser",
  );
  const [location, setLocation] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [named, setNamed] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const memory = useMemory(onError);
  const memoryOn = !!(
    memory.status?.available &&
    memory.status.allowed.generate &&
    memory.status.prefs.generate
  );
  const memoryReason = !memory.status?.available
    ? memoryText.unsupported
    : memoryOn
      ? "Claudex will remember context across conversations in this project. Turn this off in settings."
      : "Turn on memory in settings to let Claudex remember context in this project.";
  const addFiles = (incoming: File[]) => {
    setFiles((current) => {
      const keys = new Set(
        current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      return [
        ...current,
        ...incoming.filter((file) => {
          const key = `${file.name}:${file.size}:${file.lastModified}`;
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        }),
      ];
    });
  };
  const chooseFolder = async () => {
    try {
      const folder = await onChooseFolder(
        t(
          step === "new"
            ? "Choose where to create the project folder"
            : "Choose a folder for the project",
        ),
      );
      if (!folder) return;
      if (step === "new") setLocation(folder);
      else
        onChange({
          ...project,
          cwd: folder,
          name: named
            ? project.name
            : folder.split(/[/\\]/).filter(Boolean).at(-1) || folder,
        });
    } catch (error) {
      onError(error);
    }
  };
  const title =
    step === "chooser"
      ? "Create a new project"
      : step === "new"
        ? "Start a new project"
        : step === "import"
          ? "Import a project"
          : "Use an existing folder";
  const folder = step === "new" ? location : project.cwd;
  const valid = !!project.name.trim() && !!folder;
  const back = () => {
    setStep("chooser");
    setFiles([]);
    setLocation("");
    setNamed(false);
    onChange({ ...project, name: "", instructions: "", cwd: undefined });
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      pending={busy}
      className="prj-create"
    >
      {step === "chooser" ? (
        <>
          <p className="prj-create-description">
            A dedicated place for ongoing work, where context builds over time.
            Files and instructions stay in a folder on your computer.
          </p>
          <div className="prj-create-options">
            <CreateOption
              icon={<Plus size={20} strokeWidth={2.5} />}
              title="Start from scratch"
              description="Set up a new folder with instructions and files."
              onClick={() => setStep("new")}
            />
            <CreateOption
              icon={<AppIcon name="Projects" />}
              title="Import a project"
              description="Bring a project you made in Chat over to Cowork."
              onClick={() => setStep("import")}
            />
            <CreateOption
              icon={<Folder size={20} />}
              title="Use an existing folder"
              description="Give Claudex a folder you already work from."
              onClick={() => setStep("folder")}
            />
          </div>
        </>
      ) : step === "import" ? (
        <ProjectImportForm
          project={project}
          projects={projects}
          onChange={onChange}
          onSave={onSave}
          onChooseFolder={onChooseFolder}
          onError={onError}
          onBack={back}
          memoryOn={memoryOn}
          memoryReason={memoryReason}
        />
      ) : (
        <>
          {step === "folder" && (
            <>
              <p className="prj-create-description">
                Choose a folder and Claudex will treat its files as project
                context. Add instructions to shape how Claudex approaches the
                work.
              </p>
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
            </>
          )}
          <form
            className="prj-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || busy) return;
              setBusy(true);
              void onSave(
                {
                  ...project,
                  name: project.name.trim(),
                  instructions: project.instructions.trim(),
                },
                { location: step === "new" ? location : undefined, files },
              )
                .catch(onError)
                .finally(() => setBusy(false));
            }}
          >
            {step === "folder" && (
              <div className="prj-create-field">
                {project.cwd && <span>{t("Local folder")}</span>}
                <button
                  type="button"
                  className="prj-create-location"
                  disabled={busy}
                  onClick={() => void chooseFolder()}
                >
                  <Folder size={20} />
                  <span>{project.cwd || t("Choose folder")}</span>
                  {project.cwd && t("Change")}
                </button>
              </div>
            )}
            {(step === "new" || project.cwd) && (
              <>
                <div className="prj-create-name prj-settings-dialog">
                  <div className="prj-settings">
                    <ProjectIconPicker project={project} onChange={onChange} />
                  </div>
                  <label className="prj-create-field">
                    Name
                    <input
                      type="text"
                      autoFocus
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
                </div>
                <label className="prj-create-field">
                  Instructions
                  <textarea
                    rows={3}
                    disabled={busy}
                    placeholder={t(
                      "Tell Claudex how to work in this project (optional)",
                    )}
                    value={project.instructions}
                    onChange={(event) =>
                      onChange({ ...project, instructions: event.target.value })
                    }
                  />
                </label>
                <div className="prj-create-field">
                  <span>Add files</span>
                  {files.map((file, index) => (
                    <div
                      className="prj-create-file"
                      key={`${file.name}:${index}`}
                    >
                      <FileIcon size={16} />
                      <span>{file.name}</span>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={formatText("Remove {fileName}", {
                          fileName: file.name,
                        })}
                        onClick={() =>
                          setFiles(
                            files.filter((_, position) => position !== index),
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <input
                    ref={picker}
                    hidden
                    type="file"
                    multiple
                    disabled={busy}
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className={`prj-create-drop ${dragging ? "dragging" : ""}`}
                    disabled={busy}
                    onClick={() => picker.current?.click()}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!busy) setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDragging(false);
                      if (!busy) addFiles(Array.from(event.dataTransfer.files));
                    }}
                  >
                    <Plus size={16} />
                    Drop files here or click to browse
                  </button>
                </div>
              </>
            )}
            {step === "new" && (
              <div className="prj-create-field">
                <div className="prj-create-location-label">
                  <span>Choose project location</span>
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
            )}
            <div className="prj-create-footer">
              {step === "new" ? (
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
              ) : (
                <span />
              )}
              <div>
                <button
                  type="button"
                  className="prj-create-back"
                  disabled={busy}
                  onClick={back}
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="prj-create-submit"
                  disabled={!valid || busy}
                >
                  {busy && <Spinner inheritColor size={16} className="spin" />}
                  {step === "new" ? "Create" : "Create project"}
                </button>
              </div>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

function CreateOption({
  icon,
  title,
  description,
  ...props
}: {
  icon: ReactNode;
  title: string;
  description: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} type="button" className="prj-create-option">
      <span className="prj-create-icon">{icon}</span>
      <span>
        <strong>{t(title)}</strong>
        <span>{t(description)}</span>
      </span>
      <AppIcon name="CaretRight16" />
    </button>
  );
}
