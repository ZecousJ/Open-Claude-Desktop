import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { AuthStatus, Protocol } from "../../shared/types";
import { useT } from "../i18n";
import { KnotShape } from "../ui/Star";
import { SignInFrame } from "./SignInFrame";
import "./local-provider-setup.css";

export function LocalProviderSetup({
  theme,
  onConnected,
}: {
  theme: AuthStatus["localSetupTheme"];
  onConnected: (status: AuthStatus) => void;
}) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const modelField = useId();
  const discovery = useRef({ attempted: false, pending: false });
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [manual, setManual] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>("responses");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    return window.desktop.onEvent(event => {
      if (event.type === "local-setup-theme") root.dataset.theme = event.theme;
    });
  }, [theme]);

  const canDiscover = /^https?:\/\//i.test(baseUrl.trim()) && Boolean(apiKey.trim());

  function resetDiscovery() {
    discovery.current = { attempted: false, pending: false };
    setModels([]);
    setDiscovering(false);
    setDiscoveryError("");
    if (!manual) setModel("");
  }

  async function discover(force = false) {
    const read = discovery.current;
    if (!canDiscover || read.pending || (read.attempted && !force)) return;
    read.attempted = true;
    read.pending = true;
    setDiscovering(true);
    setDiscoveryError("");
    try {
      const ids = await window.desktop.discoverLocalModels({ baseUrl, apiKey, protocol });
      if (discovery.current !== read) return;
      if (ids.length) {
        setModels(ids);
        setModel(current => current || ids[0]);
      } else {
        setDiscoveryError("No models returned by the channel.");
      }
    } catch (error) {
      if (discovery.current === read) {
        setDiscoveryError(error instanceof Error
          ? error.message.replace(/^Error invoking remote method .*?: Error: /, "")
          : "Could not fetch models from this channel.");
      }
    } finally {
      read.pending = false;
      if (discovery.current === read) setDiscovering(false);
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      onConnected(await window.desktop.setupLocalProvider({ baseUrl, apiKey, model, protocol }));
    } catch (error) {
      const reason = error instanceof Error
        ? error.message.replace(/^Error invoking remote method .*?: Error: /, "")
        : "";
      setError(t(reason || "Could not save the connection."));
    } finally {
      setPending(false);
    }
  }

  return (
    <SignInFrame
      title={t("Connect your model")}
      step="local-provider"
      lead={
        <span className="local-provider-brand">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <KnotShape cx={16} cy={16} size={27} stroke={2} />
          </svg>
          <span>Claudex Local</span>
        </span>
      }
    >
      <form onSubmit={connect} className="local-provider-form">
        <label>{t("Request URL")}
          <input className="signin-input" type="url" autoComplete="url" value={baseUrl}
            onChange={event => { setBaseUrl(event.target.value); resetDiscovery(); }}
            onBlur={() => void discover()} placeholder="https://example.com/v1" required />
        </label>
        <label>{t("API key")}
          <input className="signin-input" type="password" value={apiKey}
            onChange={event => { setApiKey(event.target.value); resetDiscovery(); }}
            onBlur={() => void discover()} autoComplete="new-password" required />
        </label>
        <div className="local-provider-model">
          <div className="local-provider-model-field">
            <div className="local-provider-model-heading">
              <label htmlFor={modelField}>{t("Default model")}</label>
              <button type="button" className="signin-link local-provider-discover"
                onClick={() => void discover(true)} disabled={!canDiscover || discovering || pending}>
                {t(discovering ? "Fetching models" : "Fetch models")}
              </button>
            </div>
            {models.length > 0 && (
              <select id={modelField} className="signin-input" value={!manual && models.includes(model) ? model : ""}
                onChange={event => { setManual(!event.target.value); setModel(event.target.value); }}>
                {models.map(id => <option key={id} value={id}>{id}</option>)}
                <option value="">{t("Enter model ID")}</option>
              </select>
            )}
            {(!models.length || manual || !models.includes(model)) && (
              <input className="signin-input" id={models.length ? undefined : modelField}
                aria-label={models.length ? t("Enter model ID") : undefined} value={model}
                onChange={event => { setManual(true); setModel(event.target.value); }}
                onFocus={() => void discover()} placeholder="model-id" />
            )}
          </div>
          <label>{t("API protocol")}
            <select className="signin-input" value={protocol} onChange={event => setProtocol(event.target.value === "chat" ? "chat" : "responses")}>
              <option value="responses">Responses</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
        </div>
        {discoveryError && <p role="status" className="signin-error">{t(discoveryError)}</p>}
        {error && <p role="alert" className="signin-error">{error}</p>}
        <button className="signin-primary" type="submit" disabled={pending}>
          {t(pending ? "Saving…" : "Open workspace")}
        </button>
      </form>
    </SignInFrame>
  );
}
