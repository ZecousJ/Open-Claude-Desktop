import { KnowledgeList } from "./KnowledgeList";
import { knowledgeDocumentExtensions } from "../../../shared/project-knowledge-encoding";
import { selectKnowledge } from "./knowledge-tree";
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

/** What ProjectKnowledgeFiles needs from ProjectKnowledgeView.tsx. */
export interface ProjectKnowledgePart2Props {
  app: AppController | undefined;
  bridge: DesktopAPI;
  busy: boolean;
  canEdit: boolean;
  contextDialog: boolean;
  encodingProtocol: boolean;
  knowledge: KnowledgeSnapshot;
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

export function ProjectKnowledgeFiles({
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
}: ProjectKnowledgePart2Props) {
  return (
    <KnowledgeList
      files={knowledge.files}
      pending={pending}
      query={query ?? ""}
      selected={canEdit && selecting ? selected : undefined}
      readOnly={!canEdit}
      waiting={knowledge.pending}
      onReadPending={(file) => {
        if (!ownsMutation() || !encodingProtocol) return;
        if (
          (knowledgeDocumentExtensions as readonly string[]).includes(
            file.name.split(".").pop()?.toLowerCase() ?? "",
          )
        )
          void run(() =>
            pendingAPI.confirmProjectKnowledgeEncoding(
              projectId,
              file.id,
              "extract",
            ),
          );
        else setEncoding(file);
      }}
      onRemovePending={(file) =>
        void run(() =>
          pendingAPI.removeProjectKnowledgePending(projectId, file.id),
        )
      }
      busy={busy}
      syncing={syncing}
      compact={contextDialog}
      viewing={previewOpen ? preview?.file.name : undefined}
      onOpen={(file, anchor) => {
        // A deliberately opened file retires deferred search focus;
        // otherwise its third frame can steal focus after Back.
        searchFocusIntent.current++;
        previewAnchor.current = anchor ?? null;
        setPreview({
          file,
          account: app?.accountId,
          controller: app?.controllerScope,
          bridge,
          projectId,
        });
      }}
      onSync={(name) => {
        setSyncing(name);
        void run(async () => {
          try {
            return await bridge.syncProjectKnowledge(projectId, name);
          } finally {
            if (ownsOperation()) setSyncing(undefined);
          }
        });
      }}
      onPick={(name, range, visible) => {
        setSelected(
          selectKnowledge(
            selected,
            name,
            visible ?? scope,
            selectionAnchor.current,
            range,
          ),
        );
        selectionAnchor.current = name;
      }}
      onRemove={(name) =>
        void run(() => bridge.removeProjectKnowledge(projectId, name))
      }
    />
  );
}
