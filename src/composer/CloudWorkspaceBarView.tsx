import { Suspense } from "react";
import {
  EnvironmentStartCard,
  githubUnavailable,
  githubDisconnected,
  addRepositoryLabel,
  WebCodeEnvironmentMenu,
  RepositoryMenu,
  BranchMenu,
  GitHubReturnPrompt,
  CloudEnvironmentDialog,
  LocalEnvironmentDialog,
} from "./CloudWorkspaceBar";
import { formatText } from "../i18n";
import { CloseIcon, PlusIcon } from "../ui/icons";
import { AppIcon } from "../ui/app-icon";
import type { Open } from "./CloudWorkspaceBar";
import { GithubMark } from "../ui/GithubMark";
import { GitBranch } from "../ui/glyphs";
import { removeCodeRepository } from "./code-repository";
import { PixelMascot } from "./PixelMascot";
import { setRemoteEnvironment } from "../remote-control/environment";
import {
  selectCloudEnvironment,
  editCloudEnvironment,
} from "./cloud-environments";
import { Menu } from "../ui/Menu";
import type { GitHubRepository, GitHubStatus } from "../../shared/github-api";
import type { MenuEntry } from "../ui/Menu";
import type { ChosenRepository } from "./code-repository";
import type { AppController } from "../app/AppContext";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";

/** What cloudWorkspaceBarView needs from CloudWorkspaceBar.tsx. */
export interface CloudWorkspaceBarViewKit {
  add: (repository: GitHubRepository | undefined) => void;
  addChip: React.RefObject<HTMLButtonElement | null>;
  addOpen: { menu: "add"; left: number };
  app: AppController | undefined;
  bar: React.RefObject<HTMLDivElement | null>;
  chip: (next: Open) => string;
  chooseBranch: (target: string, branch: string) => void;
  cloud: {
    environments: CloudEnvironmentConfig[];
    selectedId: string;
    editing: CloudEnvironmentConfig | "new" | undefined;
    loaded: boolean;
    error: unknown;
  };
  disconnected: boolean;
  editingLocal: boolean;
  environmentChip: React.RefObject<HTMLButtonElement | null>;
  environmentName: string;
  environments: CloudEnvironmentConfig[];
  expandedEntries: MenuEntry[];
  full: boolean;
  isOpen: (next: Open) => boolean;
  leftOf: (anchor: React.RefObject<HTMLElement | null>) => number;
  menuEntries: MenuEntry[];
  open: Open | undefined;
  openTarget: ChosenRepository | undefined;
  pillAnchor: (key: string) => React.RefObject<HTMLButtonElement | null>;
  pillChips: React.RefObject<Map<string, HTMLButtonElement>>;
  pillRef: (key: string) => (node: HTMLButtonElement | null) => void;
  platform: string;
  recentEnvironments: (
    | {
        id: string;
        name: string;
        detail: string;
        detailKind: "local-path";
        onSelect: () => void;
      }
    | {
        id: string;
        name: string;
        detail: string;
        detailKind: "text";
        onSelect: () => void;
      }
    | {
        id: string;
        name: string;
        icon: React.JSX.Element;
        onSelect: () => void;
      }
  )[];
  removable: boolean;
  report: (error: unknown) => void | undefined;
  repositories: ChosenRepository[];
  repositoryPopupId: string;
  returned: "denied" | "failed" | undefined;
  setEditingLocal: React.Dispatch<React.SetStateAction<boolean>>;
  setOpen: React.Dispatch<React.SetStateAction<Open | undefined>>;
  setReturned: React.Dispatch<
    React.SetStateAction<"denied" | "failed" | undefined>
  >;
  setStatus: React.Dispatch<React.SetStateAction<GitHubStatus | undefined>>;
  startChoose: React.RefObject<HTMLButtonElement | null>;
  status: GitHubStatus | undefined;
  swap: (target: string, repository: GitHubRepository | undefined) => void;
  toggle: (next: Open, anchor: React.RefObject<HTMLElement | null>) => void;
  unavailable: boolean | undefined;
  webDraft: boolean;
}

export function cloudWorkspaceBarView(kit: CloudWorkspaceBarViewKit) {
  const {
    add,
    addChip,
    addOpen,
    app,
    bar,
    chip,
    chooseBranch,
    cloud,
    disconnected,
    editingLocal,
    environmentChip,
    environmentName,
    environments,
    expandedEntries,
    full,
    isOpen,
    leftOf,
    menuEntries,
    open,
    openTarget,
    pillAnchor,
    pillChips,
    pillRef,
    platform,
    recentEnvironments,
    removable,
    report,
    repositories,
    repositoryPopupId,
    returned,
    setEditingLocal,
    setOpen,
    setReturned,
    setStatus,
    startChoose,
    status,
    swap,
    toggle,
    unavailable,
    webDraft,
  } = kit;
  const cloudWorkspaceBarViewView = (
    <>
      <Suspense fallback={null}>
        <EnvironmentStartCard
          rows={recentEnvironments}
          selectedId={`cloud:${cloud.selectedId}`}
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
      <div ref={bar} className="workspace-bar cloud-workspace-bar">
        <button
          ref={environmentChip}
          className={chip({ menu: "environment", position: { left: 0 } })}
          aria-label={formatText("Environment: {name}", {
            name: environmentName,
          })}
          aria-haspopup="menu"
          aria-expanded={open?.menu === "environment"}
          onClick={() =>
            toggle(
              { menu: "environment", position: { left: 0 } },
              environmentChip,
            )
          }
        >
          {/* The live chips' 16px glyphs: Cloud, then Folder for Repo. */}
          <AppIcon name="Cloud" size={16} />
          <span>{environmentName}</span>
        </button>
        {repositories.map((repository) => {
          const repoOpen: Open = {
            menu: "repository",
            left: 0,
            target: repository.fullName,
          };
          const branchOpen: Open = { ...repoOpen, menu: "branch" };
          const repoKey = `repo:${repository.fullName}`;
          const branchKey = `branch:${repository.fullName}`;
          const name =
            repository.fullName.split("/").pop() || repository.fullName;
          return (
            <span key={repository.fullName} className="workspace-repo">
              <button
                ref={pillRef(repoKey)}
                className={`${chip(repoOpen)} ${unavailable ? "repository-chip-unavailable" : ""}`}
                title={
                  unavailable
                    ? githubUnavailable
                    : disconnected
                      ? githubDisconnected
                      : repository.fullName
                }
                aria-haspopup="menu"
                aria-expanded={isOpen(repoOpen)}
                onClick={() => toggle(repoOpen, pillAnchor(repoKey))}
              >
                <GithubMark size={16} />
                {/* The live pill shows the repository's name; the owner is in the tooltip. */}
                <span translate="no">{name}</span>
              </button>
              <button
                ref={pillRef(branchKey)}
                className={chip(branchOpen)}
                title={repository.branch}
                aria-haspopup="menu"
                aria-expanded={isOpen(branchOpen)}
                onClick={() => toggle(branchOpen, pillAnchor(branchKey))}
              >
                <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
                <span translate="no">{repository.branch}</span>
              </button>
              {removable && (
                <button
                  type="button"
                  className="workspace-repo-remove"
                  aria-label={formatText("Remove {repoName}", {
                    repoName: name,
                  })}
                  title={formatText("Remove {repoName}", { repoName: name })}
                  onClick={() => removeCodeRepository(repository.fullName)}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </span>
          );
        })}
        {/* At the runner's limit there is nothing more to add. */}
        {!full && (
          <button
            ref={addChip}
            className={`${chip(addOpen)} ${repositories.length ? "square-chip" : ""} ${unavailable ? "repository-chip-unavailable" : ""}`}
            title={
              unavailable
                ? githubUnavailable
                : repositories.length
                  ? addRepositoryLabel
                  : undefined
            }
            aria-label={addRepositoryLabel}
            role={webDraft ? "combobox" : undefined}
            aria-haspopup={webDraft ? "dialog" : "menu"}
            aria-controls={
              webDraft && isOpen(addOpen) ? repositoryPopupId : undefined
            }
            aria-expanded={isOpen(addOpen)}
            onClick={() => toggle(addOpen, addChip)}
            onKeyDown={(event) => {
              if (!webDraft || !["ArrowDown", "ArrowUp"].includes(event.key))
                return;
              event.preventDefault();
              setOpen({ menu: "add", left: leftOf(addChip) });
            }}
          >
            {repositories.length ? (
              <PlusIcon />
            ) : (
              <AppIcon name="Folder" size={16} />
            )}
            {!repositories.length && <span>Repo</span>}
          </button>
        )}
        {!webDraft && <PixelMascot />}
        {open?.menu === "environment" &&
          (webDraft ? (
            <Suspense fallback={null}>
              <WebCodeEnvironmentMenu
                options={{
                  environments,
                  selectedId: cloud.selectedId,
                  loaded: cloud.loaded,
                  error: cloud.error,
                  platform,
                  onChoose: (id) => {
                    setRemoteEnvironment(undefined);
                    selectCloudEnvironment(id);
                  },
                  onEdit: editCloudEnvironment,
                  onCreate: () => editCloudEnvironment(),
                  onDownload: () => window.location.assign("/downloads"),
                }}
                position={open.position}
                anchors={[environmentChip, startChoose]}
                onClose={() => setOpen(undefined)}
              />
            </Suspense>
          ) : (
            <Menu
              label="Environment"
              width={open.expanded ? 260 : 200}
              position={open.position}
              anchors={[environmentChip, startChoose]}
              searchable={
                open.expanded || environments.length > 10
                  ? "Search environments…"
                  : undefined
              }
              entries={open.expanded ? expandedEntries : menuEntries}
              onClose={() => setOpen(undefined)}
            />
          ))}
        <Suspense fallback={null}>
          {open?.menu === "add" && (
            <RepositoryMenu
              combobox={webDraft}
              popupId={webDraft ? repositoryPopupId : undefined}
              focusFallback={
                webDraft
                  ? (repository) =>
                      pillChips.current.get(`repo:${repository.fullName}`) ??
                      environmentChip.current
                  : undefined
              }
              status={status}
              left={open.left || leftOf(addChip)}
              anchor={addChip}
              selected={
                repositories.length
                  ? repositories.map((r) => r.fullName)
                  : undefined
              }
              onChoose={add}
              onStatus={setStatus}
              onClose={() => setOpen(undefined)}
            />
          )}
          {open?.menu === "repository" && openTarget && (
            <RepositoryMenu
              status={status}
              left={open.left}
              anchor={pillAnchor(`repo:${openTarget.fullName}`)}
              chosen={openTarget.fullName}
              exclude={repositories
                .filter((r) => r.fullName !== openTarget.fullName)
                .map((r) => r.fullName)}
              noRepository={repositories.length === 1}
              onChoose={(repository) => swap(openTarget.fullName, repository)}
              onStatus={setStatus}
              onClose={() => setOpen(undefined)}
            />
          )}
          {open?.menu === "branch" && openTarget && (
            <BranchMenu
              repository={openTarget.fullName}
              defaultBranch={openTarget.defaultBranch}
              current={openTarget.branch}
              left={open.left}
              anchor={pillAnchor(`branch:${openTarget.fullName}`)}
              onChoose={(branch) =>
                chooseBranch(openTarget.fullName, branch.name)
              }
              onClose={() => setOpen(undefined)}
            />
          )}
          {returned && (
            <GitHubReturnPrompt
              cause={returned}
              onClose={() => setReturned(undefined)}
            />
          )}
        </Suspense>
        {cloud.editing && (
          <Suspense fallback={null}>
            <CloudEnvironmentDialog
              environment={cloud.editing === "new" ? undefined : cloud.editing}
              onError={report}
            />
          </Suspense>
        )}
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
      </div>
    </>
  );
  return cloudWorkspaceBarViewView;
}
