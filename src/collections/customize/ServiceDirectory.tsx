import { Suspense, useEffect, useRef, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import { useHostCapability } from "../../host/HostContext";
import { connectCustomConnector } from "../../settings/tabs/connector-login";
import {
  handoffConnectorOperation,
  readConnectorServers,
  useConnectorOwner,
  type ConnectorOperation,
} from "../../settings/connector-owner";
import { isApprovedDirectoryEntries } from "../../../shared/connectors-catalogue";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import { Plus } from "../../ui/glyphs";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import { directoryGlyph } from "../../settings/directory/icons";

const AddConnectorDialog = lazyPiece(
  () => import("../../settings/tabs/AddConnectorDialog"),
);
type Props = {
  kind: "plugin" | "mcp";
  query?: string;
  onError(error: unknown): void;
};
export function ServiceDirectory(props: Props) {
  const owner = useConnectorOwner(`service-directory:${props.kind}`);
  return <OwnedServiceDirectory key={owner.key} {...props} owner={owner} />;
}
function OwnedServiceDirectory({
  kind,
  query = "",
  onError,
  owner,
}: Props & { owner: ReturnType<typeof useConnectorOwner> }) {
  const [entries, setEntries] = useState<ApprovedDirectoryEntry[]>([]);
  const [busyValue, setBusy] = useState<string>();
  const busyOperation = useRef<ConnectorOperation | undefined>(undefined);
  const busy =
    busyOperation.current && !busyOperation.current.current()
      ? undefined
      : busyValue;
  const [, refreshSettings] = useState(0);
  const [selected, setSelected] = useState<ApprovedDirectoryEntry>();
  const [configured, setConfigured] = useState<McpServerState[]>([]);
  const [failed, setFailed] = useState(false),
    [loading, setLoading] = useState(false);
  const known = useRef(configured);
  known.current = configured;
  const catalogue = useRef(entries);
  catalogue.current = entries;
  const currentConfiguration = useRef<Record<string, unknown> | undefined>(
    undefined,
  );
  const local = useHostCapability("localMcp");
  const load = async () => {
    if (!owner.current()) return;
    const operation = owner.capture("directory-read");
    setLoading(true);
    setFailed(false);
    try {
      const items = await operation.bridge.listApprovedDirectory();
      if (!operation.current()) return;
      if (!isApprovedDirectoryEntries(items))
        throw Error("Invalid directory response");
      setEntries(items);
    } catch (error) {
      if (operation.current()) {
        setFailed(true);
        onError(error);
      }
    } finally {
      if (operation.current()) setLoading(false);
    }
  };
  useEffect(() => {
    if (!owner.current()) return;
    void load();
    const operation = owner.capture("settings-observer");
    return operation.bridge.onEvent((event) => {
      if (operation.current() && event.type === "settings") {
        currentConfiguration.current = event.settings.mcpServers;
        refreshSettings((value) => value + 1);
      }
    });
  }, [owner.key]);
  const shown = entries.filter(
    (entry) =>
      entry.kind === kind &&
      `${entry.name} ${entry.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const currentEntry = (entry: ApprovedDirectoryEntry) =>
    catalogue.current.some(
      (item) => item.id === entry.id && item.url === entry.url,
    );
  const add = async (entry: ApprovedDirectoryEntry) => {
    const operation = handoffConnectorOperation(
      owner,
      undefined,
      () => currentEntry(entry),
      "add",
    );
    if (!operation?.current()) return;
    busyOperation.current = operation;
    setBusy(entry.id);
    try {
      if (entry.kind === "mcp") {
        const result = await operation.bridge.mcpServers();
        if (!operation.current()) return;
        const servers = readConnectorServers(result);
        known.current = servers;
        setConfigured(servers);
        setSelected(entry);
      } else await operation.bridge.openExternal(entry.url);
    } catch (error) {
      if (operation.current()) onError(error);
    } finally {
      if (owner.current() && busyOperation.current === operation) {
        busyOperation.current = undefined;
        setBusy(undefined);
      }
    }
  };
  const connect = async (name: string, operation: ConnectorOperation) => {
    if (!operation.current()) return;
    busyOperation.current = operation;
    setBusy(name);
    try {
      await connectCustomConnector(name, local, operation);
    } catch (error) {
      if (operation.current()) onError(error);
    } finally {
      if (owner.current() && busyOperation.current === operation) {
        busyOperation.current = undefined;
        setBusy(undefined);
      }
    }
  };
  const open = async (entry: ApprovedDirectoryEntry) => {
    const operation = handoffConnectorOperation(
      owner,
      undefined,
      () => currentEntry(entry),
      "external",
    );
    if (!operation?.current()) return;
    try {
      await operation.bridge.openExternal(entry.url);
    } catch (error) {
      if (operation.current()) onError(error);
    }
  };
  if (!shown.length && !failed) return null;
  const Glyph = directoryGlyph(kind === "mcp" ? "server" : "code");
  return (
    <section className="customize-section">
      {selected && (
        <Suspense fallback={null}>
          <AddConnectorDialog
            defaults={{
              ...selected,
              type: "community",
              topic: "",
              byline: selected.author ?? "",
              icon: "server",
            }}
            existingNames={configured.map(
              (server) => server.displayName ?? server.name,
            )}
            existingIds={configured.map((server) => server.name)}
            onClose={() => {
              if (owner.current()) setSelected(undefined);
            }}
            onAdded={(result, name, source) => {
              if (!source?.current() || !owner.current()) return;
              const servers = readConnectorServers(result);
              if (!currentEntry(selected))
                throw Error(
                  "The connector configuration changed. Refresh and try again.",
                );
              known.current = servers;
              setConfigured(servers);
              const target = name
                ? servers.find((server) => server.name === name)?.url
                : undefined;
              const initialConfiguration = currentConfiguration.current;
              const operation =
                name && target
                  ? handoffConnectorOperation(owner, source, () => {
                      const current = currentConfiguration.current;
                      if (current && Object.hasOwn(current, name))
                        return (
                          (current[name] as { url?: unknown })?.url === target
                        );
                      return (
                        current === initialConfiguration &&
                        known.current.some(
                          (server) =>
                            server.name === name && server.url === target,
                        )
                      );
                    })
                  : undefined;
              if (name && !operation?.current())
                throw Error(
                  "The connector configuration changed. Refresh and try again.",
                );
              // Capture the parent's lease while the child's source is still valid.
              setSelected(undefined);
              if (name && operation) void connect(name, operation);
            }}
          />
        </Suspense>
      )}
      <h2>Claudex Directory</h2>
      {failed && (
        <div role="alert">
          <span>Couldn’t load connectors</span>
          <button
            type="button"
            className="settings-button"
            disabled={loading}
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}
      <ul className="customize-directory-rows">
        {shown.map((entry) => (
          <li key={entry.id}>
            <button type="button" onClick={() => void open(entry)}>
              <span className="customize-row-tile">
                <Glyph size={18} strokeWidth={1.4} />
              </span>
              <span className="customize-directory-row-text">
                <strong>{entry.name}</strong>
                <small>{entry.description}</small>
              </span>
            </button>
            {entry.kind === "mcp" && (
              <span className="customize-unavailable">
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => void add(entry)}
                >
                  <Plus size={18} strokeWidth={1.4} />
                  Add
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
