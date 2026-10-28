import { Cloud, Monitor } from "../../ui/glyphs";
import { formatText, t } from "../../i18n";
import type { Routine } from "../../../shared/routines";
import { routineHostOf } from "./routine-list";

/** O16 c73d5fa6d Pn/Fn: identity is distinct from current connectivity.
 * Cloud Chat cards in the captured web branch have no computer badge. */
export function RoutineComputerBadge({
  routine,
  showCloud = false,
}: {
  routine: Routine;
  showCloud?: boolean;
}) {
  const host = routineHostOf(routine);
  if (host === "cloud")
    return showCloud ? (
      <span className="routine-location-chip">
        <Cloud size={12} aria-hidden="true" />
        Cloud
      </span>
    ) : null;
  const device = routine.listMetadata?.device;
  if (!host && routine.executionLocation !== "local" && !device) return null;
  const knownName = device?.name?.trim();
  const text =
    host === "this-computer"
      ? "This computer"
      : host === "local-only"
        ? "Only on this computer"
        : knownName || (device?.id ? "Your computer" : "Unknown computer");
  const label = knownName
    ? formatText("Runs on {host}", { host: knownName })
    : t(text);
  const connectivity = device?.connectivity;
  const connectionLabel =
    connectivity === "connected"
      ? t("Connected")
      : connectivity === "offline"
        ? t("Asleep or app closed")
        : undefined;
  const description = connectionLabel ? `${label} · ${connectionLabel}` : label;
  return (
    <span
      className="routine-location-chip routine-computer"
      role="img"
      aria-label={description}
      title={description}
    >
      <Monitor size={12} aria-hidden="true" />
      {connectionLabel && (
        <span
          className="routine-connectivity-dot"
          data-connectivity={connectivity}
          aria-hidden="true"
        />
      )}
      <span
        className="routine-computer-name"
        {...(knownName && text === knownName
          ? { "data-no-translate": true }
          : {})}
      >
        {knownName && text === knownName ? text : t(text)}
      </span>
    </span>
  );
}
