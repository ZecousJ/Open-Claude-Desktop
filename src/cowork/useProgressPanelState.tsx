import { useMemo, useState, useEffect } from "react";
import { takeProgressSteps, onProgressSteps } from "./progress-request";
import { Folder, Download } from "../ui/glyphs";
import type { Artifact } from "../ui/ArtifactTypes";
import { downloadArtifact } from "../artifacts/artifact-actions";
import { useProgressPanelActions } from "./useProgressPanelActions";
import type { Conversation } from "../../shared/types";
import type { ContextResource } from "./context-resources";
import type { AppController } from "../app/AppContext";
import type { ArtifactPresentation } from "../artifacts/artifact-presentation";
import type { ConversationServices } from "../conversation/ConversationServices";
import type { TaskFolderSnapshot } from "../../shared/folder-browser";

/** What useProgressPanelState needs from ProgressPanel.tsx. */
export interface UseProgressPanelStateKit {
  app: AppController | undefined;
  conversation: Conversation;
  downloading: boolean;
  embedded: boolean;
  folder: string | undefined;
  folderKey: string;
  folders: string[];
  fresh: ReadonlySet<string> | undefined;
  local: boolean;
  onArtifact: (artifact: Artifact) => void;
  outputs: Artifact[];
  presentation: ArtifactPresentation | undefined;
  services: ConversationServices;
  setBrowserFolder: React.Dispatch<React.SetStateAction<number | undefined>>;
  setDownloading: React.Dispatch<React.SetStateAction<boolean>>;
  setInstructionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedResource: React.Dispatch<
    React.SetStateAction<ContextResource | undefined>
  >;
  taskFolders: TaskFolderSnapshot | undefined;
  unavailable: Set<string>;
}

export function useProgressPanelState(kit: UseProgressPanelStateKit) {
  const {
    app,
    conversation,
    downloading,
    embedded,
    folder,
    folderKey,
    folders,
    fresh,
    local,
    onArtifact,
    outputs,
    presentation,
    services,
    setBrowserFolder,
    setDownloading,
    setInstructionsOpen,
    setSelectedResource,
    taskFolders,
    unavailable,
  } = kit;
  const initialOpen = useMemo<Record<string, boolean>>(() => {
    const remembered = presentation?.activitySectionsFor(conversation.id);
    return {
      [folderKey]: Boolean(fresh?.size),
      context: true,
      ...remembered,
      // "Updated tasks" explicitly requests Progress, even if it was closed.
      progress:
        takeProgressSteps(conversation.id) || Boolean(remembered?.progress),
    };
  }, [presentation, conversation.id]);
  const [sections, setSections] = useState(() => ({
    id: conversation.id,
    open: initialOpen,
  }));
  const open = sections.id === conversation.id ? sections.open : initialOpen;
  const setOpen = (
    update: (current: Record<string, boolean>) => Record<string, boolean>,
  ) =>
    setSections((current) => ({
      id: conversation.id,
      open: update(current.id === conversation.id ? current.open : initialOpen),
    }));
  useEffect(() => {
    presentation?.rememberActivitySections(conversation.id, open);
  }, [presentation, conversation.id, open]);
  const toggle = (key: string) =>
    setOpen((current) => ({ ...current, [key]: !current[key] }));
  useEffect(
    () =>
      onProgressSteps(conversation.id, () =>
        setOpen((current) => ({ ...current, progress: true })),
      ),
    [conversation.id],
  );
  useEffect(() => {
    if (!presentation) return;
    presentation.progressVisible(conversation.id, true);
    return () => presentation.progressVisible(conversation.id, false);
  }, [presentation, conversation.id]);
  useEffect(() => {
    if (presentation?.expandOutputs(conversation))
      setOpen((current) => ({ ...current, [folderKey]: true }));
  });
  const reveal = (path: string) =>
    taskFolders &&
    local && (
      <button
        className="progress-section-action"
        // Each folder's button, alone or in a group, is "Go to folder".
        aria-label="Go to folder"
        title={path}
        onClick={() =>
          void window.desktop
            .revealCoworkFolder(conversation.id, path)
            .catch((e: unknown) => app?.report(e))
        }
      >
        <Folder size={16} strokeWidth={1.5} />
      </button>
    );
  const downloadAll = (artifacts: Artifact[]) => {
    const list = artifacts.filter(
      (artifact) => !artifact.contentOmitted && !unavailable.has(artifact.id),
    );
    return (
      list.length > 1 && (
        <button
          className="progress-download-all"
          type="button"
          disabled={downloading}
          aria-label={downloading ? "Downloading…" : "Download all"}
          data-busy={downloading || undefined}
          onClick={async () => {
            setDownloading(true);
            try {
              if (services.downloadArtifacts)
                await services.downloadArtifacts(list);
              else {
                const results = await Promise.allSettled(
                  list.map((artifact) =>
                    (services.downloadArtifact ?? downloadArtifact)(
                      artifact,
                      artifact.filename ?? artifact.name,
                    ),
                  ),
                );
                for (const result of results)
                  if (result.status === "rejected") app?.report(result.reason);
              }
            } catch (error) {
              app?.report(error);
            } finally {
              setDownloading(false);
            }
          }}
        >
          <Download size={16} />
        </button>
      )
    );
  };
  const {
    Root,
    outputList,
    emptyOutputs,
    folderActions,
    instructionsRow,
    byFolder,
    resourceList,
  } = useProgressPanelActions({
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
  });
  return {
    Root,
    open,
    toggle,
    downloadAll,
    outputList,
    emptyOutputs,
    folderActions,
    instructionsRow,
    setOpen,
    byFolder,
    resourceList,
  } as const;
}
