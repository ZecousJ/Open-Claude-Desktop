import { useContext } from "react";
import { SquareTerminal } from "../ui/glyphs";
import { AppContext } from "../app/AppContext";
import { t } from "../i18n";
import { Spinner } from "../ui/Spinner";
import type { EnvironmentRef } from "../../shared/types";
import { bannerFor, sshHostId } from "./model";
import {
  connectSshHost,
  forgetHostKeyAndConnect,
  useSshHosts,
} from "./useSshHosts";

/**
 * The strip above an SSH conversation's composer while its host is not
 * connected (design 5.4): connecting, setting Claudex up on the host with
 * a 2px progress line, reconnecting, a sign-in button when ssh needs a
 * password, or why the host can't be reached with Try again. Nothing shows
 * for a local conversation or a connected host. Not captured; it takes the
 * Code usage banner's strip (40px, #212121, radius 10).
 */
export function ReconnectBanner({
  environment,
}: {
  environment?: EnvironmentRef;
}) {
  const ssh = useSshHosts();
  const app = useContext(AppContext);
  const hostId = sshHostId(environment);
  if (!hostId || !ssh.ready || !ssh.loaded) return null;
  const host = ssh.hosts.find((h) => h.id === hostId);
  const label = host?.label ?? t("this host");
  const view = host
    ? bannerFor(ssh.statuses[hostId], label)
    : {
        text: "This session's SSH connection was removed from Settings.",
        busy: false,
        error: true,
      };
  if (!view) return null;
  return (
    <div
      className={`ssh-banner ${view.error ? "error" : ""}`}
      role="status"
      aria-live="polite"
    >
      {view.busy ? (
        <Spinner inheritColor size={14} className="spin" />
      ) : (
        <SquareTerminal size={16} aria-hidden="true" />
      )}
      <span className="ssh-banner-text">{view.text}</span>
      {view.action && host && (
        <button
          className="ssh-banner-action"
          onClick={() => {
            if (view.action?.kind !== "forget-key") {
              void connectSshHost(host.id);
              return;
            }
            // Forgetting a key is asked about first: a changed key is
            // trusted only for a reinstalled or re-keyed machine.
            const forget = async () => {
              await forgetHostKeyAndConnect(host);
            };
            if (app)
              app.setConfirm({
                title: t("Remove the old key?"),
                body: t(
                  "Only do this if the machine was reinstalled or re-keyed. Otherwise the connection may not be to the host you expect.",
                ),
                confirm: t("Remove and try again"),
                danger: true,
                action: forget,
              });
            else void forget();
          }}
        >
          {view.action.label}
        </button>
      )}
      {view.progress !== undefined && (
        <span
          className="ssh-banner-progress"
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, view.progress)) * 100)}%`,
          }}
        />
      )}
    </div>
  );
}
