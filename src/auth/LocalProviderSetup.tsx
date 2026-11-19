import { useLayoutEffect, useState, type FormEvent } from "react";
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
          <input className="signin-input" type="url" autoComplete="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" required />
        </label>
        <label>{t("API key")}
          <input className="signin-input" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" required />
        </label>
        <div className="local-provider-model">
          <label>{t("Model")}
            <input className="signin-input" value={model} onChange={event => setModel(event.target.value)} placeholder="model-id" required />
          </label>
          <label>{t("API protocol")}
            <select className="signin-input" value={protocol} onChange={event => setProtocol(event.target.value === "chat" ? "chat" : "responses")}>
              <option value="responses">Responses</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
        </div>
        {error && <p role="alert" className="signin-error">{error}</p>}
        <button className="signin-primary" type="submit" disabled={pending}>
          {t(pending ? "Saving…" : "Open workspace")}
        </button>
      </form>
    </SignInFrame>
  );
}
