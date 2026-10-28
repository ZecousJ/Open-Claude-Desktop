import { Check, Plus, RefreshCw } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { formatText } from "../../i18n";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import {
  connectorServer,
  type CatalogueConnector,
} from "../../../shared/connectors-catalogue";
import {
  connectorDetailPath,
  connectorPublishedUrl,
} from "./connector-detail-model";
import { DirectoryReviewBadge } from "./DirectoryReview";
import { directoryGlyph } from "./icons";
import "./connector-rows.css";

export function ConnectorLogo({
  entry,
  size = 36,
  remoteIcons = true,
  iconSize,
  glyphSize,
}: {
  entry: CatalogueConnector;
  size?: number;
  iconSize?: number;
  glyphSize?: number;
  remoteIcons?: boolean;
}) {
  const Glyph = directoryGlyph(entry.icon);
  const icon = remoteIcons && connectorPublishedUrl(entry.iconUrl);
  return (
    <span
      className="connector-logo"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          width={iconSize ?? size}
          height={iconSize ?? size}
          style={iconSize ? { width: iconSize, height: iconSize } : undefined}
        />
      ) : (
        <Glyph size={glyphSize ?? (size === 36 ? 20 : 28)} />
      )}
    </span>
  );
}

/** Discover and conditional Related lists share the source's default card
 * presentation and retain the actual runtime's connection/authorization state. */
export function ConnectorRows({
  entries,
  variant = "related",
  onOpen,
  onConnect,
  servers = [],
  busy,
  canConnect,
  remoteIcons = true,
}: {
  entries: CatalogueConnector[];
  variant?: "discover" | "related";
  onOpen?: (entry: CatalogueConnector) => void;
  onConnect?: (entry: CatalogueConnector) => void;
  servers?: McpServerState[];
  busy?: string;
  canConnect?: (entry: CatalogueConnector) => boolean;
  remoteIcons?: boolean;
}) {
  return (
    <ul className="connector-directory-rows" data-variant={variant}>
      {entries.map((entry) => {
        const server = connectorServer(entry, servers);
        const connected =
          server?.state === "ready" && server.authStatus !== "notLoggedIn";
        const working = busy === entry.id || (!!server && busy === server.name);
        return (
          <li key={entry.id}>
            <a
              className="connector-directory-row-main"
              href={connectorDetailPath(entry.id)}
              onClick={(event) => {
                if (
                  !onOpen ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onOpen(entry);
              }}
              aria-label={formatText("View {name}", { name: entry.name })}
            >
              <ConnectorLogo
                entry={entry}
                remoteIcons={remoteIcons}
                size={48}
                iconSize={34}
                glyphSize={26}
              />
              <span className="connector-directory-row-text">
                <span className="connector-directory-row-name">
                  <strong data-no-translate>{entry.name}</strong>
                  <DirectoryReviewBadge review={entry.type} />
                </span>
                <span
                  className="connector-directory-row-description"
                  data-no-translate
                >
                  {entry.description}
                </span>
                {entry.byline && (
                  <small data-no-translate>{entry.byline}</small>
                )}
              </span>
            </a>
            {(connected || onConnect) && (
              <button
                type="button"
                className="connector-directory-row-action"
                aria-label={formatText(
                  connected
                    ? "{name} is connected"
                    : server?.authStatus === "notLoggedIn"
                      ? "Re-authorize {name}"
                      : "Connect {name} to Claudex",
                  { name: entry.name },
                )}
                disabled={
                  connected ||
                  working ||
                  (canConnect ? !canConnect(entry) : false)
                }
                onClick={() => onConnect?.(entry)}
              >
                {working ? (
                  <Spinner size={20} className="spin" />
                ) : connected ? (
                  <Check size={20} />
                ) : server?.authStatus === "notLoggedIn" ? (
                  <RefreshCw size={20} />
                ) : (
                  <Plus size={20} />
                )}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
