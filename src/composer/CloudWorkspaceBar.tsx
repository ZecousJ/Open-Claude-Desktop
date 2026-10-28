import { githubConnectionChanged } from "../github/connection-events";
import {
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { GitHubRepository, GitHubStatus } from "../../shared/github-api";
import { parseGitHubReturn } from "../../shared/github-api";
import { api } from "../desktop-api";
import { formatText, t } from "../i18n";
import {
  addCodeRepository,
  chooseCodeRepository,
  maxCodeRepositories,
  onRepositoryPickerRequest,
  removeCodeRepository,
  restoreCodeRepository,
  setCodeRepositoryBranch,
  swapCodeRepository,
  useChosenRepositories,
  type ChosenRepository,
} from "./code-repository";
import { type MenuEntry, type MenuPosition } from "../ui/Menu";
import { CloudIcon } from "../ui/icons";
import { useHost } from "../host/HostContext";
import { setCodeCloud } from "./code-cloud";
import {
  defaultCloudEnvironment,
  type CloudNetworkLevel,
} from "../../shared/host";
import { lazyPiece } from "../ui/lazy-piece";
import { useContext } from "react";
import { AppContext } from "../app/AppContext";
import {
  editCloudEnvironment,
  selectCloudEnvironment,
  useCloudEnvironments,
} from "./cloud-environments";
import {
  environmentUsage,
  orderRecentEnvironments,
} from "./recent-environments";
import {
  codeEnvironmentMenu,
  expandedEnvironmentMenu,
} from "./code/code-environment-menu";
import { useSshHosts } from "../ssh/useSshHosts";
import { selectHost, selectLocal } from "../ssh/actions";
import { setCodeEnvironment, useCodeEnvironment } from "../ssh/codeEnvironment";
import { hostAddress, localEnvironment } from "../ssh/model";
import { openSshDialog } from "../ssh/dialogs";
import { folderName } from "./recentFolders";
import { ShortcutPlatform } from "../ui/Tooltip";
import { newCodeEnvironmentShortcut } from "./web-code-environments";
import { useRemoteMachines } from "../remote-control/useRemoteMachines";
import {
  setRemoteEnvironment,
  useRemoteEnvironment,
} from "../remote-control/environment";
import { cloudWorkspaceBarView } from "./CloudWorkspaceBarView";
const RemoteWorkspaceBar = lazyPiece(
  () => import("./WorkspaceBar"),
  "WorkspaceBar",
);
export const EnvironmentStartCard = lazyPiece(
  () => import("./EnvironmentStartCard"),
  "EnvironmentStartCard",
);

export const CloudEnvironmentDialog = lazyPiece(
  () => import("./CloudEnvironmentDialog"),
  "CloudEnvironmentDialog",
);
export const LocalEnvironmentDialog = lazyPiece(
  () => import("./LocalEnvironmentDialog"),
  "LocalEnvironmentDialog",
);

// The picker is only needed when a chip is opened; keep it out of the first load.
export const RepositoryMenu = lazyPiece(
  () => import("./RepositoryMenu"),
  "RepositoryMenu",
);
export const BranchMenu = lazyPiece(
  () => import("./repository-menu-parts"),
  "BranchMenu",
);
export const WebCodeEnvironmentMenu = lazyPiece(
  () => import("./WebCodeEnvironmentMenu"),
  "WebCodeEnvironmentMenu",
);
// Coming back from GitHub without a connection: the recovery page.
export const GitHubReturnPrompt = lazyPiece(
  () => import("./GitHubReturnPrompt"),
  "GitHubReturnPrompt",
);

/** Why the web Code home cannot start a task yet. */
export { cloudCodeUnavailable } from "./code-cloud";

/**
 * The sandbox's network level under an environment's name, as the live
 * environment lists say it.
 */
export const networkLabels: Record<CloudNetworkLevel, string> = {
  none: "No network access",
  trusted: "Trusted network access",
  custom: "Custom network access",
  full: "Full network access",
};

/** The chip's tooltip while the service has no GitHub app. */
export const githubUnavailable = "GitHub isn't set up on this service";
/** A remembered repository while GitHub is not connected. */
export const githubDisconnected = "Connect GitHub to use this repository";
/** The Add trigger's name once a repository is chosen. */
export const addRepositoryLabel = "Add repository";

export type Open =
  | { menu: "environment"; position: MenuPosition; expanded?: boolean }
  /** A pill's repository or branch menu (`target` is its "owner/name"). */
  | { menu: "repository" | "branch"; left: number; target: string }
  /** The Add trigger's menu (or "Select repository…" before any). */
  | { menu: "add"; left: number };

/**
 * The web Code home's chips above the composer (ref-web-code-home, W-UI-design
 * §5.2): the cloud environment ("Default", cloud icon), then a pill per chosen
 * repository (its name and its branch, and a × once there are two or more) and
 * the Add trigger: "Select repository…" before any, a + named "Add repository"
 * after. They are the desktop's workspace chips and open menus 6px above them.
 * The environment menu lists the runner's environments, each with its network
 * level; the repository menus are the service's GitHub connection
 * (RepositoryMenu.tsx). The choice goes to code-repository.ts, which the
 * composer sends with the new session and the browser remembers for the next
 * visit.
 */
export function CloudWorkspaceBar({
  webDraft = false,
}: {
  webDraft?: boolean;
}) {
  const repositoryPopupId = useId();
  const host = useHost();
  const app = useContext(AppContext);
  const platform = useContext(ShortcutPlatform);
  const report = (error: unknown) => app?.report(error);
  const cloud = useCloudEnvironments(report);
  const ssh = useSshHosts();
  const chosen = useCodeEnvironment();
  const [editingLocal, setEditingLocal] = useState(false);
  const setCwd = (cwd?: string) => app?.setCwd(cwd);
  const chooseLocal = (cwd?: string) => {
    setRemoteEnvironment(undefined);
    selectLocal(setCwd);
    setCodeEnvironment({ environment: localEnvironment });
    setCwd(cwd);
    setCodeCloud(false);
  };
  const environment = cloud.environments.find(
    (entry) => entry.id === cloud.selectedId,
  );
  const environmentName =
    environment?.name ??
    (!cloud.loaded && !cloud.error
      ? defaultCloudEnvironment(host.cloud)?.name
      : undefined) ??
    t("No environment");
  const [open, setOpen] = useState<Open>();
  useEffect(() => {
    if (!webDraft) return;
    const create = (event: KeyboardEvent) => {
      if (
        !newCodeEnvironmentShortcut(event, platform) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      setOpen(undefined);
      editCloudEnvironment();
    };
    document.addEventListener("keydown", create);
    return () => document.removeEventListener("keydown", create);
  }, [webDraft, platform]);
  const remote = useRemoteMachines(open?.menu === "environment");
  const remoteChosen = useRemoteEnvironment();
  const [status, setStatus] = useState<GitHubStatus>();
  // The choice of an earlier visit shows (and sends) again.
  useState(restoreCodeRepository);
  const repositories = useChosenRepositories();
  const [returned, setReturned] = useState<"denied" | "failed">();
  const bar = useRef<HTMLDivElement>(null);
  const environmentChip = useRef<HTMLButtonElement>(null);
  const startChoose = useRef<HTMLButtonElement | null>(null);
  const addChip = useRef<HTMLButtonElement>(null);
  // Each pill's two chips, by repository and kind ("repo"/"branch").
  const pillChips = useRef(new Map<string, HTMLButtonElement>());
  const pillRef = (key: string) => (node: HTMLButtonElement | null) => {
    if (node) pillChips.current.set(key, node);
    else pillChips.current.delete(key);
  };
  const pillAnchor = (key: string): RefObject<HTMLButtonElement | null> => ({
    current: pillChips.current.get(key) ?? null,
  });

  // Whether GitHub is set up and connected; asked once, and again when the
  // person comes back from GitHub (/code?github=…), or to the window while
  // not connected (the desktop connects in the browser).
  const connectedNow = useRef(false);
  connectedNow.current = Boolean(status?.connected);
  useEffect(() => {
    let current = true,
      latest = 0;
    const ask = (first: boolean) => {
      const id = ++latest;
      return api.githubStatus().then(
        (next) => current && id === latest && setStatus(next),
        () =>
          current &&
          id === latest &&
          first &&
          setStatus({ configured: false, connected: false }),
      );
    };
    void ask(true);
    const focus = () => {
      if (!connectedNow.current) void ask(false);
    };
    const changed = () => {
      void ask(false);
    };
    window.addEventListener(githubConnectionChanged, changed);
    window.addEventListener("focus", focus);
    return () => {
      current = false;
      window.removeEventListener("focus", focus);
      window.removeEventListener(githubConnectionChanged, changed);
    };
  }, []);
  // Back from GitHub: the menu opens on the person's repositories; a
  // refusal or a failure shows the recovery page.
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = parseGitHubReturn(url.searchParams.get("github"));
    if (!result) return;
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", url);
    if (result === "connected") setOpen({ menu: "add", left: 0 });
    else setReturned(result);
  }, []);

  const leftOf = (anchor: RefObject<HTMLElement | null>) =>
    (anchor.current?.offsetLeft ?? 0) - (bar.current?.offsetLeft ?? 0);
  // Sending without a repository opens the repository menu: the list, or
  // Connect GitHub when the account has none.
  useEffect(
    () =>
      onRepositoryPickerRequest(() =>
        setOpen({ menu: "add", left: leftOf(addChip) }),
      ),
    [],
  );
  const same = (next: Open) =>
    open?.menu === next.menu &&
    (open.menu === "environment" ||
      open.menu === "add" ||
      open.target === (next as { target: string }).target);
  const toggle = (next: Open, anchor: RefObject<HTMLElement | null>) => {
    const box = anchor.current?.getBoundingClientRect();
    if (same(next) || !box) return setOpen(undefined);
    setOpen(
      next.menu === "environment"
        ? {
            menu: "environment",
            position: { left: box.left, bottom: innerHeight - box.top + 6 },
          }
        : { ...next, left: leftOf(anchor) },
    );
  };
  const chosenOf = (repository: GitHubRepository): ChosenRepository => ({
    fullName: repository.fullName,
    url: repository.cloneUrl,
    defaultBranch: repository.defaultBranch,
    branch: repository.defaultBranch,
  });
  // The Add menu: a new pill, or (before any) the only one; choosing a
  // repository that is already a pill takes it away again.
  const add = (repository: GitHubRepository | undefined) => {
    setOpen(undefined);
    if (!repository) return chooseCodeRepository(undefined);
    if (repositories.some((r) => r.fullName === repository.fullName))
      return removeCodeRepository(repository.fullName);
    addCodeRepository(chosenOf(repository));
  };
  // A pill's menu: another repository in its place ("No repository" while
  // it is the only one).
  const swap = (target: string, repository: GitHubRepository | undefined) => {
    setOpen(undefined);
    if (!repository) return removeCodeRepository(target);
    swapCodeRepository(target, chosenOf(repository));
  };
  const chooseBranch = (target: string, branch: string) => {
    setOpen(undefined);
    setCodeRepositoryBranch(target, branch);
  };

  // Cloud profiles select independently of their editing gears.
  const environments = cloud.environments;
  const desktopEnvironmentEntries = codeEnvironmentMenu({
    hosts: ssh.hosts,
    statuses: ssh.statuses,
    selected: chosen.environment,
    selectedCloudId: cloud.selectedId,
    ssh: ssh.ready || !ssh.loaded,
    loading: !ssh.loaded,
    remote,
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
      setCodeEnvironment({ environment: localEnvironment });
      setCodeCloud(false);
      setCwd(undefined);
      setRemoteEnvironment({ id, name: device.name });
    },
    onSetupRemote: () => app?.setPage("dispatch"),
    onLocal: () => chooseLocal(app?.cwd),
    onHost: (picked) => {
      setRemoteEnvironment(undefined);
      setCodeCloud(false);
      void selectHost(picked, setCwd, report);
    },
    onAdd: () => openSshDialog({ kind: "host", select: true }),
    onEdit: (host) => openSshDialog({ kind: "host", host }),
    onEditLocal: () => setEditingLocal(true),
    environments,
    onCloud: (id) => {
      setRemoteEnvironment(undefined);
      selectCloudEnvironment(id);
    },
    onCreateCloud: () => editCloudEnvironment(),
    onEditCloud: editCloudEnvironment,
  });
  const environmentEntries: MenuEntry[] = [
    // The desktop: back to this computer's folders.
    ...(host.capabilities.localCode
      ? [
          {
            label: "Local",
            onSelect: () => {
              setOpen(undefined);
              setCodeCloud(false);
            },
          },
          { separator: true as const },
        ]
      : []),
    ...environments.map((entry) => ({
      label: entry.name,
      noTranslate: true,
      icon: <CloudIcon />,
      description: networkLabels[entry.network],
      checked: entry.id === (environment?.id ?? entry.id),
      onSelect: () => {
        selectCloudEnvironment(entry.id);
        setOpen(undefined);
      },
      settings: {
        label: "Edit cloud environment",
        onSelect: () => editCloudEnvironment(entry),
      },
    })),
    { label: "Add cloud environment…", onSelect: () => editCloudEnvironment() },
    ...desktopEnvironmentEntries.filter(
      (entry) => "label" in entry && entry.label === "Remote Control",
    ),
  ];
  const menuEntries = host.capabilities.localCode
    ? desktopEnvironmentEntries
    : environmentEntries;
  const localRows = host.capabilities.localCode
    ? [
        ...new Set(
          (app?.listed ?? [])
            .filter(
              (conversation) =>
                conversation.mode === "code" &&
                conversation.cwd &&
                (!conversation.environment ||
                  conversation.environment.kind === "local"),
            )
            .map((conversation) => conversation.cwd!),
        ),
      ].map((cwd) => ({
        id: `folder:${cwd}`,
        name: folderName(cwd),
        detail: cwd,
        detailKind: "local-path" as const,
        onSelect: () => chooseLocal(cwd),
      }))
    : [];
  const sshRows = host.capabilities.localCode
    ? ssh.hosts.map((entry) => ({
        id: `ssh:${entry.id}`,
        name: entry.label,
        detail: hostAddress(entry),
        detailKind: "text" as const,
        onSelect: () => {
          setCodeCloud(false);
          void selectHost(entry, setCwd, report);
        },
      }))
    : [];
  // A cloud environment is a row only once a session used it or it was picked;
  // the web home is otherwise just Choose environment.
  const usedEnvironments = environmentUsage(app?.listed ?? []);
  const recentEnvironments = orderRecentEnvironments(
    [
      ...localRows,
      ...sshRows,
      ...environments
        .filter(
          (entry) =>
            usedEnvironments.has(`cloud:${entry.id}`) ||
            entry.id === cloud.pickedId,
        )
        .map((entry) => ({
          id: `cloud:${entry.id}`,
          name: entry.name,
          icon: <CloudIcon />,
          onSelect: () => selectCloudEnvironment(entry.id),
        })),
    ],
    app?.listed ?? [],
  );
  const expandedEntries = host.capabilities.localCode
    ? expandedEnvironmentMenu(
        menuEntries,
        localRows.map((row) => ({
          label: row.name,
          noTranslate: true,
          onSelect: row.onSelect,
        })),
      )
    : [{ heading: "Cloud" }, ...environmentEntries];
  const isOpen = (next: Open) => Boolean(open && same(next));
  const chip = (next: Open) => `workspace-chip ${isOpen(next) ? "open" : ""}`;
  const unavailable = status && !status.configured;
  const disconnected = Boolean(
    repositories.length && status && !status.connected,
  );
  const removable = repositories.length > 1;
  const full = repositories.length >= maxCodeRepositories;
  const openTarget =
    open && (open.menu === "repository" || open.menu === "branch")
      ? repositories.find((r) => r.fullName === open.target)
      : undefined;
  const addOpen: Open = { menu: "add", left: 0 };
  if (remoteChosen && app)
    return (
      <Suspense fallback={null}>
        <RemoteWorkspaceBar
          cwd={app.cwd}
          recentFolders={[]}
          setCwd={setCwd}
          pickFolder={async () => {}}
        />
      </Suspense>
    );
  const cloudWorkspaceBarViewView = cloudWorkspaceBarView({
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
  });
  return cloudWorkspaceBarViewView;
}
