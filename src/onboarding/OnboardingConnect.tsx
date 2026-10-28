import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUp, Check } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { formatText, t } from "../i18n";
import { Star } from "../ui/Star";
import { Modal } from "../ui/Controls";
import { useHostCapability } from "../host/HostContext";
import { usePolicy } from "../policy/PolicyContext";
import { connectorAllowed } from "../../shared/client-policy-rules";
import {
  hearAboutPlatforms,
  hearAboutSources,
  type HearAboutPlatform,
  type HearAboutSource,
  type OnboardingAnswers,
} from "../../shared/onboarding-api";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { shuffledWithOtherLast } from "./onboarding-steps";
import "./onboarding.css";
import { connected, Chip, StepPage } from "./OnboardingSteps";

/**
 * "Connect your work tools": the person's connectors with Connect where one
 * needs signing in, "Browse all connectors" (Settings ▸ Connectors), and
 * Continue, which asks first when nothing is connected. Connect is the real
 * sign-in of Settings ▸ Connectors (the runtime's OAuth in the browser).
 */
export function ConnectStep({
  onOpenConnectors,
  onContinue,
}: {
  onOpenConnectors: () => void;
  onContinue: (connected: string[]) => void;
}) {
  // Signing in is the desktop's (Settings ▸ Connectors offers Connect there
  // only, for a web address the administrator allows).
  const local = useHostCapability("localMcp");
  const policy = usePolicy();
  const connectable = (server: McpServerState) =>
    local &&
    !!server.url &&
    server.authStatus === "notLoggedIn" &&
    connectorAllowed(policy, server.name);
  const [servers, setServers] = useState<McpServerState[]>();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [asking, setAsking] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.resolve()
        .then(() => window.desktop.mcpServers())
        .then(
          (next) => live && setServers(next?.servers ?? []),
          () => live && setServers((current) => current ?? []),
        );
    void load();
    // A sign-in finishes in the browser: the list is read again while the
    // step is open, and when the settings or the runtime change.
    const timer = setInterval(load, 4000);
    const off = window.desktop.onEvent((event) => {
      if (event.type === "settings" || event.type === "engine") void load();
    });
    return () => {
      live = false;
      clearInterval(timer);
      off();
    };
  }, []);
  const rows = (servers ?? []).filter(
    (server) => connected(server) || connectable(server),
  );
  const names = rows.filter(connected).map((server) => server.name);
  const connect = async (name: string) => {
    setBusy(name);
    setFailed(undefined);
    try {
      await window.desktop.connectConnector(name);
    } catch {
      setFailed(name);
    } finally {
      setBusy(undefined);
    }
  };
  if (!servers)
    return (
      <StepPage title="Connect your work tools">
        <div className="onboarding-loading" role="status">
          <Spinner
            inheritColor
            size={20}
            className="onboarding-spin"
            aria-hidden="true"
          />
          <span className="sr-only">Loading</span>
        </div>
      </StepPage>
    );
  return (
    <StepPage
      title="Connect your work tools"
      subtitle="Connect the ones you use, and Claudex can work with them."
      cta={
        <button
          type="button"
          className="primary onboarding-wide"
          onClick={() => (names.length ? onContinue(names) : setAsking(true))}
        >
          Continue
        </button>
      }
    >
      <div className="onboarding-card onboarding-connectors">
        {rows.length > 0 && (
          <ul ref={list}>
            {rows.map((server) => (
              <li key={server.name} className="onboarding-connector">
                <div className="onboarding-connector-text">
                  <p className="onboarding-connector-name" data-no-translate>
                    {server.name}
                  </p>
                  {connected(server) ? (
                    <span className="onboarding-connected">
                      <Check size={12} strokeWidth={2} aria-hidden="true" />
                      Connected
                    </span>
                  ) : (
                    failed === server.name && (
                      <span className="onboarding-connector-error" role="alert">
                        {formatText(
                          "{name} can’t be connected here. You can add it later from Settings.",
                          { name: server.name },
                        )}
                      </span>
                    )
                  )}
                </div>
                {!connected(server) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== undefined}
                    aria-busy={busy === server.name}
                    onClick={() => void connect(server.name)}
                  >
                    {busy === server.name ? "Connecting…" : "Connect"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="onboarding-browse">
          Looking for something else?{" "}
          <button
            type="button"
            className="onboarding-link"
            onClick={onOpenConnectors}
          >
            Browse all connectors
          </button>
        </p>
      </div>
      {asking && (
        <Modal
          title={t("Continue without connecting a tool?")}
          variant="confirm"
          confirmFocus="confirm"
          onClose={() => setAsking(false)}
        >
          <p className="confirm-body">
            With a tool connected, you can ask Claudex about what’s in it, like
            an upcoming meeting, a shared document, or a recent thread. Without
            one, Claudex starts with none of your work context.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => onContinue([])}
            >
              Continue
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setAsking(false);
                const first =
                  list.current?.querySelector<HTMLButtonElement>("button");
                if (first) {
                  first.scrollIntoView({ block: "center" });
                  first.focus();
                } else onOpenConnectors();
              }}
            >
              Connect a tool
            </button>
          </div>
        </Modal>
      )}
    </StepPage>
  );
}

/**
 * "How did you get here?": written as a reply under the star, the answers as
 * chips in a shuffled order with Other last; Other asks "Tell us more…" with an
 * arrow to send, Social media asks "Which one?". Continue with nothing chosen
 * skips the question.
 */
export function HearStep({
  onContinue,
}: {
  onContinue: (answer?: OnboardingAnswers) => void;
}) {
  const sources = useMemo(() => shuffledWithOtherLast(hearAboutSources), []);
  const platforms = useMemo(
    () => shuffledWithOtherLast(hearAboutPlatforms),
    [],
  );
  const [source, setSource] = useState<HearAboutSource>();
  const [platform, setPlatform] = useState<HearAboutPlatform>();
  const [other, setOther] = useState("");
  const [platformOther, setPlatformOther] = useState("");
  const questionId = useId();
  const followId = useId();
  const submit = () => {
    if (!source) return onContinue();
    onContinue({
      hearAbout: source,
      hearAboutPlatform: source === "social_media" ? platform : undefined,
      hearAboutOther:
        source === "other"
          ? other.trim()
          : platform === "other"
            ? platformOther.trim()
            : undefined,
    });
  };
  return (
    <div className="onboarding-chat">
      <span className="onboarding-chat-star" aria-hidden="true">
        <Star size={40} />
      </span>
      <h1 id={questionId} tabIndex={-1} className="onboarding-question">
        How did you get here?
      </h1>
      <div
        className="onboarding-chips"
        role="group"
        aria-labelledby={questionId}
      >
        {sources.map((entry) => (
          <Chip
            key={entry.value}
            label={entry.label}
            pressed={source === entry.value}
            onClick={() => {
              setSource(entry.value);
              if (entry.value !== "social_media") {
                setPlatform(undefined);
                setPlatformOther("");
              }
            }}
          />
        ))}
      </div>
      {source === "other" ? (
        <div className="onboarding-other">
          <input
            type="text"
            autoFocus
            value={other}
            aria-label={t("Tell us more")}
            placeholder={t("Tell us more...")}
            maxLength={200}
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && other.trim()) submit();
            }}
          />
          <button
            type="button"
            className="primary onboarding-send"
            aria-label={t("Continue")}
            disabled={!other.trim()}
            onClick={submit}
          >
            <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="onboarding-chat-after">
          {source === "social_media" && (
            <>
              <p id={followId} className="onboarding-question">
                Which one?
              </p>
              <div
                className="onboarding-chips"
                role="group"
                aria-labelledby={followId}
              >
                {platforms.map((entry) => (
                  <Chip
                    key={entry.value}
                    label={entry.label}
                    pressed={platform === entry.value}
                    onClick={() => {
                      setPlatform(entry.value);
                      if (entry.value !== "other") setPlatformOther("");
                    }}
                  />
                ))}
              </div>
              {platform === "other" && (
                <input
                  type="text"
                  autoFocus
                  className="onboarding-other-field"
                  value={platformOther}
                  aria-label={t("Tell us more")}
                  placeholder={t("Tell us more...")}
                  maxLength={200}
                  onChange={(event) => setPlatformOther(event.target.value)}
                />
              )}
            </>
          )}
          <button
            type="button"
            className="primary onboarding-start"
            onClick={submit}
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
