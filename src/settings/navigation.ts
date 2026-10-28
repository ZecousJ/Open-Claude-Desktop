import { connectorSuggestion } from "../../shared/connector-links";

export const settingsNavigationEvent = "claudex:settings-navigation";
// Bridge the explicit navigation event and a lazy Connectors mount. Reads in
// state initializers are pure for StrictMode; the committed effect consumes it.
// Web routing also preserves the destination for refresh and Back/Forward.
let pendingConnector: string | undefined;
export const readSettingsConnectorTarget = () => pendingConnector;
export function takeSettingsConnectorTarget() {
  const target = pendingConnector;
  pendingConnector = undefined;
  return target;
}

// Settings → Connectors opened from the add menu's Add connector › rows: on
// the directory (Browse connectors) or with the custom connector form open.
// Read in state initializers, consumed by the committed effect.
export type ConnectorsEntry = "discover" | "add";
let pendingEntry: { entry: ConnectorsEntry; at: number } | undefined;
const entryLifetimeMs = 5_000;
export function requestConnectorsEntry(entry: ConnectorsEntry) {
  pendingEntry = { entry, at: Date.now() };
}
export function readConnectorsEntry(): ConnectorsEntry | undefined {
  return pendingEntry && Date.now() - pendingEntry.at < entryLifetimeMs
    ? pendingEntry.entry
    : undefined;
}
export function takeConnectorsEntry() {
  const entry = readConnectorsEntry();
  pendingEntry = undefined;
  return entry;
}

export function connectorLinkId(href: string | undefined) {
  if (!href?.startsWith("/settings/connectors?")) return undefined;
  const id = new URLSearchParams(href.slice(href.indexOf("?"))).get(
    "connector",
  );
  return id &&
    (id.length <= 256 || connectorSuggestion(`https://claudex.local${href}`))
    ? id
    : undefined;
}

export function openSettingsLink(
  tab: "connectors" | "capabilities",
  connector?: string,
) {
  pendingConnector = tab === "connectors" ? connector : undefined;
  const url = new URL(window.location.href);
  if (connector) url.searchParams.set("connector", connector);
  else url.searchParams.delete("connector");
  window.history.replaceState(window.history.state, "", url.href);
  window.dispatchEvent(
    new CustomEvent(settingsNavigationEvent, { detail: tab }),
  );
}
