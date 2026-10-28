import { helpUrl } from "../../../shared/help-links";
import { useState } from "react";
import { X } from "../../ui/glyphs";
import {
  taskPermissions,
  type TaskPermission,
} from "../../../shared/settings-extras";
import type { RoutineAllowed } from "../../../shared/routines";
import { windowPermissionText } from "../../composer/TaskPermissionPicker";
import { t } from "../../i18n";
import "../../composer/task-permission-notice.css";
import "./routine-permission.css";

/** Permission notices. */
export function RoutinePermissionNotice({
  permission,
}: {
  permission: TaskPermission;
}) {
  if (permission !== "auto" && permission !== "bypass") return null;
  return (
    <div
      role="status"
      data-testid={
        permission === "auto" ? "routine-auto-notice" : "routine-skip-notice"
      }
      className={`permission-mode-notice ${permission === "bypass" ? "warning" : "neutral"}`}
    >
      <div>
        {permission === "auto"
          ? "For this task, Claudex will work and use connectors without pausing for approval."
          : "For this task, Claudex never pauses, even for unsafe actions."}{" "}
        <a
          href={helpUrl("cowork-safety")}
          onClick={(event) => {
            event.preventDefault();
            void window.desktop.openExternal(event.currentTarget.href);
          }}
        >
          See safe use tips
        </a>
      </div>
    </div>
  );
}

/** A routine's permission mode in the original's words. */
export const permissionRows = taskPermissions.map((value) => ({
  value,
  label: windowPermissionText[value].label,
  description: windowPermissionText[value].description,
}));

/** The mode's name for a closed select. */
export const permissionLabel = (value: TaskPermission) =>
  windowPermissionText[value].label;

/** Said when the administrator has turned Auto off and the routine is on it. */
export const autoOffMessage =
  "Your organization turned off Auto mode. Set Permission to Manual to save these changes.";

/** "Run command (npm test)": one kept approval as the original's list names it. */
export const allowedLabel = (entry: RoutineAllowed) =>
  entry.pattern ? `${t(entry.tool)} (${entry.pattern})` : t(entry.tool);

/** How many kept approvals show before "Show all". */
const shown = 3;

/**
 * "Always allowed": the approvals kept for the routine's later runs, each with
 * "Remove approval".
 */
export function AlwaysAllowed({
  items,
  onRemove,
  className,
}: {
  items: RoutineAllowed[];
  onRemove: (index: number) => void;
  className: string;
}) {
  const [all, setAll] = useState(false);
  const visible = all ? items : items.slice(0, shown);
  return (
    <div className={className}>
      <span className="always-allowed-title">Always allowed</span>
      {items.length ? (
        <ul className="always-allowed-list">
          {visible.map((entry, index) => (
            <li key={`${entry.kind}:${entry.tool}:${entry.pattern ?? ""}`}>
              <span title={allowedLabel(entry)}>{allowedLabel(entry)}</span>
              {entry.expired && (
                <span className="routine-approval-expired">Expired</span>
              )}
              <button
                type="button"
                aria-label="Remove approval"
                title="Remove approval"
                onClick={() => onRemove(index)}
              >
                <X size={12} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="always-allowed-empty">
          Approvals you grant during a run appear here.
        </p>
      )}
      {items.length > shown && (
        <button
          type="button"
          className="always-allowed-more"
          onClick={() => setAll(!all)}
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
