import type {
  CatalogueConnector,
  ConnectorFilter,
  ConnectorType,
} from "../../../shared/connectors-catalogue";
import { connectorServer } from "../../../shared/connectors-catalogue";
import type { ConnectorOperation } from "../connector-owner";
import { handoffConnectorOperation } from "../connector-owner";
import { connectorAllowed } from "../../../shared/client-policy-rules";
import {
  reconnectQueueKey,
  readReconnectQueue,
  nextReconnect,
} from "../directory/connector-reconnect";
import { useEffect } from "react";
import { connectorsView } from "./ConnectorsView";
import type { MenuPosition } from "../../ui/Menu";
import type {
  McpServerState,
  ConnectorToolPermission,
  McpServers,
} from "../../../shared/settings-desktop-api";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { ConnectorSuggestion } from "../../../shared/connector-links";
import type {
  CustomizeConnectorPresentation,
  ConnectorStatusFilter,
} from "./Connectors";
import type { AppController } from "../../app/AppContext";
import type { TabId } from "../nav";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { Settings } from "../../../shared/types";

/** What useConnectorsActions needs from Connectors.tsx. */
export interface UseConnectorsActionsKit {
  addButton: React.RefObject<HTMLButtonElement | null>;
  addMenu: MenuPosition | undefined;
  adding: boolean;
  allListed: boolean;
  app: AppController | undefined;
  apply: (next: { servers: McpServerState[] }) => void;
  approvedEntries: ApprovedDirectoryEntry[];
  approvedFailed: boolean;
  approvedReady: boolean;
  approvedReload: React.RefObject<() => void>;
  busy: string | undefined;
  busyOperation: React.RefObject<ConnectorOperation | undefined>;
  configured: McpServerState[];
  confirmedSuggestion: ConnectorSuggestion | undefined;
  connect: (
    name: string,
    source?: ConnectorOperation | undefined,
    transferred?: ConnectorOperation | undefined,
  ) => Promise<void>;
  connectionOperation: (
    name: string,
    source?: ConnectorOperation | undefined,
  ) => ConnectorOperation | undefined;
  connectorDefaults: CatalogueConnector | undefined;
  currentSettings: React.RefObject<Record<string, unknown>>;
  customize: CustomizeConnectorPresentation | undefined;
  detail: string;
  detailEntry: CatalogueConnector | undefined;
  detailServer: McpServerState | undefined;
  directoryEntries: CatalogueConnector[];
  directoryFilter: {
    query: string;
    topic?: string | undefined;
    type:
      | "all"
      | "new"
      | "trending"
      | "inChatUi"
      | "desktopExtension"
      | ConnectorType;
  };
  directoryResults: CatalogueConnector[];
  directoryTargets: React.RefObject<CatalogueConnector[]>;
  editing: boolean;
  editingServer: McpServerState | undefined;
  goTo: (tab: TabId) => void;
  knownServers: React.RefObject<McpServerState[]>;
  linearConnected: boolean;
  linearOpen: boolean;
  listed: McpServerState[];
  loadFailed: boolean;
  local: boolean;
  manage: boolean;
  mcp: McpServers | undefined;
  onError: (error: unknown) => void;
  open: string | undefined;
  owner: {
    key: number;
    current: () => boolean;
    capture(channel?: string): ConnectorOperation;
  };
  policy: ClientPolicy;
  query: string;
  reconnecting: React.RefObject<boolean>;
  refusal:
    | "Custom connectors aren’t available for this account."
    | "MCP servers can be changed once Claudex reaches your service."
    | "Your administrator has turned off adding MCP servers."
    | undefined;
  removing: McpServerState | undefined;
  resetFilters: () => void;
  retry: () => undefined;
  save: (
    patch: Partial<Settings>,
    failure?: string | undefined,
    onFailure?: ((error: unknown) => void) | undefined,
  ) => void | Promise<boolean>;
  servers: McpServerState[];
  setAddMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setAdding: React.Dispatch<React.SetStateAction<boolean>>;
  setAllListed: React.Dispatch<React.SetStateAction<boolean>>;
  setBusy: React.Dispatch<React.SetStateAction<string | undefined>>;
  setConfirmedSuggestion: React.Dispatch<
    React.SetStateAction<ConnectorSuggestion | undefined>
  >;
  setConnectorDefaults: React.Dispatch<
    React.SetStateAction<CatalogueConnector | undefined>
  >;
  setDetail: React.Dispatch<React.SetStateAction<string>>;
  setEditingServer: React.Dispatch<
    React.SetStateAction<McpServerState | undefined>
  >;
  setFilter: React.Dispatch<
    React.SetStateAction<Omit<ConnectorFilter, "query">>
  >;
  setLinearConnected: React.Dispatch<React.SetStateAction<boolean>>;
  setLinearOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOpen: React.Dispatch<React.SetStateAction<string | undefined>>;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  setRemoving: React.Dispatch<React.SetStateAction<McpServerState | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<ConnectorStatusFilter>>;
  setSuggestion: React.Dispatch<
    React.SetStateAction<ConnectorSuggestion | undefined>
  >;
  setTool: (
    name: string,
    tool: string,
    permission: ConnectorToolPermission,
  ) => Promise<void>;
  setView: React.Dispatch<React.SetStateAction<"yours" | "discover">>;
  settings: Settings;
  status: ConnectorStatusFilter;
  suggestion: ConnectorSuggestion | undefined;
  view: "yours" | "discover";
  words: string;
}

export function useConnectorsActions(kit: UseConnectorsActionsKit) {
  const {
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
  } = kit;
  const connectEntry = async (
    entry?: CatalogueConnector,
    server = entry ? connectorServer(entry, listed) : undefined,
    source?: ConnectorOperation,
  ) => {
    if (!owner.current() || (source && !source.current())) return;
    const initialTarget =
      server &&
      (currentSettings.current[server.name] as
        { command?: unknown; url?: unknown } | undefined);
    const operation = handoffConnectorOperation(
      owner,
      source,
      () => {
        if (server) {
          const current = currentSettings.current[server.name] as
            { command?: unknown; url?: unknown } | undefined;
          if (initialTarget)
            return (
              current?.command === initialTarget.command &&
              current?.url === initialTarget.url
            );
          return knownServers.current.some(
            (item) =>
              item.name === server.name &&
              item.url === server.url &&
              item.command === server.command,
          );
        }
        return (
          !entry ||
          directoryTargets.current.some(
            (item) => item.id === entry.id && item.url === entry.url,
          )
        );
      },
      "connect-entry",
    );
    if (!operation) return;
    if (
      !editing ||
      (entry &&
        !connectorAllowed(
          policy,
          server?.name ?? entry.id,
          server ? settings.mcpServers[server.name] : { url: entry.url },
        ))
    )
      return;
    if (server && !server.url) {
      const config = settings.mcpServers[server.name] as Record<
        string,
        unknown
      >;
      try {
        await save({
          mcpServers: {
            ...settings.mcpServers,
            [server.name]: { ...config, enabled: true },
          },
        });
        if (operation.current()) retry();
      } catch (error) {
        if (operation.current()) throw error;
      }
    } else if (server && server.authStatus !== "bearerToken")
      await connect(server.name, source);
    else if (entry?.id === "linear") setLinearOpen(true);
    else if (
      !server &&
      entry?.url &&
      (!entry.serverUrlType || entry.serverUrlType === "universal")
    ) {
      busyOperation.current = operation;
      setBusy(entry.id);
      try {
        const name = entry.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        const next = await operation.bridge.addCustomConnector({
          name,
          url: entry.url,
        });
        if (!operation.current()) return;
        if (!entry.isAuthless)
          sessionStorage.setItem(
            reconnectQueueKey,
            JSON.stringify({
              account: app?.accountId ?? "",
              startedAt: Date.now(),
              connectors: [{ name, url: entry.url }],
            }),
          );
        apply(next);
      } catch (error) {
        if (operation.current()) throw error;
      } finally {
        if (owner.current() && busyOperation.current === operation) {
          busyOperation.current = undefined;
          setBusy(undefined);
        }
      }
    } else {
      setConnectorDefaults(
        server
          ? ({
              ...entry,
              id: server.name,
              name: server.name,
              url: server.url,
            } as CatalogueConnector)
          : entry,
      );
      setAdding(true);
    }
  };
  const directoryActions = {
    onOpen: (entry: CatalogueConnector) =>
      customize ? customize.onOpen(entry.id) : setDetail(entry.id),
    onConnect: (entry: CatalogueConnector) => {
      void connectEntry(entry).catch(onError);
    },
    servers: listed,
    busy,
    canConnect: (entry: CatalogueConnector) => {
      const server = connectorServer(entry, listed);
      return (
        editing &&
        connectorAllowed(
          policy,
          server?.name ?? entry.id,
          server ? settings.mcpServers[server.name] : { url: entry.url },
        )
      );
    },
  };
  const expired = listed.filter(
    (server) =>
      server.state !== "disabled" && server.authStatus === "notLoggedIn",
  );
  useEffect(() => {
    if (!owner.current() || !mcp || busy || reconnecting.current || !editing)
      return;
    let queue;
    try {
      queue = readReconnectQueue(
        sessionStorage.getItem(reconnectQueueKey),
        app?.accountId ?? "",
      );
    } catch {
      return;
    }
    if (!queue) return;
    const next = nextReconnect(queue, listed);
    if (next.waiting) return;
    const server = next.connectors.find((entry) =>
      connectorAllowed(
        policy,
        entry.name,
        settings.mcpServers[entry.name] ?? { url: entry.url },
      ),
    );
    if (!server) {
      sessionStorage.removeItem(reconnectQueueKey);
      return;
    }
    const actual = listed.find((item) => item.name === server.name);
    if (
      !actual ||
      actual.state === "starting" ||
      actual.state === "stopped" ||
      actual.authStatus !== "notLoggedIn"
    )
      return;
    reconnecting.current = true;
    sessionStorage.setItem(
      reconnectQueueKey,
      JSON.stringify({ ...next, waiting: server.name }),
    );
    void connect(server.name).finally(() => {
      if (owner.current()) reconnecting.current = false;
    });
  }, [mcp, busy, editing, app?.accountId]);
  const reconnectAll = () => {
    if (!owner.current()) return;
    try {
      sessionStorage.setItem(
        reconnectQueueKey,
        JSON.stringify({
          account: app?.accountId ?? "",
          startedAt: Date.now(),
          connectors: expired
            .filter(
              (server) =>
                server.url &&
                connectorAllowed(
                  policy,
                  server.name,
                  settings.mcpServers[server.name],
                ),
            )
            .map((server) => ({ name: server.name, url: server.url! })),
        }),
      );
      retry();
    } catch (error) {
      onError(error);
    }
  };
  const closeDetail = () => {
    if (customize) {
      customize.onBack();
      return;
    }
    setDetail("");
    const link = new URL(window.location.href);
    link.searchParams.delete("connector");
    window.history.replaceState(null, "", link.href);
  };
  // "N connector tools always allowed · Forget": the choices made on approval cards.
  const alwaysAllowed = listed.reduce(
    (sum, server) => sum + (server.alwaysAllowed ?? 0),
    0,
  );
  const forget = async () => {
    if (!owner.current()) return;
    const operation = owner.capture("forget-approvals");
    try {
      const result = await operation.bridge.forgetConnectorApprovals();
      if (operation.current()) apply(result);
    } catch (error) {
      if (operation.current()) onError(error);
    }
  };
  const directoryLoading = !approvedReady || (!mcp && !loadFailed);
  const directoryFailed = approvedFailed || loadFailed;
  const retryDirectory = () => {
    retry();
    approvedReload.current();
  };
  const connectorsViewView = connectorsView({
    addButton,
    addMenu,
    adding,
    allListed,
    alwaysAllowed,
    apply,
    approvedEntries,
    busy,
    closeDetail,
    configured,
    confirmedSuggestion,
    connect,
    connectEntry,
    connectionOperation,
    connectorDefaults,
    customize,
    detail,
    detailEntry,
    detailServer,
    directoryActions,
    directoryEntries,
    directoryFailed,
    directoryFilter,
    directoryLoading,
    directoryResults,
    editing,
    editingServer,
    forget,
    goTo,
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
    reconnectAll,
    refusal,
    removing,
    resetFilters,
    retry,
    retryDirectory,
    servers,
    setAddMenu,
    setAdding,
    setAllListed,
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
  return { connectorsViewView } as const;
}
