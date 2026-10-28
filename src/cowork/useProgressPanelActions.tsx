import type { Artifact } from "../ui/ArtifactTypes";
import {
  List,
  File,
  Folder,
  Globe,
  Plug,
  Brain,
  Terminal,
  ScrollText,
} from "../ui/glyphs";
import { outputLabel, folderOf } from "./ProgressPanel";
import { t, formatText } from "../i18n";
import { relativePath } from "../ui/relative-path";
import type { ContextResource } from "./context-resources";
import type { Conversation } from "../../shared/types";
import type { AppController } from "../app/AppContext";

/** What useProgressPanelActions needs from ProgressPanel.tsx. */
export interface UseProgressPanelActionsKit {
  app: AppController | undefined;
  conversation: Conversation;
  downloadAll: (artifacts: Artifact[]) => false | React.JSX.Element;
  embedded: boolean;
  folder: string | undefined;
  folders: string[];
  fresh: ReadonlySet<string> | undefined;
  local: boolean;
  onArtifact: (artifact: Artifact) => void;
  outputs: Artifact[];
  reveal: (path: string) => false | React.JSX.Element | undefined;
  setBrowserFolder: React.Dispatch<React.SetStateAction<number | undefined>>;
  setInstructionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedResource: React.Dispatch<
    React.SetStateAction<ContextResource | undefined>
  >;
  unavailable: Set<string>;
}

export function useProgressPanelActions(kit: UseProgressPanelActionsKit) {
  const {
    app,
    conversation,
    downloadAll,
    embedded,
    folder,
    folders,
    fresh,
    local,
    onArtifact,
    outputs,
    reveal,
    setBrowserFolder,
    setInstructionsOpen,
    setSelectedResource,
    unavailable,
  } = kit;
  const folderActions = (index: number, artifacts: Artifact[]) =>
    artifacts.length > 1 ? (
      downloadAll(artifacts)
    ) : (
      <div className="progress-folder-actions">
        {conversation.environment?.kind !== "ssh" && (
          <button
            className="progress-section-action"
            aria-label="Browse files"
            onClick={() => setBrowserFolder(index)}
          >
            <List size={16} strokeWidth={1.5} />
          </button>
        )}
        {reveal(folders[index])}
      </div>
    );
  const outputList = (list: Artifact[]) => (
    <ul className="progress-list">
      {list.map((artifact) => {
        const isNew =
          artifact.sourcePath !== undefined && fresh?.has(artifact.sourcePath);
        const label = outputLabel(artifact.filename ?? artifact.name);
        return (
          <li key={artifact.id} className="progress-resource-row">
            <button
              title={
                unavailable.has(artifact.id)
                  ? t("Not available to preview yet")
                  : relativePath(artifact.sourcePath, folder)
              }
              aria-disabled={unavailable.has(artifact.id) || undefined}
              data-new={isNew || undefined}
              onClick={() =>
                !unavailable.has(artifact.id) &&
                onArtifact({ ...artifact, conversationId: conversation.id })
              }
            >
              <i className="progress-file-tile" aria-hidden="true">
                <File size={14} strokeWidth={1.5} />
              </i>
              <span data-no-translate>{label.name}</span>
              <span className="progress-file-kind" data-no-translate>
                {label.kind || t("File")}
              </span>
              {isNew && (
                <i className="progress-new" role="img" aria-label="New" />
              )}
            </button>
            {local && artifact.sourcePath && (
              <button
                className="progress-reveal-file"
                aria-label="Show in Folder"
                title={t("Show in Folder")}
                onClick={() => {
                  void window.desktop
                    .revealCoworkResource(conversation.id, artifact.sourcePath!)
                    .catch((error) => app?.report(error));
                }}
              >
                <Folder size={14} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
  const emptyOutputs = (
    <p className="progress-muted">
      View and open files created during this task.
    </p>
  );
  // Which folder each output belongs to; the files outside all of them go
  // with the first.
  const byFolder = folders.map((_, at) =>
    outputs.filter((artifact) => folderOf(folders, artifact.sourcePath) === at),
  );
  const instructionsRow = folders.length > 0 &&
    conversation.environment?.kind !== "ssh" && (
      <button
        type="button"
        className="progress-instructions"
        onClick={() => setInstructionsOpen(true)}
      >
        <i>
          <File size={16} aria-hidden="true" />
        </i>
        <span>
          {t("Instructions")}
          <small data-no-translate> · CLAUDE.md</small>
        </span>
      </button>
    );
  const resourceList = (list: ContextResource[]) => (
    <ul className="progress-list">
      {list.map((resource) => {
        const Glyph =
          resource.kind === "search" || resource.kind === "browser"
            ? Globe
            : resource.kind === "connector"
              ? Plug
              : resource.kind === "memory"
                ? Brain
                : resource.kind === "command"
                  ? Terminal
                  : resource.kind === "skill"
                    ? ScrollText
                    : resource.paths
                      ? Folder
                      : File;
        const count = (one: string, many: string) =>
          resource.count === 1
            ? t(one)
            : formatText(many, { count: resource.count });
        const detail =
          resource.kind === "search"
            ? count("1 search", "{count} searches")
            : resource.kind === "connector"
              ? count("1 tool call", "{count} tool calls")
              : resource.kind === "command"
                ? count("1 command", "{count} commands")
                : resource.kind === "skill"
                  ? count("1 skill", "{count} skills")
                  : resource.kind === "memory"
                    ? resource.updated
                      ? formatText("Updated {count} memories", {
                          count: resource.count,
                        })
                      : count("Read 1 memory", "Read {count} memories")
                    : resource.kind === "browser"
                      ? resource.id === "browser:tabs"
                        ? count("1 tab", "{count} tabs")
                        : resource.id === "browser:sites"
                          ? count("1 site", "{count} sites")
                          : count("1 page read", "{count} pages read")
                      : resource.paths
                        ? count("1 file read", "{count} files read")
                        : resource.kind === "instructions"
                          ? ""
                          : outputLabel(resource.name).kind;
        const device = local ? t("On this device") : t("On another device");
        return (
          <li key={resource.id}>
            <button
              title={resource.paths ? `${detail} · ${device}` : detail}
              onClick={() => setSelectedResource(resource)}
            >
              <i className="progress-file-tile">
                <Glyph size={14} strokeWidth={1.5} />
              </i>
              <span>
                {[
                  "search",
                  "memory",
                  "browser",
                  "command",
                  "instructions",
                ].includes(resource.kind) ? (
                  t(resource.name)
                ) : (
                  <span data-no-translate>{resource.name}</span>
                )}
              </span>
              <span className="progress-file-kind">
                {resource.kind === "connector"
                  ? t("Connector")
                  : resource.kind === "command"
                    ? t("Command")
                    : resource.kind === "skill"
                      ? t("Skill")
                      : resource.kind === "memory"
                        ? t(resource.updated ? "updated" : "read")
                        : detail}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
  const Root = embedded ? "div" : "aside";
  return {
    Root,
    outputList,
    emptyOutputs,
    folderActions,
    instructionsRow,
    byFolder,
    resourceList,
  } as const;
}
