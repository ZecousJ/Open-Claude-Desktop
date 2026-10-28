import { Suspense } from "react";
import {
  EnvironmentStartCard,
  DirtyTreeDialog,
  LocalEnvironmentDialog,
  CloudEnvironmentDialog,
} from "./WorkspaceBar";
import { orderRecentEnvironments } from "./recent-environments";
import {
  environmentChipTitle,
  EnvironmentChipContent,
} from "../ssh/EnvironmentChip";
import { formatText, t } from "../i18n";
import { CloudIcon, FolderIcon, FolderPlusIcon } from "../ui/icons";
import { WithTooltip, pathTail } from "../ui/Tooltip";
import { folderName } from "./recentFolders";
import { GitBranch, X } from "../ui/glyphs";
import { PixelMascot } from "./PixelMascot";
import { Menu } from "../ui/Menu";
import { expandedEnvironmentMenu } from "./code/code-environment-menu";
import { selectLocal } from "../ssh/actions";
import type { MenuEntry } from "../ui/Menu";
import type { Open } from "./WorkspaceBar";
import type { Project, Conversation } from "../../shared/types";
import type { RecentEnvironment } from "./EnvironmentStartCard";
import type { AppController } from "../app/AppContext";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import type { SshHost, SshStatus } from "../../shared/ssh-api";
import type { WorkspaceGit } from "../../shared/code-usage-api";

/** What workspaceBarView needs from WorkspaceBar.tsx. */
export interface WorkspaceBarViewKit {
  addFolder: () => Promise<void>;
  additionalFolders: string[];
  app: AppController | undefined;
  chip: (menu: "environment" | "folder") => string;
  cloud: {
    environments: CloudEnvironmentConfig[];
    selectedId: string;
    editing: CloudEnvironmentConfig | "new" | undefined;
    loaded: boolean;
    error: unknown;
  };
  cwd: string | undefined;
  editingLocal: boolean;
  environmentChip: React.RefObject<HTMLButtonElement | null>;
  environmentEntries: MenuEntry[];
  folder: React.RefObject<HTMLButtonElement | null>;
  folderEntries: MenuEntry[];
  homeDraft: boolean;
  host: SshHost | undefined;
  listed: Conversation[];
  open: Open | undefined;
  openRemoteFolder: () => void | undefined;
  project: Project | undefined;
  recentEnvironments: RecentEnvironment[];
  recentFolders: string[];
  remoteChosen:
    { id: string; name: string; folder?: string | undefined } | undefined;
  report: (error: unknown) => void | undefined;
  repository: WorkspaceGit;
  runningHere: number;
  setCwd: (cwd?: string | undefined) => void;
  setEditingLocal: React.Dispatch<React.SetStateAction<boolean>>;
  setOpen: React.Dispatch<React.SetStateAction<Open | undefined>>;
  setSwitching: React.Dispatch<React.SetStateAction<string | undefined>>;
  shownBranch: string | null;
  startChoose: React.RefObject<HTMLButtonElement | null>;
  status: SshStatus | undefined;
  switchTo: (branch: string) => Promise<void>;
  switching: string | undefined;
  toggle: (
    menu: "environment" | "folder",
    anchor: React.RefObject<HTMLButtonElement | null>,
  ) => void;
}

export function workspaceBarView(kit: WorkspaceBarViewKit) {
  const {
    addFolder,
    additionalFolders,
    app,
    chip,
    cloud,
    cwd,
    editingLocal,
    environmentChip,
    environmentEntries,
    folder,
    folderEntries,
    homeDraft,
    host,
    listed,
    open,
    openRemoteFolder,
    project,
    recentEnvironments,
    recentFolders,
    remoteChosen,
    report,
    repository,
    runningHere,
    setCwd,
    setEditingLocal,
    setOpen,
    setSwitching,
    shownBranch,
    startChoose,
    status,
    switchTo,
    switching,
    toggle,
  } = kit;
  const workspaceBarViewView = (
    <>
      <Suspense fallback={null}>
        <EnvironmentStartCard
          rows={orderRecentEnvironments(recentEnvironments, listed)}
          selectedId={cwd ? `folder:${cwd}` : "local"}
          open={open?.menu === "environment"}
          onRequestComposerFocus={() =>
            requestAnimationFrame(() => app?.composer.current?.focus())
          }
          onChoose={(button) => {
            startChoose.current = button;
            const box = button.getBoundingClientRect();
            setOpen(
              open?.menu === "environment"
                ? undefined
                : {
                    menu: "environment",
                    expanded: true,
                    position: {
                      left: box.left,
                      bottom: innerHeight - box.top + 6,
                    },
                  },
            );
          }}
        />
      </Suspense>
      <div className="workspace-bar">
        <button
          ref={environmentChip}
          className={`${chip("environment")} ${host ? "ssh-chip" : ""}`}
          title={environmentChipTitle(host, status)}
          aria-label={
            homeDraft
              ? formatText("Environment: {name}", {
                  name: remoteChosen?.name ?? host?.label ?? t("This computer"),
                })
              : undefined
          }
          aria-haspopup="menu"
          aria-expanded={open?.menu === "environment"}
          onClick={() => toggle("environment", environmentChip)}
        >
          {remoteChosen ? (
            <>
              <CloudIcon />
              <span data-no-translate>{remoteChosen.name}</span>
            </>
          ) : (
            <EnvironmentChipContent
              host={host}
              status={status}
              localLabel={homeDraft ? t("This computer") : undefined}
            />
          )}
        </button>
        {/* Hover or keyboard focus: "Working directory" over the path, above the
           chip. */}
        <WithTooltip
          label="Working directory"
          detail={cwd ? pathTail(cwd) : undefined}
          placement="above"
          gap={4}
          disabled={!cwd || open?.menu === "folder"}
        >
          {(tip) => (
            <button
              {...tip}
              ref={folder}
              className={chip("folder")}
              aria-label={
                homeDraft
                  ? formatText("Folder: {name}", {
                      name:
                        (remoteChosen?.folder ?? cwd)
                          ? folderName((remoteChosen?.folder ?? cwd)!)
                          : t("Choose folder…"),
                    })
                  : undefined
              }
              aria-haspopup="menu"
              aria-expanded={open?.menu === "folder"}
              onClick={() => toggle("folder", folder)}
            >
              <FolderIcon />
              <span data-no-translate={cwd ? true : undefined}>
                {remoteChosen
                  ? remoteChosen.folder
                    ? folderName(remoteChosen.folder)
                    : t("Select folder…")
                  : cwd
                    ? folderName(cwd)
                    : homeDraft
                      ? t("Choose…")
                      : host
                        ? "Select folder…"
                        : "No folder"}
              </span>
            </button>
          )}
        </WithTooltip>
        {shownBranch && (
          <span className="workspace-chip branch-chip" title={shownBranch}>
            <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{shownBranch}</span>
          </span>
        )}
        {switching && cwd && (
          <Suspense fallback={null}>
            <DirtyTreeDialog
              folder={cwd}
              currentBranch={repository.branch ?? "HEAD"}
              targetBranch={switching}
              otherSessions={runningHere}
              onResolve={async (action) => {
                const cleared = await window.desktop?.resolveFolderChanges?.(
                  cwd,
                  action,
                );
                if (!cleared) return false;
                const target = switching;
                setSwitching(undefined);
                await switchTo(target);
                return true;
              }}
              onClose={() => setSwitching(undefined)}
            />
          </Suspense>
        )}
        {host && (
          <button
            className="workspace-chip square-chip"
            aria-label={`Choose a folder on ${host.label}`}
            onClick={openRemoteFolder}
          >
            <FolderPlusIcon />
          </button>
        )}
        {additionalFolders.map((folder) => (
          <span
            className="workspace-chip additional-folder-chip"
            key={folder}
            title={folder}
          >
            <FolderIcon />
            <span data-no-translate>{folderName(folder)}</span>
            <button
              type="button"
              aria-label={formatText("Remove {name}", {
                name: folderName(folder),
              })}
              onClick={() =>
                app?.composerDraft.setDraftAdditionalFolders((folders) =>
                  folders.filter((item) => item !== folder),
                )
              }
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {!host && !remoteChosen && cwd && app && (
          <button
            className="workspace-chip square-chip"
            aria-label={t("Add another folder")}
            title={t("Add another folder")}
            onClick={() => void addFolder()}
          >
            <FolderPlusIcon />
          </button>
        )}
        {project && <span className="workspace-project">{project.name}</span>}
        {!homeDraft && <PixelMascot />}
        {editingLocal && (
          <Suspense fallback={null}>
            <LocalEnvironmentDialog
              value={app?.snapshot.settings.localEnvironmentVariables ?? ""}
              onSave={async (localEnvironmentVariables) =>
                app?.updatePreference({ localEnvironmentVariables })
              }
              onClose={() => setEditingLocal(false)}
            />
          </Suspense>
        )}
        {cloud.editing && (
          <Suspense fallback={null}>
            <CloudEnvironmentDialog
              environment={cloud.editing === "new" ? undefined : cloud.editing}
              onError={report}
            />
          </Suspense>
        )}
        {open && (
          <Menu
            label={open.menu === "folder" ? "Folder" : "Environment"}
            width={open.menu === "folder" ? 250 : open.expanded ? 260 : 200}
            searchable={open.expanded ? "Search environments…" : undefined}
            position={open.position}
            anchors={
              open.menu === "folder" ? [folder] : [environmentChip, startChoose]
            }
            entries={
              open.menu === "folder"
                ? folderEntries
                : open.expanded
                  ? expandedEnvironmentMenu(
                      environmentEntries,
                      recentFolders.map((path) => ({
                        label: folderName(path),
                        title: path,
                        noTranslate: true,
                        onSelect: () => {
                          selectLocal(setCwd);
                          setCwd(path);
                        },
                      })),
                    )
                  : environmentEntries
            }
            onClose={() => setOpen(undefined)}
          />
        )}
      </div>
    </>
  );
  return workspaceBarViewView;
}
