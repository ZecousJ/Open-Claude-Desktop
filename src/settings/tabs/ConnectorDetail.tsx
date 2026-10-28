import { Fragment, useState } from "react";
import { ArrowLeft, Copy } from "../../ui/glyphs";
import type { CatalogueConnector } from "../../../shared/connectors-catalogue";
import type {
  ConnectorToolPermission,
  McpServerState,
} from "../../../shared/settings-desktop-api";
import { useConnectorOwner, type ConnectorOperation } from "../connector-owner";
import { currentLocale, formatText } from "../../i18n";
import { Button, PageHeader } from "../controls";
import { ToolPermissions } from "./ToolPermissions";
import { showToast } from "../../ui/toast-store";
import { surface } from "../../../shared/host";
import { connectorShareLink } from "../../../shared/connector-links";
import "./connector-detail.css";
import {
  CommunityExplainer,
  DirectoryReviewBadge,
} from "../directory/DirectoryReview";
import { CustomizeConnectorDetail } from "../directory/CustomizeConnectorDetail";
import { connectorReview } from "../directory/connector-detail-model";

export interface ConnectorDetailProps {
  entry?: CatalogueConnector;
  server?: McpServerState;
  editable: boolean;
  onBack: () => void;
  onConnect: (operation?: ConnectorOperation) => Promise<void>;
  onEdit?: () => void;
  /** Asks to disconnect the installed server (the list row's Disconnect). */
  onDisconnect?: () => void;
  onSet: (tool: string, permission: ConnectorToolPermission) => void;
  onError: (error: unknown) => void;
  onOpenCategory?: (category: string) => void;
  presentation?: "settings" | "customize";
  related?: CatalogueConnector[];
  onOpenRelated?: (entry: CatalogueConnector) => void;
  onConnectRelated?: (entry: CatalogueConnector) => void;
  relatedServers?: McpServerState[];
  canConnectRelated?: (entry: CatalogueConnector) => boolean;
  remoteIcons?: boolean;
}

// Kept here for the callers that read it from the detail.
export { connectorReview };

// Metadata is conditional, including unknown authentication.
export default function ConnectorDetail({
  entry,
  server,
  editable,
  onBack,
  onConnect,
  onEdit,
  onDisconnect,
  onSet,
  onError,
  presentation = "settings",
  ...details
}: ConnectorDetailProps) {
  const owner = useConnectorOwner(
    JSON.stringify([entry?.id, server?.name, server?.url ?? entry?.url]),
  );
  const [pendingOwner, setPendingOwner] = useState<number>();
  const busy = pendingOwner === owner.key;
  const connect = () => {
    if (!owner.current() || busy) return;
    const operation = owner.capture("connect");
    setPendingOwner(owner.key);
    void onConnect(operation)
      .catch((error) => {
        if (operation.current()) onError(error);
      })
      .finally(() => {
        if (operation.current()) setPendingOwner(undefined);
      });
  };
  const openExternal = (url: string) => {
    if (!owner.current()) return;
    const operation = owner.capture("external");
    void operation.bridge.openExternal(url).catch((error) => {
      if (operation.current()) onError(error);
    });
  };
  const name = server?.displayName ?? server?.name ?? entry!.name;
  const url = server?.url ?? entry?.url;
  const isAuthless = entry?.isAuthless;
  const connected =
    server?.state === "ready" && server.authStatus !== "notLoggedIn";
  // How the connection stands, in the original's sentences: switched off,
  // stopped working, or never finished.
  const status = connected
    ? undefined
    : server?.state === "disabled"
      ? "You disconnected {name}. Claudex can’t access it until you connect it again."
      : server?.state === "failed"
        ? "Your connection to {name} stopped working. Reconnect to continue."
        : "You’re not connected to {name} yet.";
  const reconnect = server?.state === "failed";
  const signIn =
    isAuthless !== undefined
      ? !isAuthless
      : server?.authStatus && server.authStatus !== "unsupported"
        ? true
        : undefined;
  const rows = [
    ...(entry?.byline ? [["Made by", entry.byline.replace(/^by /, "")]] : []),
    ...(url ? [["Connector URL", url]] : []),
    ...(signIn !== undefined
      ? [["Sign-in", signIn ? "Required" : "Not required"]]
      : []),
    ["Review status", connectorReview(entry)],
    ...(entry?.added && Number.isFinite(Date.parse(entry.added))
      ? [
          [
            "Added to directory",
            new Date(entry.added).toLocaleDateString(currentLocale()),
          ],
        ]
      : []),
  ];
  if (presentation === "customize")
    return (
      <CustomizeConnectorDetail
        entry={entry}
        server={server}
        editable={editable}
        onBack={onBack}
        onConnect={onConnect}
        onEdit={onEdit}
        onSet={onSet}
        onError={onError}
        {...details}
      />
    );
  return (
    <section className="connector-detail">
      <button type="button" className="desktop-connector-back" onClick={onBack}>
        <ArrowLeft size={16} />
        Connectors
      </button>
      <PageHeader title={name} />
      <DirectoryReviewBadge
        review={entry?.type ?? "custom"}
        kind={
          entry?.desktopExtension || server?.desktopExtension
            ? "desktop_extension"
            : "connector"
        }
      />
      {(entry?.desktopExtension || server?.desktopExtension) && (
        <span className="connector-badge">Desktop extension</span>
      )}
      {entry?.description && <p>{entry.description}</p>}
      {(entry?.type === "community" ||
        entry?.desktopExtension ||
        server?.desktopExtension) && (
        <CommunityExplainer
          kind={
            entry?.desktopExtension || server?.desktopExtension
              ? "desktop_extension"
              : "connector"
          }
          onError={onError}
        />
      )}
      <div className="connector-detail-actions">
        {server?.url && editable && onEdit && (
          <Button onClick={onEdit}>Edit</Button>
        )}
        <Button
          onClick={() => {
            const link = connectorShareLink(
              server ? `installed:${server.name}` : entry!.id,
              window.location.href,
              surface === "desktop",
            );
            if (!owner.current()) return;
            const operation = owner.capture("copy");
            void operation.bridge
              .copyText(link)
              .then(() => {
                if (operation.current()) showToast("Link copied");
              })
              .catch((error) => {
                if (operation.current()) onError(error);
              });
          }}
        >
          <Copy size={14} />
          Copy link
        </Button>
        {entry?.supportUrl && (
          <Button onClick={() => openExternal(entry.supportUrl!)}>
            Support
          </Button>
        )}
        {entry?.documentationUrl && (
          <Button onClick={() => openExternal(entry.documentationUrl!)}>
            Documentation
          </Button>
        )}
        {isAuthless && (
          <span
            className="settings-badge"
            title="This connector doesn’t use authentication. You can block individual tools from the connector’s settings."
          >
            Connected by default
          </span>
        )}
      </div>
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
      {server?.toolList && (
        <ToolPermissions
          server={name}
          tools={server.toolList}
          editable={editable}
          onSet={onSet}
        />
      )}
      {!server?.toolList && entry?.tools && entry.tools.length > 0 && (
        <section>
          <h2>Tools</h2>
          <ul>
            {entry.tools.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </section>
      )}
      {status && (
        <p className="connector-detail-status" role="status">
          {formatText(status, { name })}
        </p>
      )}
      {(!connected || (server && onDisconnect)) && (
        <div className="button-row connector-detail-buttons">
          {!connected && <Button onClick={onBack}>Cancel</Button>}
          {server && editable && onDisconnect && (
            <Button onClick={onDisconnect}>Disconnect</Button>
          )}
          {!connected && (
            <Button primary disabled={!editable || busy} onClick={connect}>
              {reconnect ? "Reconnect" : "Connect"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
