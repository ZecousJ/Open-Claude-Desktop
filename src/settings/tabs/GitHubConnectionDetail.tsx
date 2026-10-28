import { useContext, useEffect, useRef, useState } from "react";
import type { GitHubStatus } from "../../../shared/github-api";
import { api } from "../../desktop-api";
import { AppContext } from "../../app/AppContext";
import { GithubMark } from "../../ui/GithubMark";
import { chooseCodeRepository } from "../../composer/code-repository";
import { AppIcon } from "../../ui/app-icon";
import { notifyGitHubConnectionChanged } from "../../github/connection-events";
import { useHost } from "../../host/HostContext";
import { formatText, useT } from "../../i18n";
import { ArrowLeft } from "../../ui/glyphs";
import { Button } from "../controls";
import "./github-connection-detail.css";

/** The account card is grounded in c08e79e85:610–692. The service exposes
 * OAuth status/connect/disconnect, not Anthropic GitHub App installations. */
export function GitHubConnectionDetail({ onBack }: { onBack: () => void }) {
  const t = useT(),
    host = useHost();
  const accountId = useContext(AppContext)?.accountId;
  const [status, setStatus] = useState<GitHubStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0),
    mounted = useRef(false),
    acting = useRef(false);
  const fail = (error: unknown) =>
    error instanceof Error
      ? error.message
      : t("Something went wrong. Try again.");
  const refresh = async () => {
    if (acting.current) return;
    const request = ++generation.current;
    try {
      const next = await api.githubStatus();
      if (mounted.current && request === generation.current) {
        setStatus(next);
        setError(undefined);
      }
    } catch (error) {
      if (mounted.current && request === generation.current)
        setError(fail(error));
    }
  };
  useEffect(() => {
    mounted.current = true;
    acting.current = false;
    setBusy(false);
    setStatus(undefined);
    setError(undefined);
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      generation.current++;
      window.removeEventListener("focus", focus);
    };
  }, [accountId]);
  const act = async () => {
    if (acting.current || !status?.configured) return;
    acting.current = true;
    setBusy(true);
    setError(undefined);
    const request = ++generation.current;
    try {
      if (status.connected) {
        const next = await api.githubDisconnect();
        if (mounted.current && request === generation.current) {
          setStatus(next);
          if (!next.connected) chooseCodeRepository(undefined);
          notifyGitHubConnectionChanged();
        }
      } else {
        const { authorizeUrl } = await api.githubConnect();
        if (!mounted.current || request !== generation.current) return;
        if (host.kind === "desktop") await api.openExternal(authorizeUrl);
        else window.location.assign(authorizeUrl);
      }
    } catch (error) {
      if (mounted.current && request === generation.current)
        setError(fail(error));
    } finally {
      if (request === generation.current) {
        acting.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };
  return (
    <section
      className="github-connection-page"
      aria-labelledby="github-connection-heading"
    >
      <nav>
        <a
          className="github-connection-back"
          href="/customize/connectors/yours"
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            onBack();
          }}
        >
          <ArrowLeft size={16} />
          {t("Your connectors")}
        </a>
      </nav>
      <header>
        <GithubMark size={32} />
        <h2 id="github-connection-heading">{t("GitHub Integration")}</h2>
      </header>
      <p>
        {t(
          "Connect your GitHub account to use repositories in cloud Code sessions.",
        )}
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button onClick={() => void refresh()} disabled={busy}>
            {t("Try again")}
          </Button>
        </p>
      )}
      {!status ? (
        !error && <p role="status">{t("Loading…")}</p>
      ) : !status.configured ? (
        <p role="status">{t("GitHub isn't set up on this service")}</p>
      ) : (
        <div className="github-connection-account">
          <div className="github-connection-account-identity">
            {status.connected && (
              <AppIcon
                name="CheckCircleFilled"
                size={24}
                className="github-connection-success"
              />
            )}
            <div role="status">
              <strong>
                {t(
                  status.connected
                    ? "GitHub account connected"
                    : "GitHub account not connected",
                )}
              </strong>
              {status.connected && status.login && (
                <small data-no-translate>
                  {formatText("Signed in as @{login}", { login: status.login })}
                </small>
              )}
            </div>
          </div>
          <Button onClick={() => void act()} disabled={busy}>
            {t(
              busy
                ? status.connected
                  ? "Disconnecting…"
                  : "Connecting…"
                : status.connected
                  ? "Disconnect"
                  : "Connect GitHub",
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
