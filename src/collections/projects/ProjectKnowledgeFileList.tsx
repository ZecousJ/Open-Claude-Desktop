import { t } from "../../i18n";
import { ProjectKnowledgeFiles } from "./ProjectKnowledgeFiles";
import { ContextSheets } from "./KnowledgeDialogs";
import type { AppController } from "../../app/AppContext";
import type { DesktopAPI } from "../../../shared/types";
import type { KnowledgeSnapshot } from "./KnowledgeList";
import type {
  KnowledgeFile,
  ProjectKnowledge,
} from "../../../shared/collections-api";
import type {
  ProjectKnowledgePendingAPI,
  PendingKnowledgeFile,
} from "../../../shared/project-knowledge-pending";

/** What ProjectKnowledgeFileList needs from ProjectKnowledgeView.tsx. */
export interface PrjKnowledgeFileListProps {
  app: AppController | undefined;
  bridge: DesktopAPI;
  busy: boolean;
  canEdit: boolean;
  contextDialog: boolean;
  encodingProtocol: boolean;
  knowledge: KnowledgeSnapshot | undefined;
  ownsMutation: () => boolean;
  ownsOperation: () => boolean;
  pending: KnowledgeFile[];
  pendingAPI: DesktopAPI & ProjectKnowledgePendingAPI;
  preview:
    | {
        file: KnowledgeFile;
        account?: string | undefined;
        controller?: object | undefined;
        bridge: DesktopAPI;
        projectId: string;
      }
    | undefined;
  previewAnchor: React.RefObject<HTMLButtonElement | null>;
  previewOpen: boolean;
  projectId: string;
  query: string | null;
  run: (action: () => Promise<ProjectKnowledge>) => Promise<void>;
  scope: string[];
  searchFocusIntent: React.RefObject<number>;
  selected: Set<string>;
  selecting: boolean;
  selectionAnchor: React.RefObject<string | null>;
  setEncoding: React.Dispatch<
    React.SetStateAction<PendingKnowledgeFile | undefined>
  >;
  setPreview: React.Dispatch<
    React.SetStateAction<
      | {
          file: KnowledgeFile;
          account?: string | undefined;
          controller?: object | undefined;
          bridge: DesktopAPI;
          projectId: string;
        }
      | undefined
    >
  >;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSyncing: React.Dispatch<React.SetStateAction<string | undefined>>;
  syncing: string | undefined;
}

export function ProjectKnowledgeFileList({
  app,
  bridge,
  busy,
  canEdit,
  contextDialog,
  encodingProtocol,
  knowledge,
  ownsMutation,
  ownsOperation,
  pending,
  pendingAPI,
  preview,
  previewAnchor,
  previewOpen,
  projectId,
  query,
  run,
  scope,
  searchFocusIntent,
  selected,
  selecting,
  selectionAnchor,
  setEncoding,
  setPreview,
  setSelected,
  setSyncing,
  syncing,
}: PrjKnowledgeFileListProps) {
  return (
    <div className="prj-knowledge-file-list">
      {contextDialog && Boolean(knowledge?.files.length) && (
        <div className="prj-context-column-name">{t("Name")}</div>
      )}
      {knowledge === undefined ? null : knowledge.files.length ||
        pending.length ||
        knowledge.pending?.length ||
        query?.trim() ? (
        <ProjectKnowledgeFiles
          app={app}
          bridge={bridge}
          busy={busy}
          canEdit={canEdit}
          contextDialog={contextDialog}
          encodingProtocol={encodingProtocol}
          knowledge={knowledge}
          ownsMutation={ownsMutation}
          ownsOperation={ownsOperation}
          pending={pending}
          pendingAPI={pendingAPI}
          preview={preview}
          previewAnchor={previewAnchor}
          previewOpen={previewOpen}
          projectId={projectId}
          query={query}
          run={run}
          scope={scope}
          searchFocusIntent={searchFocusIntent}
          selected={selected}
          selecting={selecting}
          selectionAnchor={selectionAnchor}
          setEncoding={setEncoding}
          setPreview={setPreview}
          setSelected={setSelected}
          setSyncing={setSyncing}
          syncing={syncing}
        />
      ) : (
        <div className="prj-context-empty">
          <ContextSheets />
          <p>
            Add PDFs, documents, or other text to reference in this project.
          </p>
        </div>
      )}
    </div>
  );
}
