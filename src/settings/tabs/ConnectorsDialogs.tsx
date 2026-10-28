import { Suspense } from "react";
import { ConnectorAttention, serviceNote } from "./Connectors";
import { Button, Segmented } from "../controls";
import type { ConnectorStatusFilter } from "./Connectors";
import { NothingMatches, connectorFilterActive } from "./ConnectorDirectory";
import { DesktopConnectorsTable } from "./DesktopConnectorsTable";
import type { ConnectorOperation } from "../connector-owner";
import type {
  CatalogueConnector,
  ConnectorType,
} from "../../../shared/connectors-catalogue";
import type {
  McpServerState,
  McpServers,
  ConnectorToolPermission,
} from "../../../shared/settings-desktop-api";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { Settings } from "../../../shared/types";

/** What ConnectorsDialogs needs from ConnectorsView.tsx. */
export interface ConnectorsPart2Props {
  alwaysAllowed: number;
  busy: string | undefined;
  connect: (
    name: string,
    source?: ConnectorOperation | undefined,
    transferred?: ConnectorOperation | undefined,
  ) => Promise<void>;
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
  editing: boolean;
  forget: () => Promise<void>;
  linearConnected: boolean;
  listed: McpServerState[];
  loadFailed: boolean;
  local: boolean;
  manage: boolean;
  mcp: McpServers | undefined;
  open: string | undefined;
  policy: ClientPolicy;
  reconnectAll: () => void;
  refusal:
    | "Custom connectors aren’t available for this account."
    | "MCP servers can be changed once Claudex reaches your service."
    | "Your administrator has turned off adding MCP servers."
    | undefined;
  resetFilters: () => void;
  retry: () => undefined;
  servers: McpServerState[];
  setDetail: React.Dispatch<React.SetStateAction<string>>;
  setOpen: React.Dispatch<React.SetStateAction<string | undefined>>;
  setRemoving: React.Dispatch<React.SetStateAction<McpServerState | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<ConnectorStatusFilter>>;
  setTool: (
    name: string,
    tool: string,
    permission: ConnectorToolPermission,
  ) => Promise<void>;
  setView: React.Dispatch<React.SetStateAction<"yours" | "discover">>;
  settings: Settings;
  status: ConnectorStatusFilter;
  words: string;
}

export function ConnectorsDialogs({
  alwaysAllowed,
  busy,
  connect,
  directoryEntries,
  directoryFilter,
  editing,
  forget,
  linearConnected,
  listed,
  loadFailed,
  local,
  manage,
  mcp,
  open,
  policy,
  reconnectAll,
  refusal,
  resetFilters,
  retry,
  servers,
  setDetail,
  setOpen,
  setRemoving,
  setStatus,
  setTool,
  setView,
  settings,
  status,
  words,
}: ConnectorsPart2Props) {
  return (
    <>
      {refusal && <p className="desktop-connector-note">{refusal}</p>}
      <Suspense fallback={null}>
        <ConnectorAttention
          servers={listed}
          editable={editing}
          busy={busy !== undefined}
          onReconnect={reconnectAll}
          onView={(server) => setDetail(`installed:${server.name}`)}
        />
      </Suspense>
      {manage && alwaysAllowed > 0 && (
        <p className="desktop-connector-note">
          {alwaysAllowed === 1
            ? "1 connector tool always allowed ·"
            : `${alwaysAllowed} connector tools always allowed ·`}{" "}
          <button
            type="button"
            className="desktop-connector-forget"
            onClick={() => void forget()}
          >
            Forget
          </button>
        </p>
      )}
      {!manage && servers.length > 0 && (
        <p className="desktop-connector-note">{serviceNote}</p>
      )}
      {mcp?.configError && (
        <p className="developer-mcp-config-error" role="alert">
          Your last edit to the configuration wasn’t applied: {mcp.configError}
        </p>
      )}
      {loadFailed && !mcp ? (
        <div className="desktop-connectors-failed">
          <p>Couldn’t load connectors</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      ) : (
        <>
          {listed.length > 0 && !words && (
            <Segmented<ConnectorStatusFilter>
              label="Filter by status"
              value={status}
              options={[
                { value: "all", label: "All" },
                { value: "connected", label: "Connected" },
                { value: "notConnected", label: "Not connected" },
              ]}
              onChange={setStatus}
            />
          )}
          {listed.length > 0 && !servers.length && words && (
            <NothingMatches
              message="No connectors match your search"
              hint="Try a different term, or browse the Directory to find new connectors."
            />
          )}
          {listed.length > 0 &&
            !servers.length &&
            !words &&
            connectorFilterActive(directoryFilter) && (
              <NothingMatches onReset={resetFilters} />
            )}
          {listed.length > 0 &&
            !servers.length &&
            !words &&
            !connectorFilterActive(directoryFilter) && (
              <p className="desktop-connectors-none">
                {status === "connected"
                  ? "Nothing connected."
                  : "Nothing to connect."}
              </p>
            )}
        </>
      )}
      {servers.length ? (
        <DesktopConnectorsTable
          busy={busy}
          connect={connect}
          directoryEntries={directoryEntries}
          editing={editing}
          linearConnected={linearConnected}
          local={local}
          manage={manage}
          open={open}
          policy={policy}
          servers={servers}
          setDetail={setDetail}
          setOpen={setOpen}
          setRemoving={setRemoving}
          setTool={setTool}
          settings={settings}
        />
      ) : (
        mcp &&
        listed.length === 0 && (
          <div className="settings-callout">
            <h3>Add your first connectors</h3>
            <p>
              {!manage
                ? "Your Claudex service doesn't provide any connectors yet."
                : editing
                  ? "Connectors let Claudex work with your team’s tools and data. Add them from the directory, or add a custom one."
                  : "Connectors let Claudex work with your team’s tools and data. Add them from the directory."}
            </p>
            <Button primary size="regular" onClick={() => setView("discover")}>
              Discover connectors
            </Button>
          </div>
        )
      )}
    </>
  );
}
