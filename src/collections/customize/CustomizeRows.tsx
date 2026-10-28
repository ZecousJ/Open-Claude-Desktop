import { formatText, t } from "../../i18n";
import { type ReactNode } from "react";
import { EllipsisVertical, ScrollText, Check } from "../../ui/glyphs";
import { Pictogram } from "../../ui/Pictogram";
import { Spinner } from "../../ui/Spinner";
import type { Settings } from "../../../shared/types";
import type { CustomizeSkill } from "../../../shared/collections-api";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import { connectorAllowed } from "../../../shared/client-policy-rules";
import { usePolicy } from "../../policy/PolicyContext";
import { editedLabel } from "./customize-list";
import "./customize.css";
import "./customize-yours.css";
import { SkeletonGroup, skeletonIndex, TableSkeleton } from "../../ui/Skeleton";
import type { ConnectorStatus } from "./CustomizePage";

/**
 * Rows while the list loads: the skill row's tile, title and description as
 * grey blocks in their places.
 */
export function SkeletonRows({ label }: { label: string }) {
  return (
    <SkeletonGroup
      as="ul"
      className="customize-rows customize-skeleton"
      motion="wave"
      label={label}
    >
      {[0, 1, 2, 3].map((index) => (
        <li
          key={index}
          className="customize-row sk-item"
          style={skeletonIndex(index)}
          aria-hidden="true"
        >
          <span className="customize-row-main">
            <span className="customize-row-tile" />
            <span className="customize-row-text">
              <i />
              <i />
            </span>
          </span>
        </li>
      ))}
    </SkeletonGroup>
  );
}

export function SkillRow({
  skill,
  from,
  menuOpen,
  onOpen,
  onMenu,
}: {
  skill: CustomizeSkill;
  /** "from Claudex" before the description (live Yours rows). */
  from?: string;
  menuOpen: boolean;
  onOpen: () => void;
  onMenu: (button: HTMLButtonElement) => void;
}) {
  return (
    <li className={`customize-row ${skill.enabled ? "" : "is-off"}`}>
      <button
        type="button"
        className="customize-row-main"
        aria-label={formatText("View {name}", { name: skill.name })}
        onClick={onOpen}
      >
        <span className="customize-row-tile" aria-hidden="true">
          <ScrollText size={20} />
        </span>
        <span className="customize-row-text">
          <strong data-no-translate>
            {skill.name}
            {!skill.enabled && (
              <span className="customize-badge">{t("Off")}</span>
            )}
          </strong>
          {(from || skill.description) && (
            <span className="customize-row-line">
              {from && (
                <>
                  <span className="customize-row-from">
                    {formatText("from {name}", { name: from })}
                  </span>
                  {skill.description && (
                    <span className="customize-row-dot" aria-hidden="true">
                      ·
                    </span>
                  )}
                </>
              )}
              {skill.description && (
                <span data-no-translate>{skill.description}</span>
              )}
            </span>
          )}
        </span>
        {skill.editedAt !== undefined && (
          <time dateTime={new Date(skill.editedAt).toISOString()}>
            {editedLabel(skill.editedAt)}
          </time>
        )}
      </button>
      <button
        type="button"
        className="customize-row-more"
        aria-label={formatText("More actions for {name}", { name: skill.name })}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onMenu(event.currentTarget)}
      >
        <EllipsisVertical size={16} strokeWidth={1.6} />
      </button>
    </li>
  );
}

export function Connectors({
  servers,
  rows,
  settings,
  searching,
  status,
  loadFailed,
  onRetry,
  programLabel,
  onDiscover,
  customConnectors,
}: {
  servers: McpServerState[] | undefined;
  rows: McpServerState[];
  settings: Settings;
  searching: boolean;
  status: ConnectorStatus;
  loadFailed: boolean;
  onRetry: () => void;
  /** The type of a connector that is not a web address. */
  programLabel: string;
  onDiscover: () => void;
  customConnectors: boolean;
}) {
  const policy = usePolicy();
  if (servers === undefined) return <TableSkeleton />;
  if (loadFailed)
    return <LoadError message="Couldn’t load connectors" onRetry={onRetry} />;
  if (!servers.length)
    return (
      <section className="customize-callout customize-yours-callout">
        <div>
          <h3>Add your first connectors</h3>
          <p>
            {customConnectors
              ? "Connectors let Claudex work with your team’s tools and data. Add them from the directory, or add a custom one."
              : "Connectors let Claudex work with your team’s tools and data. Add them from the directory."}
          </p>
          <button type="button" onClick={onDiscover}>
            Discover connectors
          </button>
        </div>
        <Pictogram name="ObjectPlugOutlet" size={64} />
      </section>
    );
  return (
    <table className="customize-table">
      <thead>
        <tr>
          <th scope="col">Connector</th>
          <th scope="col">Type</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((server) => {
          const allowed = connectorAllowed(
            policy,
            server.name,
            settings.mcpServers[server.name],
          );
          let status: ReactNode;
          if (!allowed) status = "Blocked by your administrator";
          else if (server.state === "ready")
            status = (
              <Check size={15} strokeWidth={1.6} aria-label="Connected" />
            );
          else if (server.state === "starting")
            status = (
              <>
                <Spinner inheritColor size={13} className="spin" /> Starting
              </>
            );
          else if (server.state === "failed")
            status = <span title={server.error}>Couldn’t connect</span>;
          else status = "Not running";
          return (
            <tr key={server.name}>
              <td>
                <span className="customize-connector-icon" aria-hidden="true">
                  {server.name.slice(0, 1).toUpperCase()}
                </span>
                <strong>{server.name}</strong>
              </td>
              <td>
                {server.url ? "Remote" : programLabel}
                {server.state === "ready" && (
                  <span className="customize-badge">
                    {server.tools} tool{server.tools === 1 ? "" : "s"}
                  </span>
                )}
              </td>
              <td className={server.state === "failed" ? "failed" : ""}>
                {status}
              </td>
            </tr>
          );
        })}
        {!rows.length && (
          <tr>
            <td colSpan={3} className="customize-none" role="status">
              {searching ? (
                <>
                  <strong>No connectors match your search</strong>
                  <span>Try a different term.</span>
                </>
              ) : status !== "all" ? (
                status === "connected" ? (
                  "Nothing connected."
                ) : (
                  "Nothing to connect."
                )
              ) : (
                "No connectors of this type."
              )}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** A list that could not be read: the message and Retry, in place of the list. */
export function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="customize-load-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
