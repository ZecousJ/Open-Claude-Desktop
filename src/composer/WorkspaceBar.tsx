import {
  lazy,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Project } from "../../shared/types";
import type { DeviceDirectory } from "../../shared/remote-devices";
import {
  setRemoteEnvironment,
  useRemoteEnvironment,
} from "../remote-control/environment";
import { useRemoteMachines } from "../remote-control/useRemoteMachines";
import { type MenuEntry, type MenuPosition } from "../ui/Menu";
import { FolderIcon } from "../ui/icons";
import { folderName, recentFolders as foldersIn } from "./recentFolders";
import { useWorkspaceGit } from "../code-home/useWorkspaceGit";
import { AppContext } from "../app/AppContext";
import { useSshHosts } from "../ssh/useSshHosts";
import { setCodeEnvironment, useCodeEnvironment } from "../ssh/codeEnvironment";
import { chooseRemoteFolder, selectHost, selectLocal } from "../ssh/actions";
import { openSshDialog } from "../ssh/dialogs";
import { hostAddress, localEnvironment, sshHostId } from "../ssh/model";
import { codeEnvironmentMenu } from "./code/code-environment-menu";
import { setCodeCloud } from "./code-cloud";
import { preference } from "../../shared/settings-extras";
import type { FolderBranches } from "../../shared/code-usage-api";
import { setDraftBranch, useDraftBranch } from "./draft-branch";
import { isRunning } from "../conversation/unread";
import { formatText, t } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import {
  editCloudEnvironment,
  selectCloudEnvironment,
  useCloudEnvironments,
} from "./cloud-environments";
import type { RecentEnvironment } from "./EnvironmentStartCard";
import { CloudIcon } from "../ui/icons";
import { workspaceBarView } from "./WorkspaceBarView";

export const CloudEnvironmentDialog = lazyPiece(
  () => import("./CloudEnvironmentDialog"),
  "CloudEnvironmentDialog",
);
export const EnvironmentStartCard = lazyPiece(
  () => import("./EnvironmentStartCard"),
  "EnvironmentStartCard",
);

export const DirtyTreeDialog = lazy(() => import("./DirtyTreeDialog"));
// The editor and its .env checks load when it opens.
export const LocalEnvironmentDialog = lazy(() =>
  import("./LocalEnvironmentDialog").then((module) => ({
    default: module.LocalEnvironmentDialog,
  })),
);

export type Open = {
  menu: "environment" | "folder";
  position: MenuPosition;
  expanded?: boolean;
};

/**
 * Environment and folder chips above the Code home composer. Both chips open
 * menus 6px above them, left-aligned; the square chip goes straight to the
 * folder picker. The environment menu lists Local, Cloud, Remote Control and
 * SSH as the capture does (src/code-environment-menu.ts); SSH › lists the saved
 * hosts, and Cloud selects or edits a saved runner profile. On a host the
 * folder menu lists that host's recent folders and Open folder… browses the
 * host. In a local Git repository the branch chip names the checked-out branch;
 * the folder menu ends with the Worktree switch (electron/code-worktree.ts).
 */
export function WorkspaceBar({
  homeDraft = false,
  cwd,
  recentFolders,
  project,
  setCwd,
  pickFolder,
}: {
  /** Modern home chin; open-session workspace controls keep their own layout. */
  homeDraft?: boolean;
  cwd?: string;
  recentFolders: string[];
  project?: Project;
  setCwd: (cwd?: string) => void;
  pickFolder: () => Promise<void>;
}) {
  const app = useContext(AppContext);
  const report = (error: unknown) => app?.report(error);
  const [open, setOpen] = useState<Open>();
  const [editingLocal, setEditingLocal] = useState(false);
  const remote = useRemoteMachines(open?.menu === "environment");
  const remoteChosen = useRemoteEnvironment();
  const [remoteFolders, setRemoteFolders] = useState<DeviceDirectory[]>([]);
  useEffect(() => {
    if (!remoteChosen) return;
    let active = true;
    void window.desktop
      .dispatchCall(remoteChosen.id, "listDirectories", [])
      .then((folders) => {
        if (active) setRemoteFolders(folders as DeviceDirectory[]);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [remoteChosen?.id]);
  const cloud = useCloudEnvironments(report);
  const startChoose = useRef<HTMLButtonElement | null>(null);
  const ssh = useSshHosts();
  const chosen = useCodeEnvironment();
  const hostId = ssh.ready ? sshHostId(chosen.environment) : undefined;
  const host = ssh.hosts.find((h) => h.id === hostId);
  const environment = host ? chosen.environment : localEnvironment;
  const additionalFolders =
    host || remoteChosen
      ? []
      : (app?.composerDraft.draftAdditionalFolders.filter(
          (folder) => folder !== cwd,
        ) ?? []);
  const addingFolder = useRef(false);
  const addFolder = async () => {
    if (addingFolder.current || !app) return;
    addingFolder.current = true;
    try {
      // The draft's plus browses once; the session panel accepts multiple
      // folders.
      const folder = await window.desktop.chooseFolder(
        t("Add folder to session"),
      );
      if (folder && folder !== cwd)
        app.composerDraft.setDraftAdditionalFolders((folders) =>
          folders.includes(folder) ? folders : [...folders, folder],
        );
    } catch (error) {
      report(error);
    } finally {
      addingFolder.current = false;
    }
  };
  const status = host ? ssh.statuses[host.id] : undefined;
  const [gitRead, setGitRead] = useState(0);
  const repository = useWorkspaceGit(
    remoteChosen ? undefined : cwd,
    gitRead,
    environment,
  );
  // The folder menu's Branch: with Worktree on it picks the new worktree's
  // start branch; otherwise it checks the branch out, asking first about
  // uncommitted changes.
  const [branches, setBranches] = useState<FolderBranches | null>(null);
  const [switching, setSwitching] = useState<string>();
  const worktreeOn =
    !host &&
    repository.branch !== null &&
    Boolean(app && preference(app.snapshot.settings, "codeWorktree"));
  const draftBranch = useDraftBranch(cwd);
  const shownBranch = (worktreeOn && draftBranch) || repository.branch;
  const runningHere = (app?.listed ?? []).filter(
    (c) => c.cwd === cwd && isRunning(c),
  ).length;
  const switchTo = async (branch: string) => {
    if (!cwd) return;
    const result = await window.desktop?.switchFolderBranch?.(cwd, branch);
    if (result?.ok) setGitRead((n) => n + 1);
    else if (result?.reason === "dirty") setSwitching(branch);
    else
      app?.report(
        new Error(
          result?.reason === "elsewhere"
            ? t(
                "Git won’t check out a branch in two folders at once. Run git worktree list in the repository to see which folder has this branch, switch that folder to a different branch, then try again.",
              )
            : t("Couldn’t switch to that branch."),
        ),
      );
  };
  const chooseBranch = (branch: string) => {
    if (!cwd) return;
    if (worktreeOn)
      setDraftBranch(cwd, branch === repository.branch ? undefined : branch);
    else void switchTo(branch);
  };
  const environmentChip = useRef<HTMLButtonElement>(null);
  const folder = useRef<HTMLButtonElement>(null);

  // A removed host, or SSH turned off, leaves the Code home on this computer.
  const stale = Boolean(sshHostId(chosen.environment)) && ssh.loaded && !host;
  useEffect(() => {
    if (stale) selectLocal(setCwd);
  }, [stale]);
  // Opening a project or a conversation sets a local folder: back to Local.
  useEffect(() => {
    if (host && cwd !== chosen.folder)
      setCodeEnvironment({ environment: localEnvironment });
  }, [cwd]);

  useEffect(() => {
    if (open?.menu !== "folder" || !cwd || host || remoteChosen) return;
    let live = true;
    void Promise.resolve(window.desktop?.folderBranches?.(cwd))
      .then((value) => live && setBranches(value ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open?.menu, cwd, host, gitRead]);
  const toggle = (
    menu: Open["menu"],
    anchor: RefObject<HTMLButtonElement | null>,
  ) => {
    const box = anchor.current?.getBoundingClientRect();
    if (open?.menu === menu || !box) return setOpen(undefined);
    setOpen({
      menu,
      position: { left: box.left, bottom: innerHeight - box.top + 6 },
    });
  };
  const openRemoteFolder = () =>
    host && openSshDialog({ kind: "folder", hostId: host.id });
  const listed = app?.listed ?? [];
  const recents = host
    ? foldersIn(listed, 8, environment)
    : cwd && !recentFolders.includes(cwd)
      ? [cwd, ...recentFolders]
      : recentFolders;
  const remoteRecents =
    host && cwd && !recents.includes(cwd) ? [cwd, ...recents] : recents;
  const recentEntries = (paths: string[], choose: (path: string) => void) =>
    paths.length
      ? [
          { heading: "Recent" },
          ...paths.slice(0, 8).map((path) => ({
            label: folderName(path),
            title: path,
            noTranslate: true,
            checked: path === cwd,
            onSelect: () => choose(path),
          })),
          { separator: true } as const,
        ]
      : [];
  // A session on a host needs a folder there, so there is no "No folder".
  const folderEntries: MenuEntry[] = remoteChosen
    ? remoteFolders.map((folder) => ({
        label: folder.name,
        noTranslate: true,
        title: folder.path,
        checked: remoteChosen.folder === folder.path,
        onSelect: () => {
          setRemoteEnvironment({ ...remoteChosen, folder: folder.path });
        },
      }))
    : host
      ? [
          ...recentEntries(remoteRecents, (path) =>
            chooseRemoteFolder(host.id, path, setCwd).catch(report),
          ),
          { label: "Open folder…", onSelect: openRemoteFolder },
        ]
      : [
          {
            label: "No folder",
            checked: !cwd,
            onSelect: () => setCwd(undefined),
          },
          { separator: true },
          ...recentEntries(recents, (path) => setCwd(path)),
          { label: "Open folder…", onSelect: () => void pickFolder() },
          // Worktree: the new session works in its own worktree of the folder's
          // repository.
          ...(cwd && app
            ? [
                { separator: true } as const,
                ...(branches?.branches.length
                  ? [
                      {
                        label: "Branch",
                        searchable: "Search branches…",
                        searchEmpty: "No matching branches",
                        submenu: branches.branches.map((name) => ({
                          label: name,
                          noTranslate: true,
                          checked: name === shownBranch,
                          onSelect: () => chooseBranch(name),
                        })),
                      },
                    ]
                  : []),
                {
                  label: "Worktree",
                  switched:
                    repository.branch !== null &&
                    preference(app.snapshot.settings, "codeWorktree"),
                  disabled: repository.branch === null,
                  title:
                    repository.branch === null
                      ? "Git is required to use a worktree."
                      : undefined,
                  keepOpen: true,
                  onSelect: () =>
                    void app.updatePreference({
                      codeWorktree: !preference(
                        app.snapshot.settings,
                        "codeWorktree",
                      ),
                    }),
                },
              ]
            : []),
        ];
  const environmentEntries = codeEnvironmentMenu({
    hosts: ssh.hosts,
    statuses: ssh.statuses,
    selected: environment,
    ssh: ssh.ready || !ssh.loaded,
    loading: !ssh.loaded,
    onLocal: () => {
      setRemoteEnvironment(undefined);
      selectLocal(setCwd);
      if (remoteChosen) setCwd(undefined);
    },
    onHost: (picked) => {
      setRemoteEnvironment(undefined);
      void selectHost(picked, setCwd, report);
    },
    onAdd: () => openSshDialog({ kind: "host", select: true }),
    onEdit: (host) => openSshDialog({ kind: "host", host }),
    remote,
    selectedRemoteId: remoteChosen?.id,
    onRemote: (id) => {
      const device = remote?.devices?.find((item) => item.id === id);
      if (!device) return;
      if (!remote?.onlineDeviceIds?.includes(id)) {
        app?.notify(
          "Remote Control is offline. Turn it back on from the computer that runs it, or select another environment.",
        );
        return;
      }
      if (device.sessions && device.sessions.active >= device.sessions.max) {
        app?.notify(
          formatText(
            device.sessions.max === 1
              ? "Remote Control is at capacity ({active} of {max} session). End one to start another."
              : "Remote Control is at capacity ({active} of {max} sessions). End one to start another.",
            device.sessions,
          ),
        );
        return;
      }
      setRemoteFolders([]);
      setCodeCloud(false);
      selectLocal(setCwd);
      setCwd(undefined);
      setRemoteEnvironment({ id, name: device.name });
    },
    onSetupRemote: () => {
      if (app?.host?.capabilities.localCode) app.openSettingsTab("general");
      else app?.setPage("dispatch");
    },
    onEditLocal: () => setEditingLocal(true),
    environments: cloud.environments,
    onCreateCloud: () => editCloudEnvironment(),
    onEditCloud: editCloudEnvironment,
    onCloud: (id) => {
      setRemoteEnvironment(undefined);
      setOpen(undefined);
      selectLocal(setCwd);
      selectCloudEnvironment(id);
      setCodeCloud(true);
    },
  });
  const recentEnvironments: RecentEnvironment[] = [
    ...recents.map((path) => ({
      id: `folder:${path}`,
      name: folderName(path),
      detail: path,
      detailKind: host ? ("path" as const) : ("local-path" as const),
      icon: <FolderIcon />,
      onSelect: () =>
        host
          ? void chooseRemoteFolder(host.id, path, setCwd).catch(report)
          : setCwd(path),
    })),
    ...ssh.hosts
      .filter((entry) => entry.id !== hostId)
      .map((entry) => ({
        id: `ssh:${entry.id}`,
        name: entry.label,
        detail: hostAddress(entry),
        detailKind: "text" as const,
        onSelect: () => void selectHost(entry, setCwd, report),
      })),
    ...cloud.environments.map((entry) => ({
      id: `cloud:${entry.id}`,
      name: entry.name,
      icon: <CloudIcon />,
      onSelect: () => {
        selectLocal(setCwd);
        selectCloudEnvironment(entry.id);
        setCodeCloud(true);
      },
    })),
  ];
  if (!cwd)
    recentEnvironments.unshift({
      id: "local",
      name: t("Local"),
      onSelect: () => selectLocal(setCwd),
    });
  const chip = (menu: Open["menu"]) =>
    `workspace-chip ${open?.menu === menu ? "open" : ""}`;
  const workspaceBarViewView = workspaceBarView({
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
  });
  return workspaceBarViewView;
}
