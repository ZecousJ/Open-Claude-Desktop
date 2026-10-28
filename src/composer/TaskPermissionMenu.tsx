import type { ComponentProps } from "react";
import { Menu } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import "./task-permission-menu.css";

/** Current web popup; its rules arrive with this on-demand menu. */
export function TaskPermissionMenu(props: ComponentProps<typeof Menu>) {
  const entries = props.entries.map((entry) =>
    "checked" in entry && entry.checked
      ? {
          ...entry,
          icon: (
            <AppIcon
              name="Check"
              size={20}
              bold
              className="task-permission-check"
            />
          ),
        }
      : entry,
  );
  return (
    <Menu {...props} entries={entries} className="task-permission-web-chat" />
  );
}
