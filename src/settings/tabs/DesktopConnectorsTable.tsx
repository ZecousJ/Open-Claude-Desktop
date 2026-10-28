import { connectorAllowed } from "../../../shared/client-policy-rules";
import { linearMcpUrl } from "../../../shared/linear-api";
import { Fragment } from "react";
import { InstalledConnectorRow } from "./InstalledConnectorRow";
import { ToolPermissions } from "./ToolPermissions";
import type { ConnectorOperation } from "../connector-owner";
import type { CatalogueConnector } from "../../../shared/connectors-catalogue";
import type { ClientPolicy } from "../../../shared/client-policy";
import type {
  McpServerState,
  ConnectorToolPermission,
} from "../../../shared/settings-desktop-api";
import type { Settings } from "../../../shared/types";

/** What DesktopConnectorsTable needs from ConnectorsView.tsx. */
export interface SettingsTableProps {
  busy: string | undefined;
  connect: (
    name: string,
    source?: ConnectorOperation | undefined,
    transferred?: ConnectorOperation | undefined,
  ) => Promise<void>;
  directoryEntries: CatalogueConnector[];
  editing: boolean;
  linearConnected: boolean;
  local: boolean;
  manage: boolean;
  open: string | undefined;
  policy: ClientPolicy;
  servers: McpServerState[];
  setDetail: React.Dispatch<React.SetStateAction<string>>;
  setOpen: React.Dispatch<React.SetStateAction<string | undefined>>;
  setRemoving: React.Dispatch<React.SetStateAction<McpServerState | undefined>>;
  setTool: (
    name: string,
    tool: string,
    permission: ConnectorToolPermission,
  ) => Promise<void>;
  settings: Settings;
}

export function DesktopConnectorsTable({
  busy,
  connect,
  directoryEntries,
  editing,
  linearConnected,
  local,
  manage,
  open,
  policy,
  servers,
  setDetail,
  setOpen,
  setRemoving,
  setTool,
  settings,
}: SettingsTableProps) {
  return (
    <table className="settings-table desktop-connectors">
      <thead>
        <tr>
          <th>Connector</th>
          <th>Type</th>
          <th>Status</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {servers.map((server) => {
          const linearIntegration = linearConnected && server.name === "Linear";
          const allowed = connectorAllowed(
            policy,
            server.name,
            linearIntegration
              ? { url: linearMcpUrl }
              : settings.mcpServers[server.name],
          );
          const tools = server.toolList ?? [];
          const expanded = open === server.name && tools.length > 0;
          return (
            <Fragment key={server.name}>
              <InstalledConnectorRow
                allowed={allowed}
                busy={busy}
                connect={connect}
                directoryEntries={directoryEntries}
                editing={editing}
                expanded={expanded}
                linearIntegration={linearIntegration}
                local={local}
                server={server}
                setDetail={setDetail}
                setOpen={setOpen}
                setRemoving={setRemoving}
                tools={tools}
              />
              {expanded && (
                <tr className="desktop-connector-tools">
                  <td colSpan={4}>
                    <ToolPermissions
                      server={server.name}
                      tools={tools}
                      editable={editing}
                      onSet={(tool, permission) =>
                        void setTool(server.name, tool, permission)
                      }
                    />
                    <p className="desktop-connector-note">
                      {manage
                        ? "Tools that are off are never offered to Claudex. Changes apply once the current task finishes."
                        : "Tools that are off are never offered to Claudex."}
                    </p>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
