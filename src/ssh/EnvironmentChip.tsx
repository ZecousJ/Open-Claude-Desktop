import { SquareTerminal } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { SshHost, SshStatus } from "../../shared/ssh-api";
import { LaptopIcon } from "../ui/icons";
import { errorExplanation, hostAddress, isBusy } from "./model";

/**
 * The environment chip's icon and label (design 5.1): the laptop and
 * "Local", or a server and the host's name. While connecting a 12px
 * spinner takes the icon's place; an error adds a 6px red dot and says why
 * in the tooltip. No capture shows an SSH chip, so its states are
 * provisional.
 */
export function EnvironmentChipContent({
  host,
  status,
  localLabel = "Local",
}: {
  host?: SshHost;
  status?: SshStatus;
  localLabel?: string;
}) {
  if (!host)
    return (
      <>
        <LaptopIcon />
        <span>{localLabel}</span>
      </>
    );
  return (
    <>
      <span className="ssh-chip-icon">
        {isBusy(status) ? (
          <Spinner inheritColor size={12} className="spin" label="Connecting" />
        ) : (
          <SquareTerminal size={16} aria-hidden="true" />
        )}
        {status?.state === "error" && (
          <span className="ssh-chip-error" aria-label="Offline" />
        )}
      </span>
      <span>{host.label}</span>
    </>
  );
}

/** The chip's tooltip: the host's address, and why it is offline. */
export function environmentChipTitle(host?: SshHost, status?: SshStatus) {
  if (!host) return undefined;
  if (status?.state === "error")
    return `${hostAddress(host)} — ${status.code === "host-not-allowed" ? status.message : errorExplanation(status.code, host.label)}`;
  return hostAddress(host);
}
