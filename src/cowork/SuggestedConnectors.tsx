import { Suspense, useContext, useEffect, useState } from "react";
import { Globe, Check, ChevronRight, Plus, X } from "../ui/glyphs";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { AppContext } from "../app/AppContext";
import { lazyPiece } from "../ui/lazy-piece";
import { useFavicons } from "../research/useFavicons";

const ConnectLinearDialog = lazyPiece(
  () => import("../linear/ConnectLinearDialog"),
);
const dismissalKey = "cowork-dismissed-suggested-connectors";
const suggestions = [
  {
    name: "Notion",
    host: "www.notion.so",
    url: "https://mcp.notion.com/mcp",
    description: "Search and update your Notion pages and databases",
  },
  {
    name: "Linear",
    host: "linear.app",
    description: "Create, update, and track issues in Linear",
  },
];

// Personal connectors connect directly; Request/Requested is organization-only
// .
export default function SuggestedConnectors() {
  const app = useContext(AppContext);
  const icons = useFavicons(suggestions.map((entry) => entry.host));
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissalKey) === "true";
    } catch {
      return false;
    }
  });
  const [servers, setServers] = useState<McpServerState[]>([]);
  const [linear, setLinear] = useState(false);
  const [connectingLinear, setConnectingLinear] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissalKey, "true");
    } catch {}
  };
  const refresh = () => {
    void window.desktop
      .mcpServers()
      .then((value) => {
        setServers(value.servers);
        setLoaded(true);
      })
      .catch(() => {});
    void window.desktop
      .linearStatus()
      .then((value) => setLinear(value.connected))
      .catch(() => {});
  };
  useEffect(() => {
    if (dismissed) return;
    refresh();
    // A browser sign-in finishes in another window: read again on return.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [dismissed]);
  const connected = (name: string) =>
    (name === "Linear" && linear) ||
    servers.some(
      (server) =>
        server.name.toLowerCase() === name.toLowerCase() &&
        server.state === "ready" &&
        server.authStatus !== "notLoggedIn",
    );
  const allConnected = suggestions.every((entry) => connected(entry.name));
  useEffect(() => {
    if (loaded && allConnected) dismiss();
  }, [loaded, allConnected]);
  if (dismissed || !loaded || allConnected) return null;
  return (
    <div className="cowork-suggestions">
      <div className="cowork-suggestions-heading">
        <span>Suggested connectors</span>
        <button aria-label="Dismiss suggested connectors" onClick={dismiss}>
          <X size={16} />
        </button>
      </div>
      {/* Chat and Cowork are one (the original's merged text names Claude). */}
      <p>Claudex uses connectors to browse websites, manage tasks, and more.</p>
      <div className="cowork-suggestion-list">
        {suggestions.map((entry) => (
          <button
            key={entry.name}
            title={entry.description}
            disabled={Boolean(busy) || connected(entry.name)}
            onClick={() => {
              if (entry.name === "Linear") {
                setConnectingLinear(true);
                return;
              }
              const existing = servers.find(
                (server) =>
                  server.name.toLowerCase() === entry.name.toLowerCase(),
              );
              setBusy(entry.name);
              void (async () => {
                if (!existing)
                  await window.desktop.addCustomConnector({
                    name: entry.name,
                    url: entry.url!,
                  });
                const callback =
                  app?.host?.kind === "web"
                    ? new URL(location.pathname, location.origin)
                    : undefined;
                callback?.searchParams.set("cowork_connector", "1");
                const address = await window.desktop.connectConnector(
                  existing?.name ?? entry.name,
                  callback?.href,
                );
                if (address) location.assign(address);
                refresh();
              })()
                .catch((error) => app?.report(error))
                .finally(() => setBusy(undefined));
            }}
          >
            <i
              className="cowork-suggestion-icon"
              data-connected={connected(entry.name) || undefined}
            >
              {connected(entry.name) ? (
                <Check size={16} />
              ) : icons[entry.host] ? (
                <img src={icons[entry.host]!} width={18} height={18} alt="" />
              ) : (
                <Globe size={18} />
              )}
            </i>
            <span data-no-translate>{entry.name}</span>
            {!connected(entry.name) && <Plus size={20} />}
          </button>
        ))}
        <button
          className="cowork-suggestion-all"
          onClick={() => app?.openSettingsTab("connectors")}
        >
          <span>See all connectors</span>
          <ChevronRight size={16} />
        </button>
      </div>
      {connectingLinear && (
        <Suspense fallback={null}>
          <ConnectLinearDialog
            onClose={() => setConnectingLinear(false)}
            onConnected={refresh}
          />
        </Suspense>
      )}
    </div>
  );
}
