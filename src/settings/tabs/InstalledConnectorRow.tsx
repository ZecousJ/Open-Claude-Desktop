import { DirectoryReviewBadge } from "../directory/DirectoryReview";
import { connectorServer } from "../../../shared/connectors-catalogue";
import { formatText } from "../../i18n";
import { relativeTime } from "../../ui/RelativeTime";
import { ChevronDown, ChevronRight, Check } from "../../ui/glyphs";
import { mcpStateLabels } from "./desktop-labels";
import { Button } from "../controls";
import { Spinner } from "../../ui/Spinner";
import type { ConnectorOperation } from "../connector-owner";
import type { CatalogueConnector } from "../../../shared/connectors-catalogue";
import type {
  McpServerState,
  McpToolState,
} from "../../../shared/settings-desktop-api";

/** What InstalledConnectorRow needs from ConnectorsView.tsx. */
export interface ConnectorsPart1Props {
  allowed: boolean;
  busy: string | undefined;
  connect: (
    name: string,
    source?: ConnectorOperation | undefined,
    transferred?: ConnectorOperation | undefined,
  ) => Promise<void>;
  directoryEntries: CatalogueConnector[];
  editing: boolean;
  expanded: boolean;
  linearIntegration: boolean;
  local: boolean;
  server: McpServerState;
  setDetail: React.Dispatch<React.SetStateAction<string>>;
  setOpen: React.Dispatch<React.SetStateAction<string | undefined>>;
  setRemoving: React.Dispatch<React.SetStateAction<McpServerState | undefined>>;
  tools: McpToolState[];
}

export function InstalledConnectorRow({
  allowed,
  busy,
  connect,
  directoryEntries,
  editing,
  expanded,
  linearIntegration,
  local,
  server,
  setDetail,
  setOpen,
  setRemoving,
  tools,
}: ConnectorsPart1Props) {
  return (
    <tr>
      <td>
        <button
          type="button"
          className="desktop-connector-expand"
          onClick={() => setDetail(`installed:${server.name}`)}
        >
          {server.displayName ?? server.name}
        </button>
        <DirectoryReviewBadge
          review={
            directoryEntries.find((entry) => connectorServer(entry, [server]))
              ?.type ?? "custom"
          }
          kind={server.desktopExtension ? "desktop_extension" : "connector"}
        />
        {server.desktopExtension && (
          <span className="connector-badge">Desktop extension</span>
        )}
        {server.authStatus === "notLoggedIn" && server.lastConnectedAt && (
          <small className="desktop-connector-note">
            {formatText("{reason} · last signed in {age}", {
              reason: formatText("Sign-in expired"),
              age: relativeTime(server.lastConnectedAt),
            })}
          </small>
        )}
        {tools.length > 0 ? (
          <button
            type="button"
            className="desktop-connector-expand"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} tools of ${server.name}`}
            onClick={() => setOpen(expanded ? undefined : server.name)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="sr-only">{server.name}</span>
          </button>
        ) : null}
      </td>
      <td>
        {server.url ? "Web" : local ? "Local" : "Service"}{" "}
        {server.state === "ready" &&
          !linearIntegration &&
          server.authStatus !== "notLoggedIn" && (
            <span className="settings-badge">
              {server.tools} {server.tools === 1 ? "tool" : "tools"}
            </span>
          )}
      </td>
      <td>
        {!allowed ? (
          "Blocked by your administrator"
        ) : server.authStatus === "notLoggedIn" ? (
          <span className="desktop-connector-state">Needs sign-in</span>
        ) : server.state === "ready" ? (
          <Check size={16} aria-label="Connected" />
        ) : (
          <span
            className={`desktop-connector-state ${server.state}`}
            title={server.error}
          >
            {mcpStateLabels[server.state]}
          </span>
        )}
      </td>
      <td className="desktop-connector-buttons">
        {editing &&
          allowed &&
          server.url &&
          server.authStatus === "notLoggedIn" && (
            <Button
              disabled={busy === server.name}
              onClick={() => void connect(server.name)}
            >
              {busy === server.name && (
                <Spinner inheritColor size={12} className="spin" />
              )}
              Reconnect
            </Button>
          )}
        {editing && (
          <Button onClick={() => setRemoving(server)}>Disconnect</Button>
        )}
      </td>
    </tr>
  );
}
