import { CoworkActiveList } from "./CoworkActiveList";
import { useContext } from "react";
import { AppContext } from "../app/AppContext";
import { useHost } from "../host/HostContext";
import { taskRailContext } from "./task-rail-context";
import { formatText } from "../i18n";
import "./cowork-active.css";
export default function CoworkActiveSection(
  props: Parameters<typeof CoworkActiveList>[0],
) {
  const app = useContext(AppContext);
  const host = useHost();
  const context =
    app &&
    taskRailContext({
      page: app.page,
      active: app.active,
      role: app.windowRole.kind,
      host: app.host ?? host,
      scheduledEnabled: app.policy.scheduledTasks.enabled,
    });
  return (
    <>
      {context && (
        <button
          type="button"
          className="cowork-open-tasks"
          onClick={() => window.dispatchEvent(new Event("claudex:tasks-panel"))}
        >
          {formatText("Tasks")}
        </button>
      )}
      <CoworkActiveList {...props} />
    </>
  );
}
