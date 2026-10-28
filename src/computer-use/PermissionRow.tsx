import type {
  ComputerUsePermissionKind,
  ComputerUsePermissionState,
} from "../../shared/computer-use-api";
import { Button, Row } from "../settings/controls";

/** The original's words for a permission. */
const statusLabels: Record<
  Exclude<ComputerUsePermissionState, "restart-required">,
  string
> = {
  granted: "Granted",
  denied: "Denied",
  "not-determined": "Not requested",
};

/**
 * A status badge (neutral, or danger when denied) and, until it is granted,
 * Open System Settings. A permission that macOS has not asked about yet is
 * asked for first, so the app shows in the list; one that needs the app to
 * start again offers Restart.
 */
export function PermissionRow({
  kind,
  label,
  status,
  attention,
  onError,
}: {
  kind: ComputerUsePermissionKind;
  label: string;
  status: ComputerUsePermissionState;
  attention: boolean;
  onError: (error: unknown) => void;
}) {
  return (
    <div
      className="cu-permission"
      data-attention={(attention && status !== "granted") || undefined}
    >
      <Row
        label={label}
        description={
          status === "restart-required"
            ? "Restart Claudex to finish turning this on."
            : undefined
        }
      >
        {status === "restart-required" ? (
          <Button
            onClick={() =>
              void window.desktop.relaunchForPermissions().catch(onError)
            }
          >
            Restart
          </Button>
        ) : (
          <span className="cu-permission-control">
            <span
              className="cu-status"
              data-variant={status === "denied" ? "danger" : undefined}
            >
              {statusLabels[status]}
            </span>
            {status !== "granted" && (
              <Button
                onClick={() =>
                  void (
                    status === "not-determined"
                      ? window.desktop.requestComputerUsePermission(kind)
                      : window.desktop.openComputerUsePermissionSettings(kind)
                  ).catch(onError)
                }
              >
                Open System Settings
              </Button>
            )}
          </span>
        )}
      </Row>
    </div>
  );
}
