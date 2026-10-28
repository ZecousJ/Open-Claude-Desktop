import { createPortal } from "react-dom";
import {
  KnowledgePreviewDialog,
  KnowledgeGitHubDialog,
  KnowledgeMcpDialog,
  KnowledgeDriveDialog,
  KnowledgeEncodingDialog,
} from "./ProjectKnowledge";
import {
  KnowledgeDropOverlay,
  AddTextDialog,
  textSaveError,
} from "./KnowledgeDialogs";
import {
  KNOWLEDGE_EXPAND_MS,
  formatSize,
  capacityVariant,
} from "./KnowledgeList";
import { knowledgeFull, capacityReason } from "./knowledge-drop";
import { t, formatText } from "../../i18n";
import { Info } from "../../ui/glyphs";
import { Collapsible } from "../../ui/Collapsible";
import { Suspense } from "react";
import type { TextDraft } from "./KnowledgeDialogs";
import type { KnowledgeSnapshot } from "./KnowledgeList";
import type { ZoneDropState } from "../../composer/drop-zones";
import type {
  PendingKnowledgeFile,
  ProjectKnowledgePendingAPI,
} from "../../../shared/project-knowledge-pending";
import type {
  KnowledgeFile,
  ProjectKnowledge,
} from "../../../shared/collections-api";
import type { AppController } from "../../app/AppContext";
import type { DesktopAPI } from "../../../shared/types";
import { ProjectKnowledgeActions } from "./ProjectKnowledgeActions";
import { ProjectKnowledgeFileList } from "./ProjectKnowledgeFileList";
import { ProjectContextSelection } from "./ProjectContextSelection";
import { AddToContextMenu } from "./AddToContextMenu";

/** What projectKnowledgeView needs from ProjectKnowledge.tsx. */
export interface ProjectKnowledgeViewKit {
  acceptedExtensions: string[];
  addButton: React.RefObject<HTMLButtonElement | null>;
  app: AppController | undefined;
  bridge: DesktopAPI;
  busy: boolean;
  canEdit: boolean;
  cancelSelection: () => void;
  closePreview: () => void;
  contextDialog: boolean;
  draft: TextDraft;
  drive: boolean;
  driveServers: string[];
  dropState: ZoneDropState;
  encoding: PendingKnowledgeFile | undefined;
  encodingProtocol: boolean;
  github: boolean;
  knowledge: KnowledgeSnapshot | undefined;
  knowledgeRoot: React.RefObject<HTMLElement | null>;
  limit: number;
  mcpServer: string | undefined;
  mcpServers: string[];
  menu: boolean;
  onCloseContext: (() => void) | undefined;
  onError: (error: unknown) => void;
  onKnowledgeChange: ((knowledge: ProjectKnowledge) => void) | undefined;
  ownsMutation: () => boolean;
  ownsOperation: () => boolean;
  pending: KnowledgeFile[];
  pendingAPI: DesktopAPI & ProjectKnowledgePendingAPI;
  percent: number;
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
  previewOwned: () => boolean;
  projectId: string;
  query: string | null;
  removeSelected: () => void;
  repositories: string[];
  run: (action: () => Promise<ProjectKnowledge>) => Promise<void>;
  scope: string[];
  searchField: React.RefObject<HTMLInputElement | null>;
  searchFocusIntent: React.RefObject<number>;
  selectButton: React.RefObject<HTMLButtonElement | null>;
  selected: Set<string>;
  selecting: boolean;
  selectionAnchor: React.RefObject<string | null>;
  setDraft: React.Dispatch<React.SetStateAction<TextDraft>>;
  setDrive: React.Dispatch<React.SetStateAction<boolean>>;
  setEncoding: React.Dispatch<
    React.SetStateAction<PendingKnowledgeFile | undefined>
  >;
  setGithub: React.Dispatch<React.SetStateAction<boolean>>;
  setKnowledge: React.Dispatch<
    React.SetStateAction<KnowledgeSnapshot | undefined>
  >;
  setMcpServer: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setPending: React.Dispatch<React.SetStateAction<KnowledgeFile[]>>;
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
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSelecting: React.Dispatch<React.SetStateAction<boolean>>;
  setSyncing: React.Dispatch<React.SetStateAction<string | undefined>>;
  setWriting: React.Dispatch<React.SetStateAction<boolean>>;
  syncing: string | undefined;
  twoPane: boolean;
  upload: (files: File[]) => void;
  uploadInput: React.RefObject<HTMLInputElement | null>;
  used: number;
  writing: boolean;
  zoneElement: HTMLElement | null;
}

export function projectKnowledgeView(kit: ProjectKnowledgeViewKit) {
  const {
    acceptedExtensions,
    addButton,
    app,
    bridge,
    busy,
    canEdit,
    cancelSelection,
    closePreview,
    contextDialog,
    draft,
    drive,
    driveServers,
    dropState,
    encoding,
    encodingProtocol,
    github,
    knowledge,
    knowledgeRoot,
    limit,
    mcpServer,
    mcpServers,
    menu,
    onCloseContext,
    onError,
    onKnowledgeChange,
    ownsMutation,
    ownsOperation,
    pending,
    pendingAPI,
    percent,
    preview,
    previewAnchor,
    previewOpen,
    previewOwned,
    projectId,
    query,
    removeSelected,
    repositories,
    run,
    scope,
    searchField,
    searchFocusIntent,
    selectButton,
    selected,
    selecting,
    selectionAnchor,
    setDraft,
    setDrive,
    setEncoding,
    setGithub,
    setKnowledge,
    setMcpServer,
    setMenu,
    setPending,
    setPreview,
    setQuery,
    setSelected,
    setSelecting,
    setSyncing,
    setWriting,
    syncing,
    twoPane,
    upload,
    uploadInput,
    used,
    writing,
    zoneElement,
  } = kit;
  const knowledgeView = (
    <section
      ref={knowledgeRoot}
      className={`prj-knowledge${contextDialog ? " prj-knowledge-dialog" : ""}`}
      data-preview-open={previewOpen || undefined}
      onKeyDown={(event) => {
        if (contextDialog && event.key === "Tab") {
          const target = event.target as HTMLElement;
          const dialog = event.currentTarget.closest('[role="dialog"]');
          if (
            target.closest('[role="menu"]') ||
            target.closest('[role="dialog"]') !== dialog
          )
            return;
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
            ),
          ].filter(
            (item) =>
              !item.closest("[hidden], [inert]") &&
              item.getAttribute("tabindex") !== "-1",
          );
          const first = items[0],
            last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            event.stopPropagation();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            event.stopPropagation();
            first?.focus();
          }
        }
        if (selecting && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelSelection();
        }
      }}
    >
      {zoneElement &&
        createPortal(
          <KnowledgeDropOverlay
            state={dropState}
            message={knowledgeFull(knowledge) ? t(capacityReason) : undefined}
          />,
          zoneElement,
        )}
      <div
        className="prj-knowledge-list-pane"
        hidden={contextDialog && previewOpen && !twoPane}
      >
        <div className="prj-side-head">
          <h2>Context</h2>
          <ProjectKnowledgeActions
            addButton={addButton}
            busy={busy}
            canEdit={canEdit}
            cancelSelection={cancelSelection}
            contextDialog={contextDialog}
            knowledge={knowledge}
            menu={menu}
            onCloseContext={onCloseContext}
            previewOpen={previewOpen}
            query={query}
            scope={scope}
            selectButton={selectButton}
            selecting={selecting}
            setMenu={setMenu}
            setQuery={setQuery}
            setSelecting={setSelecting}
            twoPane={twoPane}
          />
        </div>
        <input
          ref={uploadInput}
          type="file"
          hidden
          multiple
          disabled={!canEdit}
          accept={acceptedExtensions
            .map((extension) => `.${extension}`)
            .join(",")}
          onChange={(event) => {
            upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {menu && canEdit && (
          <AddToContextMenu
            addButton={addButton}
            driveServers={driveServers}
            mcpServers={mcpServers}
            repositories={repositories}
            setDrive={setDrive}
            setGithub={setGithub}
            setMcpServer={setMcpServer}
            setMenu={setMenu}
            setWriting={setWriting}
            uploadInput={uploadInput}
          />
        )}
        <Collapsible
          open={query !== null}
          className="prj-knowledge-expand"
          exitMs={KNOWLEDGE_EXPAND_MS}
        >
          <input
            ref={searchField}
            className="prj-knowledge-search"
            aria-label="Search files"
            placeholder="Search files"
            value={query ?? ""}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setQuery(query ? "" : null);
            }}
          />
        </Collapsible>
        <Collapsible
          open={Boolean(knowledge && knowledge.files.length > 0)}
          className="prj-knowledge-expand prj-knowledge-capacity"
          exitMs={KNOWLEDGE_EXPAND_MS}
        >
          <div className="prj-capacity">
            <div
              className="prj-capacity-bar"
              role="progressbar"
              aria-label={t("Project file storage")}
              aria-valuetext={`${formatSize(used)} / ${formatSize(limit)}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={percent / 100}
            >
              <span
                className={`prj-capacity-fill ${capacityVariant(percent)}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="prj-capacity-copy">
              <small>
                {(knowledge?.files.length ?? 0) === 1
                  ? t("1 file")
                  : formatText("{count} files", {
                      count: knowledge?.files.length ?? 0,
                    })}
              </small>
              {contextDialog && (
                <span
                  className="prj-context-capacity-info"
                  title={`${formatSize(used)} / ${formatSize(limit)}`}
                >
                  <Info size={12} aria-hidden="true" />
                </span>
              )}
              <span aria-hidden="true">·</span>
              <small>
                {formatSize(used)} / {formatSize(limit)} {t("file storage")}
              </small>
            </div>
          </div>
        </Collapsible>
        {selecting && canEdit && (
          <ProjectContextSelection
            busy={busy}
            cancelSelection={cancelSelection}
            removeSelected={removeSelected}
            scope={scope}
            selected={selected}
            setSelected={setSelected}
          />
        )}
        <ProjectKnowledgeFileList
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
      </div>
      {preview && previewOwned() && (
        <Suspense fallback={<div role="status">{t("Loading file…")}</div>}>
          <KnowledgePreviewDialog
            key={`${preview.projectId}:${preview.file.name}`}
            projectId={projectId}
            file={preview.file}
            owns={previewOwned}
            pane={contextDialog}
            twoPane={twoPane}
            onClose={closePreview}
            onRemove={
              canEdit
                ? () => {
                    const name = preview.file.name;
                    closePreview();
                    void run(async () => {
                      try {
                        return await bridge.removeProjectKnowledge(
                          projectId,
                          name,
                        );
                      } catch {
                        throw new Error(
                          t("Couldn’t remove the selected items. Try again."),
                        );
                      }
                    });
                  }
                : undefined
            }
          />
        </Suspense>
      )}
      {github && canEdit && (
        <Suspense fallback={null}>
          <KnowledgeGitHubDialog
            projectId={projectId}
            repositories={repositories}
            onClose={() => setGithub(false)}
            onError={onError}
            onAdd={(repository, files, branch) => {
              setGithub(false);
              setPending(
                files.map((file) => ({
                  name: `${repository}/${file.name}`,
                  bytes: file.bytes,
                  addedAt: Date.now(),
                })),
              );
              void run(async () => {
                try {
                  return await bridge.addProjectKnowledgeRepositoryFiles(
                    projectId,
                    repository,
                    files,
                    branch,
                  );
                } finally {
                  if (ownsOperation()) setPending([]);
                }
              });
            }}
          />
        </Suspense>
      )}
      {mcpServer && canEdit && (
        <Suspense fallback={null}>
          <KnowledgeMcpDialog
            projectId={projectId}
            server={mcpServer}
            onClose={() => setMcpServer(undefined)}
            onAdd={(resource) => {
              const server = mcpServer;
              setMcpServer(undefined);
              setPending([
                {
                  name: resource.title || resource.name,
                  bytes: 0,
                  addedAt: Date.now(),
                },
              ]);
              void run(async () => {
                try {
                  return await bridge.addProjectKnowledgeMcpResource(
                    projectId,
                    server,
                    resource,
                  );
                } catch {
                  throw new Error(t("Failed to add MCP resource"));
                } finally {
                  if (ownsOperation()) setPending([]);
                }
              });
            }}
          />
        </Suspense>
      )}
      {drive && canEdit && (
        <Suspense fallback={null}>
          <KnowledgeDriveDialog
            projectId={projectId}
            servers={driveServers}
            onClose={() => setDrive(false)}
            onError={onError}
            onAdd={(server, files) => {
              setDrive(false);
              setPending(
                files.map((file) => ({
                  name: file.title,
                  bytes: 0,
                  addedAt: Date.now(),
                })),
              );
              void run(async () => {
                try {
                  return await bridge.addProjectKnowledgeDriveFiles(
                    projectId,
                    server,
                    files,
                  );
                } finally {
                  if (ownsOperation()) setPending([]);
                }
              });
            }}
          />
        </Suspense>
      )}
      {encoding && canEdit && encodingProtocol && (
        <Suspense fallback={<span role="status">{t("Loading file…")}</span>}>
          <KnowledgeEncodingDialog
            file={encoding}
            projectId={projectId}
            api={pendingAPI}
            owns={ownsMutation}
            onClose={() => setEncoding(undefined)}
            onDone={(result) => {
              if (ownsMutation()) {
                setKnowledge(result);
                onKnowledgeChange?.(result);
                setEncoding(undefined);
              }
            }}
          />
        </Suspense>
      )}
      {writing && canEdit && (
        <AddTextDialog
          draft={draft}
          onDraft={setDraft}
          onClose={() => setWriting(false)}
          onSave={(file) => {
            // The dialog closes at once, the + spins while the file is saved,
            // the fields empty once it is, and a failure is reported while the
            // text stays for the next Add text content.
            setWriting(false);
            setPending([
              {
                name: file.name,
                bytes: new TextEncoder().encode(file.text).length,
                addedAt: Date.now(),
              },
            ]);
            void run(async () => {
              try {
                const saved = await bridge.addProjectKnowledgeText(
                  projectId,
                  file,
                );
                setDraft({ name: "", text: "" });
                return saved;
              } catch (error) {
                throw textSaveError(error);
              } finally {
                if (ownsOperation()) setPending([]);
              }
            });
          }}
        />
      )}
    </section>
  );
  return knowledgeView;
}
