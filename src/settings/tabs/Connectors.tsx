import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import { AppContext } from "../../app/AppContext";
import { reconnectQueueKey } from "../directory/connector-reconnect";
import {
  settingsNavigationEvent,
  takeSettingsConnectorTarget,
  readSettingsConnectorTarget,
  readConnectorsEntry,
  takeConnectorsEntry,
} from "../navigation";
import { linearMcpUrl } from "../../../shared/linear-api";
import {
  connectorSuggestion,
  type ConnectorSuggestion,
} from "../../../shared/connector-links";
import {
  useConnectorOwner,
  handoffConnectorOperation,
  readConnectorServers,
  useConnectorServerList,
  type ConnectorOperation,
} from "../connector-owner";
import { connectCustomConnector } from "./connector-login";
import { type MenuPosition } from "../../ui/Menu";
import type { TabProps } from "../context";
import { usePolicy } from "../../policy/PolicyContext";
import { mcpEditingRefusal } from "../../../shared/client-policy";
import type {
  ConnectorToolPermission,
  McpServerState,
} from "../../../shared/settings-desktop-api";
import { mcpRefreshMs, serviceMcpRefreshMs } from "./Developer";
import { connectorFilterActive } from "./ConnectorDirectory";
import {
  defaultConnectorFilter,
  findConnectors,
  directoryConnectors,
  isApprovedDirectoryEntries,
  connectorServer,
  type CatalogueConnector,
  type ConnectorFilter,
} from "../../../shared/connectors-catalogue";
import { useHostCapability } from "../../host/HostContext";
import "../desktop.css";
import "../directory/directory.css";
import "../developer.css";
import { useConnectorsActions } from "./useConnectorsActions";

export const ConnectLinearDialog = lazyPiece(
  () => import("../../linear/ConnectLinearDialog"),
);
export const GitHubConnectionDetail = lazyPiece(
  () => import("./GitHubConnectionDetail"),
  "GitHubConnectionDetail",
);
export const ConnectorDetail = lazyPiece(() => import("./ConnectorDetail"));
export const ConnectorPlugins = lazyPiece(
  () => import("../directory/ConnectorPlugins"),
);
export const ConnectorAttention = lazyPiece(
  () => import("../directory/ConnectorAttention"),
);
export const AddConnectorDialog = lazyPiece(
  () => import("./AddConnectorDialog"),
);

/** Rows Settings search finds on this page. */
export { connectorsLabels as searchLabels } from "./desktop-labels";

/** Over the list where connectors come from the service (the web app). */
export const serviceNote =
  "Your Claudex service provides these connectors. Connectors added in the desktop app stay on that computer.";

export type ConnectorStatusFilter = "all" | "connected" | "notConnected";

/** Whether a connector is working and signed in: the original's Connected. */
export function connectorConnected(server: McpServerState) {
  return server.state === "ready" && server.authStatus !== "notLoggedIn";
}

/**
 * Connectors and the Add menu. Custom connectors use the desktop configuration
 * or the web runner; local programs remain available through Edit config.
 */
export interface ConnectorBrowseModel {
  entries: CatalogueConnector[];
  servers: McpServerState[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
  busy?: string;
  onOpen: (entry: CatalogueConnector) => void;
  onConnect: (entry: CatalogueConnector) => void;
  canConnect: (entry: CatalogueConnector) => boolean;
}
export interface CustomizeConnectorPresentation {
  view: "yours" | "discover";
  detailId?: string;
  query?: string;
  onOpen: (id: string) => void;
  onBack: () => void;
  onOpenCategory?: (category?: string) => void;
  renderBrowse: (model: ConnectorBrowseModel) => ReactNode;
}
type ConnectorsTabProps = Pick<
  TabProps,
  "settings" | "onError" | "goTo" | "save"
> & { customize?: CustomizeConnectorPresentation };
export function ConnectorsTab(props: ConnectorsTabProps) {
  const owner = useConnectorOwner("connectors-parent");
  return <OwnedConnectorsTab key={owner.key} {...props} owner={owner} />;
}
function OwnedConnectorsTab({
  settings,
  onError: reportError,
  goTo,
  save,
  customize,
  owner,
}: ConnectorsTabProps & { owner: ReturnType<typeof useConnectorOwner> }) {
  const onError = (error: unknown) => {
    if (owner.current()) reportError(error);
  };
  const app = useContext(AppContext);
  const reconnecting = useRef(false);
  const [linearOpen, setLinearOpen] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);
  useEffect(() => {
    let live = true;
    const operation = owner.capture("linear-status");
    void operation.bridge
      .linearStatus()
      .then((state) => {
        if (live && operation.current()) setLinearConnected(state.connected);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [owner.key]);
  const policy = usePolicy();
  const local = useHostCapability("localMcp");
  const {
    value: mcp,
    failed: loadFailed,
    retry,
  } = useConnectorServerList(
    owner,
    onError,
    local ? mcpRefreshMs : serviceMcpRefreshMs,
  );
  // Adding, removing and switching tools: on this computer's configuration
  // file, or on the web's runner (remote https servers with a token).
  const manage = local || useHostCapability("customConnectors");
  // Opened from the add menu's Add connector rows (settings/navigation.ts).
  const [adding, setAdding] = useState(() => readConnectorsEntry() === "add");
  const [suggestion, setSuggestion] = useState<ConnectorSuggestion | undefined>(
    () =>
      typeof window === "undefined"
        ? undefined
        : connectorSuggestion(window.location.href),
  );
  const [confirmedSuggestion, setConfirmedSuggestion] =
    useState<ConnectorSuggestion>();
  const [localDetail, setDetail] = useState(() =>
    customize || typeof window === "undefined"
      ? ""
      : (readSettingsConnectorTarget() ??
        new URLSearchParams(window.location.search).get("connector") ??
        ""),
  );
  const detail = customize ? (customize.detailId ?? "") : localDetail;
  const isCustomize = Boolean(customize);
  useEffect(() => {
    if (isCustomize) return;
    takeConnectorsEntry();
    const initialTarget = takeSettingsConnectorTarget();
    if (initialTarget) setDetail(initialTarget);
    const sync = () => {
      setSuggestion(connectorSuggestion(window.location.href));
      setDetail(
        takeSettingsConnectorTarget() ??
          new URLSearchParams(window.location.search).get("connector") ??
          "",
      );
    };
    window.addEventListener(settingsNavigationEvent, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(settingsNavigationEvent, sync);
      window.removeEventListener("popstate", sync);
    };
  }, [isCustomize]);
  const [approvedEntries, setApprovedEntries] = useState<
    ApprovedDirectoryEntry[]
  >([]);
  const [approvedReady, setApprovedReady] = useState(false);
  const [approvedFailed, setApprovedFailed] = useState(false);
  const approvedReload = useRef<() => void>(() => {});
  const approvedCatalogue = directoryConnectors(approvedEntries);
  const [connectorDefaults, setConnectorDefaults] =
    useState<CatalogueConnector>();
  const [editingServer, setEditingServer] = useState<McpServerState>();
  useEffect(() => {
    let active = true;
    let latestRead = 0;
    const load = () => {
      const read = ++latestRead;
      setApprovedReady(false);
      setApprovedFailed(false);
      if (!owner.current()) return;
      const operation = owner.capture("directory-read");
      void operation.bridge
        .listApprovedDirectory()
        .then((entries) => {
          if (!isApprovedDirectoryEntries(entries))
            throw new Error("Invalid directory response");
          if (active && operation.current() && read === latestRead) {
            setApprovedEntries(entries);
            setApprovedFailed(false);
          }
        })
        .catch(() => {
          if (active && operation.current() && read === latestRead)
            setApprovedFailed(true);
        })
        .finally(() => {
          if (active && operation.current() && read === latestRead)
            setApprovedReady(true);
        });
    };
    approvedReload.current = load;
    load();
    return () => {
      active = false;
    };
  }, []);
  const [open, setOpen] = useState<string>();
  const [removing, setRemoving] = useState<McpServerState>();
  const [busyValue, setBusy] = useState<string>();
  const busyOperation = useRef<ConnectorOperation | undefined>(undefined);
  const busy =
    busyOperation.current && !busyOperation.current.current()
      ? undefined
      : busyValue;
  const [changed, setChanged] = useState<McpServerState[]>();
  const [localQuery, setQuery] = useState("");
  const query = customize?.query ?? localQuery;
  const [status, setStatus] = useState<ConnectorStatusFilter>("all");
  // Yours | Discover and the directory's All connectors page.
  const [localView, setView] = useState<"yours" | "discover">(() =>
    readConnectorsEntry() === "discover" ? "discover" : "yours",
  );
  const view = customize?.view ?? localView;
  const [allListed, setAllListed] = useState(false);
  const [filter, setFilter] = useState<Omit<ConnectorFilter, "query">>(
    defaultConnectorFilter,
  );
  const directoryFilter = { ...filter, query };
  const resetFilters = () => {
    setFilter(defaultConnectorFilter);
    setQuery("");
  };
  const [addMenu, setAddMenu] = useState<MenuPosition>();
  const addButton = useRef<HTMLButtonElement>(null);
  const words = query.trim().toLowerCase();
  const configured = changed ?? mcp?.servers ?? [];
  const knownServers = useRef(configured);
  knownServers.current = configured;
  const currentSettings = useRef(settings.mcpServers);
  currentSettings.current = settings.mcpServers;
  const changeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(changeTimer.current), []);
  const connectionOperation = (name: string, source?: ConnectorOperation) => {
    const initialSettings = currentSettings.current;
    const target = knownServers.current.find(
      (server) => server.name === name,
    )?.url;
    if (!target) return;
    return handoffConnectorOperation(owner, source, () => {
      const current = currentSettings.current;
      if (Object.hasOwn(current, name))
        return (current[name] as { url?: unknown } | undefined)?.url === target;
      return (
        current === initialSettings &&
        knownServers.current.some(
          (server) => server.name === name && server.url === target,
        )
      );
    });
  };
  const listed: McpServerState[] = linearConnected
    ? [
        {
          name: "Linear",
          state: "ready",
          tools: 0,
          url: linearMcpUrl,
          authStatus: "bearerToken",
        },
        ...configured.filter((server) => server.name !== "Linear"),
      ]
    : configured;
  const directoryEntries: CatalogueConnector[] = [
    ...approvedCatalogue,
    ...listed
      .filter(
        (server) =>
          !approvedCatalogue.some((entry) => connectorServer(entry, [server])),
      )
      .map((server) => ({
        id: `installed:${server.name}`,
        name: server.name,
        description: server.command ?? server.url ?? "",
        byline: "",
        type: "custom" as const,
        topic: "",
        icon: "server" as const,
        url: server.url,
        desktopExtension: server.desktopExtension,
        installed: true,
      })),
  ];
  const directoryTargets = useRef(directoryEntries);
  directoryTargets.current = directoryEntries;
  const servers = listed.filter(
    (server) =>
      (!words ||
        (server.displayName ?? server.name).toLowerCase().includes(words)) &&
      (!connectorFilterActive(directoryFilter) ||
        directoryEntries.some(
          (entry) =>
            connectorServer(entry, [server]) &&
            findConnectors(directoryFilter, [entry]).length > 0,
        )) &&
      (status === "all" ||
        connectorConnected(server) === (status === "connected")),
  );
  const editing = manage && policy.localMcpEditing;
  const refusal = !manage
    ? "Custom connectors aren’t available for this account."
    : !editing
      ? mcpEditingRefusal(policy)
      : undefined;
  // A change answers with the new list; the page's refresh replaces it.
  const apply = (next: { servers: McpServerState[] }) => {
    if (!owner.current()) return;
    readConnectorServers(next);
    knownServers.current = next.servers;
    setChanged(next.servers);
    clearTimeout(changeTimer.current);
    changeTimer.current = setTimeout(() => {
      if (owner.current()) setChanged(undefined);
    }, 3000);
  };
  const connect = async (
    name: string,
    source?: ConnectorOperation,
    transferred?: ConnectorOperation,
  ) => {
    const operation = transferred ?? connectionOperation(name, source);
    if (!operation?.current()) return;
    busyOperation.current = operation;
    setBusy(name);
    try {
      await connectCustomConnector(name, local, operation);
    } catch (error) {
      if (!operation.current()) return;
      sessionStorage.removeItem(reconnectQueueKey);
      onError(error);
    } finally {
      if (owner.current() && busyOperation.current === operation) {
        busyOperation.current = undefined;
        setBusy(undefined);
      }
    }
  };
  const setTool = async (
    name: string,
    tool: string,
    permission: ConnectorToolPermission,
  ) => {
    if (!owner.current()) return;
    const operation = owner.capture("tool-permission");
    try {
      const result = await operation.bridge.setConnectorToolPermission(
        name,
        tool,
        permission,
      );
      if (operation.current()) apply(result);
    } catch (error) {
      if (operation.current()) onError(error);
    }
  };
  const matchesDetail = (entry: CatalogueConnector) =>
    entry.id === detail ||
    entry.directoryId === detail ||
    `installed:${entry.name}`.toLowerCase() === detail.toLowerCase() ||
    (entry.url !== undefined &&
      listed.some(
        (server) =>
          `installed:${server.name}` === detail && server.url === entry.url,
      ));
  const detailEntry = directoryEntries.find(matchesDetail);
  const directoryResults = findConnectors(directoryFilter, directoryEntries);
  const detailServer = detail.startsWith("installed:")
    ? listed.find((server) => server.name === detail.slice(10))
    : detailEntry
      ? connectorServer(detailEntry, listed)
      : undefined;
  const { connectorsViewView } = useConnectorsActions({
    addButton,
    addMenu,
    adding,
    allListed,
    app,
    apply,
    approvedEntries,
    approvedFailed,
    approvedReady,
    approvedReload,
    busy,
    busyOperation,
    configured,
    confirmedSuggestion,
    connect,
    connectionOperation,
    connectorDefaults,
    currentSettings,
    customize,
    detail,
    detailEntry,
    detailServer,
    directoryEntries,
    directoryFilter,
    directoryResults,
    directoryTargets,
    editing,
    editingServer,
    goTo,
    knownServers,
    linearConnected,
    linearOpen,
    listed,
    loadFailed,
    local,
    manage,
    mcp,
    onError,
    open,
    owner,
    policy,
    query,
    reconnecting,
    refusal,
    removing,
    resetFilters,
    retry,
    save,
    servers,
    setAddMenu,
    setAdding,
    setAllListed,
    setBusy,
    setConfirmedSuggestion,
    setConnectorDefaults,
    setDetail,
    setEditingServer,
    setFilter,
    setLinearConnected,
    setLinearOpen,
    setOpen,
    setQuery,
    setRemoving,
    setStatus,
    setSuggestion,
    setTool,
    setView,
    settings,
    status,
    suggestion,
    view,
    words,
  });
  return connectorsViewView;
}
