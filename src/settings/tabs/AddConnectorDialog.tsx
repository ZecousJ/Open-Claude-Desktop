import { helpUrl } from "../../../shared/help-links";
import { useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { SettingsModal } from "../controls";
import { formatText, t } from "../../i18n";
import type { CatalogueConnector } from "../../../shared/connectors-catalogue";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { ConnectorSuggestion } from "../../../shared/connector-links";
import {
  connectorNameError,
  connectorServerId,
  connectorUrlError,
  connectorUsesSse,
} from "../../../shared/custom-connector";
import {
  connectorConfigurationError,
  templateConnectorUrl,
} from "../../../shared/connector-url-configuration";
import "./add-connector.css";
import {
  readConnectorServers,
  useConnectorOwner,
  type ConnectorOperation,
} from "../connector-owner";
import { starterConnectorId } from "../../../shared/starter-integrations";

// Personal connector form.
type Props = {
  defaults?: CatalogueConnector;
  suggested?: ConnectorSuggestion;
  editingServer?: McpServerState;
  existingNames: string[];
  existingIds: string[];
  onClose: () => void;
  onAdded: (
    servers: { servers: McpServerState[] },
    connectName?: string,
    operation?: ConnectorOperation,
  ) => void;
};

export default function AddConnectorDialog(props: Props) {
  const owner = useConnectorOwner(
    JSON.stringify([
      props.defaults?.id,
      props.suggested?.url,
      props.editingServer?.name,
      props.editingServer?.url,
    ]),
  );
  return <OwnedConnectorDialog key={owner.key} {...props} />;
}
function OwnedConnectorDialog({
  defaults,
  suggested,
  editingServer,
  existingNames,
  existingIds,
  onClose,
  onAdded,
}: Props) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState(
    editingServer?.displayName ??
      editingServer?.name ??
      suggested?.name ??
      defaults?.name ??
      "",
  );
  const [url, setUrl] = useState(
    editingServer?.url ??
      suggested?.url ??
      (defaults?.serverUrlType === "regex" ||
      defaults?.serverUrlType === "template"
        ? ""
        : (defaults?.url ?? "")),
  );
  const [tenant, setTenant] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [transport, setTransport] = useState<"sse" | "streamable-http">(
    editingServer?.transport ??
      (connectorUsesSse(url) ? "sse" : "streamable-http"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const owner = useConnectorOwner(
    JSON.stringify([name, url, transport, clientId, clientSecret]),
  );
  const request = useRef(false);
  const changeUrl = (address: string) => {
    setUrl(address);
    setTransport(connectorUsesSse(address) ? "sse" : "streamable-http");
  };
  const urlError =
    connectorUrlError(url) ??
    (defaults ? connectorConfigurationError(defaults, url) : undefined);
  const duplicate = connectorNameError(name, existingNames);
  const ready =
    step === 1
      ? !urlError && !!name.trim() && !duplicate
      : !clientSecret.trim() || !!clientId.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy || request.current || !owner.current()) return;
    const operation = owner.capture();
    request.current = true;
    setBusy(true);
    setError("");
    try {
      if (step === 1 && !editingServer) {
        const result = await operation.bridge.probeConnector(
          url.trim(),
          connectorServerId(name, existingIds),
          transport,
        );
        if (!operation.current()) return;
        if (typeof result?.authRequired !== "boolean")
          throw Error(
            "The connector returned an invalid authentication result.",
          );
        setAuthRequired(result.authRequired);
        setStep(2);
      } else {
        const serverName =
          editingServer?.name ?? connectorServerId(name, existingIds);
        const result = await operation.bridge.addCustomConnector({
          name: serverName,
          ...(editingServer ? { replaceName: serverName } : {}),
          displayName: name.trim(),
          url: url.trim(),
          ...(starterConnectorId(defaults?.id)
            ? { connectorId: starterConnectorId(defaults?.id) }
            : {}),
          ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          transport,
        });
        if (!operation.current()) return;
        readConnectorServers(result);
        if (operation.current())
          onAdded(result, authRequired ? serverName : undefined, operation);
      }
    } catch (reason) {
      if (operation.current())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      request.current = false;
      if (operation.current()) setBusy(false);
    }
  }
  return (
    <SettingsModal
      className="connector-wizard-modal"
      title={editingServer ? "Edit connector" : "Add custom connector"}
      onClose={() => {
        if (!request.current && owner.current()) onClose();
      }}
    >
      <form
        className="connector-wizard"
        onSubmit={(event) => void submit(event)}
      >
        {!editingServer && (
          <p className="sr-only" aria-live="polite">
            {formatText("Step {step} of 2", { step })}
          </p>
        )}
        {step === 1 ? (
          <>
            <label htmlFor="connector-name">Name</label>
            <input
              key="name"
              id="connector-name"
              className="settings-input"
              autoFocus
              maxLength={128}
              placeholder={t("Name")}
              value={name}
              disabled={busy}
              aria-invalid={duplicate}
              aria-describedby="connector-name-hint"
              onChange={(event) => setName(event.target.value)}
            />
            <p id="connector-name-hint" className="connector-wizard-hint">
              Shown in the connectors list.
            </p>
            {duplicate && (
              <p className="error-text" role="alert">
                {formatText("A connector named ‘{name}’ already exists", {
                  name: name.trim(),
                })}
              </p>
            )}
            <label htmlFor="connector-url">MCP server URL</label>
            {defaults?.serverUrlType === "multiple" ? (
              <select
                id="connector-url"
                className="settings-input"
                value={url}
                disabled={busy}
                onChange={(event) => changeUrl(event.target.value)}
              >
                {(defaults.remoteUrlOptions ?? []).map((option) => (
                  <option key={option.url} value={option.url}>
                    {option.label || option.url}
                  </option>
                ))}
              </select>
            ) : defaults?.serverUrlType === "template" ? (
              <>
                <label htmlFor="connector-tenant">
                  {defaults.remoteUserConfig?.title}
                </label>
                <input
                  id="connector-tenant"
                  className="settings-input"
                  value={tenant}
                  disabled={busy}
                  placeholder={defaults.remoteUserConfig?.placeholder}
                  maxLength={253}
                  onChange={(event) => {
                    setTenant(event.target.value);
                    changeUrl(
                      templateConnectorUrl(defaults, event.target.value),
                    );
                  }}
                />
                <p className="connector-wizard-hint">
                  {defaults.remoteUserConfig?.description}
                </p>
                <input
                  id="connector-url"
                  className="settings-input"
                  value={url}
                  readOnly
                />
              </>
            ) : (
              <input
                id="connector-url"
                className="settings-input"
                inputMode="url"
                maxLength={2048}
                placeholder={t("MCP server URL")}
                value={url}
                disabled={busy}
                aria-describedby="connector-url-hint"
                aria-invalid={!!url && !!urlError}
                onChange={(event) => changeUrl(event.target.value)}
              />
            )}
            <p id="connector-url-hint" className="connector-wizard-hint">
              The HTTPS address where the server accepts MCP requests, for
              example https://mcp.example.com/mcp.
            </p>
            {url && urlError && (
              <p className="error-text" role="alert">
                {t(urlError)}
              </p>
            )}
            {transport === "sse" && (
              <p className="settings-callout" role="status">
                This connector will use SSE transport, which is being
                deprecated. If you maintain this server, consider switching to
                streamable HTTP. You can change transport under Advanced on the
                next step.
              </p>
            )}
          </>
        ) : (
          <>
            <p>{name.trim()}</p>
            <p className="connector-wizard-hint">
              {formatText("Connects to {host}", {
                host: new URL(url.trim()).host,
              })}
            </p>
            <label>Authentication</label>
            <p>{authRequired ? "Sign in now" : "No sign-in"}</p>
          </>
        )}
        {(step === 2 || editingServer) && (
          <>
            <button
              type="button"
              className="desktop-connector-advanced"
              aria-expanded={advanced}
              disabled={busy}
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
              Advanced settings
            </button>
            {advanced && (
              <div className="connector-wizard-fields">
                <label htmlFor="connector-transport">Transport</label>
                <select
                  id="connector-transport"
                  className="settings-input"
                  value={transport}
                  disabled={busy}
                  onChange={(event) =>
                    setTransport(
                      event.target.value as "sse" | "streamable-http",
                    )
                  }
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE (legacy)</option>
                </select>
                <input
                  aria-label={t("OAuth client ID (optional)")}
                  className="settings-input"
                  placeholder={t("OAuth client ID (optional)")}
                  autoComplete="off"
                  maxLength={4096}
                  value={clientId}
                  disabled={busy || !!editingServer}
                  onChange={(event) => setClientId(event.target.value)}
                />
                {editingServer && (
                  <p className="connector-wizard-hint">
                    Delete and re-add connectors to edit custom OAuth Client
                    IDs.
                  </p>
                )}
                <input
                  aria-label={t("OAuth client secret (optional)")}
                  className="settings-input"
                  type="password"
                  placeholder={t("OAuth client secret (optional)")}
                  autoComplete="new-password"
                  maxLength={4096}
                  value={clientSecret}
                  disabled={busy || !!editingServer}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
                {editingServer && (
                  <p className="connector-wizard-hint">
                    Delete and re-add connectors to edit custom OAuth Client
                    Secrets.
                  </p>
                )}
              </div>
            )}
          </>
        )}
        <p className="connector-wizard-trust">
          Only use connectors from developers you trust. Claudex does not
          control which tools developers make available and cannot verify that
          they will work as intended or that they won’t change.
        </p>
        <p className="connector-wizard-builder">
          <span>Building an MCP server?</span>{" "}
          <a href={helpUrl("support")} target="_blank" rel="noreferrer">
            Report issues and subscribe to updates here
          </a>
        </p>
        {error && (
          <p className="error-text" role="alert">
            {t(error)}
          </p>
        )}
        <div className="button-row">
          {step === 2 && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setStep(1);
                setError("");
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (owner.current()) onClose();
            }}
          >
            Cancel
          </button>
          <button
            className={`primary ${busy ? "busy" : ""}`}
            disabled={!ready || busy}
            aria-busy={busy}
          >
            <span className="busy-label">
              {editingServer ? "Update" : step === 1 ? "Continue" : "Add"}
            </span>
            {busy && <Spinner inheritColor size="sm" className="spin" />}
          </button>
        </div>
      </form>
    </SettingsModal>
  );
}
