import { Fragment, Suspense } from "react";
import {
  ConnectLinearDialog,
  ConnectorAttention,
  GitHubConnectionDetail,
  ConnectorDetail,
  ConnectorPlugins,
  AddConnectorDialog,
} from "./Connectors";
import { ArrowLeft } from "../../ui/glyphs";
import { Button } from "../controls";
import {
  connectorReview,
  relatedConnectors,
} from "../directory/connector-detail-model";
import "./connector-detail.css";
import {
  ConnectorCards,
  NothingMatches,
  ConnectorDiscover,
} from "./ConnectorDirectory";
import type {
  ConnectorStatusFilter,
  CustomizeConnectorPresentation,
} from "./Connectors";
import { currentLocale, formatText } from "../../i18n";
import { createPortal } from "react-dom";
import { ConfirmationDialog } from "../../dialogs/ConfirmationDialog";
import type { MenuPosition } from "../../ui/Menu";
import type {
  McpServerState,
  ConnectorToolPermission,
  McpServers,
} from "../../../shared/settings-desktop-api";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { ConnectorSuggestion } from "../../../shared/connector-links";
import type { ConnectorOperation } from "../connector-owner";
import type {
  CatalogueConnector,
  ConnectorFilter,
  ConnectorType,
} from "../../../shared/connectors-catalogue";
import type { TabId } from "../nav";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { Settings } from "../../../shared/types";
import { ConnectorsHeader } from "./ConnectorsHeader";
import { ConnectorsDialogs } from "./ConnectorsDialogs";
import { AddConnectorMenu } from "./AddConnectorMenu";

/** What connectorsView needs from Connectors.tsx. */
export interface ConnectorsViewKit {
  addButton: React.RefObject<HTMLButtonElement | null>;
  addMenu: MenuPosition | undefined;
  adding: boolean;
  allListed: boolean;
  alwaysAllowed: number;
  apply: (next: { servers: McpServerState[] }) => void;
  approvedEntries: ApprovedDirectoryEntry[];
  busy: string | undefined;
  closeDetail: () => void;
  configured: McpServerState[];
  confirmedSuggestion: ConnectorSuggestion | undefined;
  connect: (
    name: string,
    source?: ConnectorOperation | undefined,
    transferred?: ConnectorOperation | undefined,
  ) => Promise<void>;
  connectEntry: (
    entry?: CatalogueConnector | undefined,
    server?: McpServerState | undefined,
    source?: ConnectorOperation | undefined,
  ) => Promise<void>;
  connectionOperation: (
    name: string,
    source?: ConnectorOperation | undefined,
  ) => ConnectorOperation | undefined;
  connectorDefaults: CatalogueConnector | undefined;
  customize: CustomizeConnectorPresentation | undefined;
  detail: string;
  detailEntry: CatalogueConnector | undefined;
  detailServer: McpServerState | undefined;
  directoryActions: {
    onOpen: (entry: CatalogueConnector) => void;
    onConnect: (entry: CatalogueConnector) => void;
    servers: McpServerState[];
    busy: string | undefined;
    canConnect: (entry: CatalogueConnector) => boolean;
  };
  directoryEntries: CatalogueConnector[];
  directoryFailed: boolean;
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
  directoryLoading: boolean;
  directoryResults: CatalogueConnector[];
  editing: boolean;
  editingServer: McpServerState | undefined;
  forget: () => Promise<void>;
  goTo: (tab: TabId) => void;
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
  reconnectAll: () => void;
  refusal:
    | "Custom connectors aren’t available for this account."
    | "MCP servers can be changed once Claudex reaches your service."
    | "Your administrator has turned off adding MCP servers."
    | undefined;
  removing: McpServerState | undefined;
  resetFilters: () => void;
  retry: () => undefined;
  retryDirectory: () => void;
  servers: McpServerState[];
  setAddMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setAdding: React.Dispatch<React.SetStateAction<boolean>>;
  setAllListed: React.Dispatch<React.SetStateAction<boolean>>;
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

export function connectorsView(kit: ConnectorsViewKit) {
  const {
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
  } = kit;
  const connectorsViewView = (
    <div
      className={
        customize
          ? "connector-customize-host"
          : "settings-list-page desktop-list"
      }
    >
      {linearOpen && (
        <Suspense fallback={null}>
          <ConnectLinearDialog
            onClose={() => setLinearOpen(false)}
            onConnected={() => setLinearConnected(true)}
          />
        </Suspense>
      )}
      {/* R-1374/R-1376: the search field and Add ⌄, whose menu holds
          Add custom connector (and Claudex's Edit config). */}
      {!customize && !detail && allListed && view === "discover" && (
        <button
          type="button"
          className="connectors-back"
          onClick={() => setAllListed(false)}
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          Connectors
        </button>
      )}
      {detail === "integration-github" ? (
        <Suspense fallback={null}>
          <GitHubConnectionDetail onBack={closeDetail} />
        </Suspense>
      ) : customize && detail && (directoryLoading || directoryFailed) ? (
        <div role="status">
          {directoryLoading ? "Loading connectors" : "Couldn’t load connectors"}
          {directoryFailed && (
            <Button onClick={retryDirectory}>Try again</Button>
          )}
          <Button onClick={closeDetail}>Connectors</Button>
        </div>
      ) : customize && !detail ? (
        <>
          {/* The same banner as Settings' list, above the Customize one. */}
          <Suspense fallback={null}>
            <ConnectorAttention
              servers={listed}
              editable={editing}
              busy={busy !== undefined}
              onReconnect={reconnectAll}
              onView={(server) => {
                const entry = directoryEntries.find(
                  (item) => item.id === `installed:${server.name}`,
                );
                if (entry) directoryActions.onOpen(entry);
                else setDetail(`installed:${server.name}`);
              }}
            />
          </Suspense>
          {customize.renderBrowse({
            entries: directoryEntries,
            loading: directoryLoading,
            failed: directoryFailed,
            retry: retryDirectory,
            ...directoryActions,
          })}
        </>
      ) : detail && (detailEntry || detailServer) ? (
        <Suspense fallback={null}>
          <ConnectorDetail
            key={detailEntry?.id ?? `installed:${detailServer!.name}`}
            presentation={customize ? "customize" : "settings"}
            onOpenCategory={customize?.onOpenCategory}
            related={
              detailEntry
                ? relatedConnectors(detailEntry, directoryEntries)
                : []
            }
            onOpenRelated={directoryActions.onOpen}
            onConnectRelated={directoryActions.onConnect}
            relatedServers={listed}
            canConnectRelated={directoryActions.canConnect}
            remoteIcons={!settings.disableNonessentialServices}
            entry={detailEntry}
            server={detailServer}
            editable={
              customize && detailEntry
                ? !!mcp &&
                  !loadFailed &&
                  directoryActions.canConnect(detailEntry)
                : editing
            }
            onEdit={() => {
              setConnectorDefaults(undefined);
              setEditingServer(detailServer);
              setAdding(true);
            }}
            onBack={closeDetail}
            onDisconnect={
              detailServer && editing
                ? () => setRemoving(detailServer)
                : undefined
            }
            onError={onError}
            onSet={(tool, permission) =>
              detailServer && void setTool(detailServer.name, tool, permission)
            }
            onConnect={(operation) =>
              connectEntry(detailEntry, detailServer, operation)
            }
          />
        </Suspense>
      ) : customize && detail ? (
        <div role="status">
          Connector not found
          <Button onClick={closeDetail}>Connectors</Button>
        </div>
      ) : (
        <>
          <ConnectorsHeader
            addButton={addButton}
            addMenu={addMenu}
            allListed={allListed}
            directoryEntries={directoryEntries}
            directoryFilter={directoryFilter}
            query={query}
            setAddMenu={setAddMenu}
            setAllListed={setAllListed}
            setFilter={setFilter}
            setQuery={setQuery}
            setView={setView}
            view={view}
          />
          {addMenu && (
            <AddConnectorMenu
              addButton={addButton}
              addMenu={addMenu}
              editing={editing}
              linearConnected={linearConnected}
              local={local}
              onError={onError}
              owner={owner}
              policy={policy}
              refusal={refusal}
              setAddMenu={setAddMenu}
              setAdding={setAdding}
              setAllListed={setAllListed}
              setConfirmedSuggestion={setConfirmedSuggestion}
              setConnectorDefaults={setConnectorDefaults}
              setLinearOpen={setLinearOpen}
              setView={setView}
            />
          )}
          {view === "discover" &&
            (allListed ? (
              directoryResults.length ? (
                <ConnectorCards
                  entries={directoryResults}
                  {...directoryActions}
                />
              ) : (
                <NothingMatches onReset={resetFilters} />
              )
            ) : (
              <ConnectorDiscover
                filter={directoryFilter}
                entries={directoryEntries}
                {...directoryActions}
                onBrowse={({ query: _query, ...next }) => {
                  setFilter(next);
                  setAllListed(true);
                }}
                onShowAll={() => setAllListed(true)}
                onReset={resetFilters}
                plugins={
                  approvedEntries.some(
                    (entry) =>
                      entry.kind === "plugin" && entry.curation?.popular,
                  ) && (
                    <Suspense fallback={null}>
                      <ConnectorPlugins
                        entries={approvedEntries}
                        onShowAll={() => goTo("plugins")}
                        onError={onError}
                      />
                    </Suspense>
                  )
                }
              />
            ))}
          {view === "yours" && (
            <ConnectorsDialogs
              alwaysAllowed={alwaysAllowed}
              busy={busy}
              connect={connect}
              directoryEntries={directoryEntries}
              directoryFilter={directoryFilter}
              editing={editing}
              forget={forget}
              linearConnected={linearConnected}
              listed={listed}
              loadFailed={loadFailed}
              local={local}
              manage={manage}
              mcp={mcp}
              open={open}
              policy={policy}
              reconnectAll={reconnectAll}
              refusal={refusal}
              resetFilters={resetFilters}
              retry={retry}
              servers={servers}
              setDetail={setDetail}
              setOpen={setOpen}
              setRemoving={setRemoving}
              setStatus={setStatus}
              setTool={setTool}
              setView={setView}
              settings={settings}
              status={status}
              words={words}
            />
          )}
        </>
      )}
      {adding && (
        <Suspense fallback={null}>
          <AddConnectorDialog
            key={confirmedSuggestion?.url ?? connectorDefaults?.id ?? "custom"}
            defaults={connectorDefaults}
            suggested={confirmedSuggestion}
            editingServer={editingServer}
            existingNames={configured
              .filter((server) => server.name !== editingServer?.name)
              .map((server) => server.displayName ?? server.name)}
            existingIds={configured.map((server) => server.name)}
            onClose={() => {
              setAdding(false);
              setEditingServer(undefined);
              setConfirmedSuggestion(undefined);
            }}
            onAdded={(next, connectName, source) => {
              if (!source?.current() || !owner.current()) return;
              apply(next);
              const operation = connectName
                ? connectionOperation(connectName, source)
                : undefined;
              if (connectName && !operation?.current()) return;
              setAdding(false);
              setEditingServer(undefined);
              setConfirmedSuggestion(undefined);
              if (connectName && operation)
                void connect(connectName, undefined, operation);
            }}
          />
        </Suspense>
      )}
      {suggestion &&
        createPortal(
          <ConfirmationDialog
            confirmation={{
              title: formatText("Connect {serverName}?", {
                serverName: suggestion.name || suggestion.url,
              }),
              body: "An external link suggested this connector. Check the name and URL before you connect.",
              confirm: "Connect",
              danger: false,
              action: async () => {
                if (!editing) throw Error(refusal);
                setConnectorDefaults(undefined);
                setConfirmedSuggestion(suggestion);
                setAdding(true);
              },
            }}
            onClose={() => {
              setSuggestion(undefined);
              const url = new URL(window.location.href);
              url.searchParams.delete("connectorName");
              url.searchParams.delete("connectorUrl");
              if (url.searchParams.get("connector")?.startsWith("suggested:"))
                url.searchParams.delete("connector");
              window.history.replaceState(null, "", url.href);
            }}
            onError={onError}
          >
            <SuggestionFacts
              suggestion={suggestion}
              entry={directoryEntries.find(
                (entry) => entry.url === suggestion.url,
              )}
            />
          </ConfirmationDialog>,
          document.body,
        )}
      {removing &&
        createPortal(
          <ConfirmationDialog
            confirmation={{
              title: `Disconnect ${removing.name}?`,
              body: "Claudex stops the connector and removes it from your configuration. You can add it again later.",
              confirm: "Disconnect",
              action: async () => {
                if (!owner.current()) return;
                const operation = owner.capture("disconnect");
                if (linearConnected && removing.name === "Linear") {
                  await operation.bridge.linearDisconnect();
                  if (operation.current()) setLinearConnected(false);
                } else {
                  const result = await operation.bridge.removeConnector(
                    removing.name,
                  );
                  if (operation.current()) apply(result);
                }
              },
            }}
            onClose={() => setRemoving(undefined)}
            onError={onError}
          />,
          document.body,
        )}
    </div>
  );
  return connectorsViewView;
}

/**
 * What the person is told before connecting what a link suggested: who made it,
 * its address, whether it signs in, how it was reviewed and when it was added
 * to the directory, as far as the directory knows it.
 */
export function SuggestionFacts({
  suggestion,
  entry,
}: {
  suggestion: ConnectorSuggestion;
  entry?: CatalogueConnector;
}) {
  const rows: [string, string][] = [
    ...(entry?.byline
      ? [["Made by", entry.byline.replace(/^by /, "")] as [string, string]]
      : []),
    ["Connector URL", suggestion.url],
    ...(entry?.isAuthless !== undefined
      ? [
          ["Sign-in", entry.isAuthless ? "Not required" : "Required"] as [
            string,
            string,
          ],
        ]
      : []),
    ["Review status", connectorReview(entry)],
    ...(entry?.added && Number.isFinite(Date.parse(entry.added))
      ? [
          [
            "Added to directory",
            new Date(entry.added).toLocaleDateString(currentLocale()),
          ] as [string, string],
        ]
      : []),
  ];
  return (
    <dl className="connector-detail-metadata">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd
            className={
              label === "Connector URL" ? "connector-detail-url" : undefined
            }
          >
            {value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
