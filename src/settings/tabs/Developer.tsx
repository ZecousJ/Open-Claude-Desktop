import { Suspense, useEffect, useRef, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import { createPortal } from "react-dom";
import { ArrowUpRight, Code2, Trash2 } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import type { TabProps } from "../context";
import "../developer.css";
import { usePolicy } from "../../policy/PolicyContext";
import { mcpEditingRefusal } from "../../../shared/client-policy";
import { connectorAllowed } from "../../../shared/client-policy-rules";
import type {
  McpServers,
  McpServerState,
} from "../../../shared/settings-desktop-api";
import { ConfirmationDialog } from "../../dialogs/ConfirmationDialog";
import { formatText } from "../../i18n";
import { mcpStateLabels } from "./desktop-labels";
import { useHostCapability } from "../../host/HostContext";
import { extensionPolicyNotice } from "../../../shared/extension-policy";
import { ExtensionPolicyNotice } from "../ExtensionPolicyNotice";

const McpLogsDialog = lazyPiece(
  () => import("../McpLogsDialog"),
  "McpLogsDialog",
);

/** Rows Settings search finds on this page. */
export { developerLabels as searchLabels } from "./desktop-labels";

/** How often the page asks for server states while it is open. */
export const mcpRefreshMs = 3000;
/**
 * The same without a configuration file on this computer (the web app):
 * the service's connectors change rarely, and each ask is a request to it.
 */
export const serviceMcpRefreshMs = 15000;

/**
 * The configured servers with their live state; refreshed while the page
 * is open, since the configuration file can change at any time and the
 * runtime restarts to apply it. `failed` is set while the list could not be
 * read and none is known yet; `retry` asks again.
 */
export function useMcpServerList(onError: (error: unknown) => void) {
  const [value, setValue] = useState<McpServers>();
  const [failed, setFailed] = useState(false);
  const reload = useRef<() => void>(() => {});
  const localMcp = useHostCapability("localMcp");
  useEffect(() => {
    let live = true;
    let reported = false;
    const load = () =>
      window.desktop
        .mcpServers()
        .then((next) => {
          if (live && next) {
            setValue(next);
            setFailed(false);
          }
        })
        .catch((error) => {
          // Report once; the next refresh tries again.
          if (!reported) onError(error);
          reported = true;
          if (live) setFailed(true);
        });
    reload.current = () => void load();
    void load();
    const timer = setInterval(
      load,
      localMcp ? mcpRefreshMs : serviceMcpRefreshMs,
    );
    const off = window.desktop.onEvent((event) => {
      if (event.type === "settings" || event.type === "engine") void load();
    });
    return () => {
      live = false;
      clearInterval(timer);
      off();
    };
  }, []);
  return { value, failed, retry: () => reload.current() };
}

/** The configured servers with their live state (see `useMcpServerList`). */
export function useMcpServers(onError: (error: unknown) => void) {
  return useMcpServerList(onError).value;
}
/**
 * Hand-drawn monitor and pointer, traced at 100% from
 * claude-developer-modal-001.
 */
function EmptyServersIllustration() {
  return (
    <svg
      className="developer-mcp-illustration"
      width="57"
      height="55"
      viewBox="0 0 57 55"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.1 2.2 55 1.9l-.1 38.5L2 40.4z" />
      <path d="M20.2 40.6 19 48.6 12.2 52.8l33.5.1L38 48.6l-1.4-8" />
      <path d="M19 48.6h19" />
      <path
        className="developer-mcp-pointer"
        d="m17.3 9.1 22.2 10.5-6.3 2.5 6.3 6-4.6 4.7-6.4-6.6-4.4 4.8z"
      />
    </svg>
  );
}

/** The configured entry's command, arguments and environment, as the file holds them. */
function serverConfig(config: unknown) {
  const entry =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)
      : {};
  const args = Array.isArray(entry.args)
    ? entry.args.map(String).join(" ")
    : "";
  const env =
    entry.env && typeof entry.env === "object"
      ? Object.entries(entry.env as Record<string, unknown>).map(
          ([key, value]) => `${key}=${String(value)}`,
        )
      : [];
  return {
    command: typeof entry.command === "string" ? entry.command : undefined,
    args,
    env,
  };
}

/**
 * The configured servers: a list on the left (a failed one carries a warning)
 * and the chosen server's details on the right.
 */
export function ServerPanel({
  servers,
  configs,
  canDelete,
  isBlocked,
  onRemove,
  onError,
}: {
  servers: McpServerState[];
  configs: Record<string, unknown>;
  canDelete: boolean;
  isBlocked: (server: McpServerState) => boolean;
  onRemove: (name: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [selected, setSelected] = useState(servers[0]?.name);
  const [removing, setRemoving] = useState(false);
  // A server removed from the file leaves the first one chosen.
  const server = servers.find((item) => item.name === selected) ?? servers[0];
  return (
    <div className="developer-mcp-split">
      <ul className="developer-mcp-names" aria-label="Local MCP servers">
        {servers.map((item) => (
          <li key={item.name}>
            <button
              type="button"
              aria-current={item.name === server.name ? "true" : undefined}
              onClick={() => setSelected(item.name)}
            >
              <span>{item.name}</span>
              {item.state === "failed" && (
                <AppIcon name="Warning" size={16} aria-hidden="true" />
              )}
            </button>
          </li>
        ))}
      </ul>
      <ServerDetail
        key={server.name}
        server={server}
        config={serverConfig(configs[server.name])}
        blocked={isBlocked(server)}
        onRemove={canDelete ? () => setRemoving(true) : undefined}
      />
      {removing &&
        createPortal(
          <ConfirmationDialog
            confirmation={{
              title: formatText(
                "Are you sure you want to remove the MCP server “{serverKey}”?",
                { serverKey: server.name },
              ),
              body: "Claudex stops the server and removes it from your configuration. You can add it again later.",
              confirm: "Delete",
              action: () => onRemove(server.name),
            }}
            onClose={() => setRemoving(false)}
            onError={onError}
          />,
          document.body,
        )}
    </div>
  );
}

function ServerDetail({
  server,
  config,
  blocked,
  onRemove,
}: {
  server: McpServerState;
  config: ReturnType<typeof serverConfig>;
  blocked: boolean;
  onRemove?: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const command = config.command ?? server.command;
  return (
    <div className="developer-mcp-detail">
      <header>
        <h2>{server.name}</h2>
        {blocked ? (
          <small className="developer-mcp-blocked">
            Blocked by your administrator
          </small>
        ) : (
          <small
            className={`developer-mcp-state ${server.state}`}
            aria-label={`State: ${mcpStateLabels[server.state]}`}
          >
            {mcpStateLabels[server.state]}
          </small>
        )}
        {onRemove && (
          <button
            type="button"
            className="developer-mcp-delete"
            aria-label="Delete"
            onClick={onRemove}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </header>
      {command && (
        <section>
          <h3>Command</h3>
          <p>{command}</p>
        </section>
      )}
      {config.args && (
        <section>
          <h3>Arguments</h3>
          <p>{config.args}</p>
        </section>
      )}
      {server.url && (
        <section>
          <h3>URL</h3>
          <p>{server.url}</p>
        </section>
      )}
      {server.state === "ready" && (
        <section>
          <h3>Tools</h3>
          <p>{server.tools}</p>
        </section>
      )}
      {server.error && (
        <section className="developer-mcp-failure">
          <h3>Error</h3>
          <p>{server.error}</p>
        </section>
      )}
      <section>
        <button
          type="button"
          className="developer-mcp-logs"
          onClick={() => setLogsOpen(true)}
        >
          View logs
        </button>
      </section>
      {logsOpen && (
        <Suspense fallback={null}>
          <McpLogsDialog
            name={server.name}
            onClose={() => setLogsOpen(false)}
          />
        </Suspense>
      )}
      {config.env.length > 0 && (
        <section className="developer-mcp-advanced">
          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            Advanced options
          </button>
          {advanced && (
            <div>
              <h3>Environment variables</h3>
              {config.env.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Developer. Local MCP servers with the runtime's state for each; Edit config
 * opens the configuration file in the system editor (as the original does) and
 * saving the file applies it. With local MCP editing turned off by the
 * administrator, the list stays and the reason replaces the button. The page
 * exists only where the app runs local MCP servers (nav.tsx tabAvailable): the
 * web app has no Developer page.
 */
export function DeveloperTab({ settings, engine, onError }: TabProps) {
  const policy = usePolicy();
  const mcp = useMcpServers(onError);
  const unpackedAllowed =
    policy.developerModeEnabled !== false &&
    policy.desktopExtensionsEnabled !== false;
  const notice = extensionPolicyNotice(policy);
  const servers = mcp?.servers ?? [];
  const model = settings.providers.find(
    (provider) => provider.id === settings.activeProviderId,
  )?.model;
  const service =
    engine.state === "ready"
      ? "Connected"
      : engine.state === "starting"
        ? "Connecting…"
        : "Unavailable";
  if (
    policy.desktopExtensionsEnabled === false &&
    policy.developerMcpEnabled === false
  )
    return (
      <div className="developer-settings">
        <h3>Local MCP servers</h3>
        <ExtensionPolicyNotice message={notice!} />
      </div>
    );
  return (
    <div className="developer-settings">
      <div className="developer-mcp-heading">
        <h3>Local MCP servers</h3>
        <p>Add and manage MCP servers that you’re working on.</p>
      </div>
      {notice && <ExtensionPolicyNotice message={notice} />}
      {mcp?.configError && (
        <p className="developer-mcp-config-error" role="alert">
          Your last edit to the configuration wasn’t applied: {mcp.configError}
        </p>
      )}
      {servers.length ? (
        <ServerPanel
          servers={servers}
          configs={settings.mcpServers}
          canDelete={policy.localMcpEditing}
          isBlocked={(server) =>
            !connectorAllowed(
              policy,
              server.name,
              settings.mcpServers[server.name],
            )
          }
          onRemove={async (name) => {
            await window.desktop.removeConnector(name);
          }}
          onError={onError}
        />
      ) : (
        mcp && (
          <div className="developer-mcp-empty">
            <EmptyServersIllustration />
            <p>No servers added</p>
          </div>
        )
      )}
      {!policy.localMcpEditing && (
        <p className="developer-mcp-managed">{mcpEditingRefusal(policy)}</p>
      )}
      {(policy.localMcpEditing || policy.externalLinks) && (
        <div className="developer-mcp-actions">
          {unpackedAllowed && policy.localMcpEditing && (
            <button
              className="developer-edit-config"
              onClick={() =>
                void window.desktop.installUnpackedExtension().catch(onError)
              }
            >
              Install unpacked extension
            </button>
          )}
          {policy.localMcpEditing && (
            <button
              className="developer-edit-config"
              onClick={() => void window.desktop.openMcpConfig().catch(onError)}
            >
              Edit config
            </button>
          )}
          {policy.externalLinks && (
            <button
              className="developer-docs"
              onClick={() =>
                void window.desktop
                  .openExternal("https://modelcontextprotocol.io/quickstart")
                  .catch(onError)
              }
            >
              Developer docs <ArrowUpRight size={19} strokeWidth={1.5} />
            </button>
          )}
        </div>
      )}
      <div className="developer-access-card">
        <div className="developer-access-heading">
          <Code2 size={19} />
          <strong>Model access</strong>
        </div>
        <p>
          Models are included with your Claudex account. Your administrator
          manages the service.
        </p>
        <div className="developer-access-meta">
          <span>{model || "No model assigned"}</span>
          <span>{service}</span>
        </div>
      </div>
    </div>
  );
}
