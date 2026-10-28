import { useEffect, useState } from "react";
import type { Conversation } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { useApp, type AppController } from "../app/AppContext";
import { api } from "../desktop-api";
import { useT } from "../i18n";
import { remoteControlCopy } from "./model";
import {
  dismissRemoteNotice,
  forgetRemoteDismissal,
  remoteNotice,
  setRemoteNotice,
  useRemoteNotice,
} from "./notices";
import { ReplyBanner } from "../transcript/ReplyBanner";
import "./remote-control.css";
import "../composer/auth-issue.css";

export async function changeRemoteControl(
  app: AppController,
  id: string,
  enable: boolean,
  retry = false,
) {
  forgetRemoteDismissal(id);
  try {
    if (enable && !preference(app.snapshot.settings, "remoteControl"))
      await app.updatePreference({ remoteControl: true });
    await api.updateConversation(id, { remoteControl: enable });
    if (!enable) {
      setRemoteNotice(id);
      return;
    }
    let status = await api.dispatchStatus(retry);
    // A link still opening has no answer yet: give it a moment.
    for (
      let waited = 0;
      waited < 10 &&
      status.signedIn !== false &&
      !status.local?.online &&
      !status.local?.cause;
      waited++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = await api.dispatchStatus();
    }
    setRemoteNotice(
      id,
      status.signedIn === false
        ? { kind: "connect_failed", cause: "sign_in" }
        : status.local?.online
          ? { kind: "on" }
          : {
              kind: "connect_failed",
              cause: status.local?.cause ?? "retry",
              retries: true,
            },
    );
  } catch {
    setRemoteNotice(
      id,
      !enable
        ? { kind: "disconnect_failed", cause: "retry" }
        : {
            kind: "connect_failed",
            cause: navigator.onLine ? "retry" : "network",
          },
    );
  }
}

/** How long a dropped link may take to come back before it is a failure. */
const offlineGraceMs = 10_000;
/** How long a link may take to open at all. */
const connectingGraceMs = 30_000;

/** Connection banners. */
export function RemoteControlNotice({
  conversation,
}: {
  conversation: Conversation;
}) {
  const notice = useRemoteNotice(conversation.id);
  const [busy, setBusy] = useState(false);
  const t = useT();
  const app = useApp();
  const on =
    preference(app.snapshot.settings, "remoteControl") &&
    !conversation.remoteControlOff;
  useEffect(() => {
    if (
      !on ||
      conversation.environment?.kind === "space" ||
      conversation.incognito
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let offlineSince: number | undefined;
    const refresh = async () => {
      try {
        const status = await api.dispatchStatus();
        if (!active) return;
        if (!status.local) return;
        const online = Boolean(status.local?.online);
        offlineSince = online ? undefined : (offlineSince ?? Date.now());
        // The link is still opening (no cause yet), or mending a dropped
        // connection, which it does within seconds: only a link that stays down
        // is a failure to show.
        const settling =
          !online &&
          status.signedIn !== false &&
          Date.now() - offlineSince! <
            (status.local.cause ? offlineGraceMs : connectingGraceMs);
        if (online) {
          // Back after a failure: the failure goes; "Remote Control is on now."
          // is for the person turning it on, not for a link that mended itself.
          const previous = remoteNotice(conversation.id);
          if (
            previous?.kind === "connect_failed" ||
            previous?.kind === "reconnect_failed"
          )
            setRemoteNotice(conversation.id);
        } else if (!settling)
          setRemoteNotice(
            conversation.id,
            status.signedIn === false
              ? { kind: "connect_failed", cause: "sign_in" }
              : {
                  kind: "connect_failed",
                  cause: status.local?.cause ?? "retry",
                  retries: true,
                },
          );
      } catch {}
      if (active) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [conversation.id, on]);
  if (!notice || (!on && notice.kind !== "disconnect_failed")) return null;
  const copy = remoteControlCopy(notice);
  const signIn = notice.kind === "connect_failed" && notice.cause === "sign_in";
  const retry =
    notice.kind === "disconnect_failed"
      ? notice.cause === "retry"
      : notice.kind === "connect_failed" &&
        (signIn
          ? Boolean(app.onSignOut)
          : notice.cause === "retry" || notice.cause === "network");
  return (
    <div
      className="remote-control-notice"
      data-variant={copy.warning ? "warning" : "neutral"}
    >
      <ReplyBanner
        mode="code"
        warning={copy.warning}
        actionAlign={copy.title ? "center" : "first-line"}
        onDismiss={() => dismissRemoteNotice(conversation.id)}
        disabledReason={
          busy
            ? t(
                notice.kind === "disconnect_failed"
                  ? "Turning off…"
                  : "Connecting…",
              )
            : undefined
        }
        buttons={
          retry
            ? [
                {
                  label: t(signIn ? "Sign in again" : "Try again"),
                  onClick: () => {
                    if (signIn) {
                      void app.onSignOut?.().catch(app.report);
                      return;
                    }
                    setBusy(true);
                    void changeRemoteControl(
                      app,
                      conversation.id,
                      notice.kind !== "disconnect_failed",
                      true,
                    ).finally(() => setBusy(false));
                  },
                },
              ]
            : []
        }
      >
        <span className="remote-control-copy">
          <span className="remote-control-title">{t(copy.title)}</span>
          {copy.body && <span>{t(copy.body)}</span>}
        </span>
      </ReplyBanner>
    </div>
  );
}

/** The per-session switch belongs in the session rail, not View options. */
export default function SessionRemoteControl({
  conversation,
}: {
  conversation: Conversation;
}) {
  const app = useApp();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const on =
    preference(app.snapshot.settings, "remoteControl") &&
    !conversation.remoteControlOff;
  return (
    <button
      className="rail-switch"
      type="button"
      role="switch"
      aria-label={t("Remote Control")}
      data-checked={on || undefined}
      aria-checked={on}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void changeRemoteControl(app, conversation.id, !on).finally(() =>
          setBusy(false),
        );
      }}
    >
      <span className="rail-switch-knob" />
    </button>
  );
}
