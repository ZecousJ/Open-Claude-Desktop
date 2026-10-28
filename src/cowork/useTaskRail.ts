import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppController } from "../app/AppContext";
import type { HostInfo } from "../../shared/host";
import { taskRailContext, taskRailSessionSource } from "./task-rail-context";

export type TaskRailView = "tasks" | "activity";

/**
 * The source rail keeps its user view state above the current session. Routing
 * can hide it without choosing Close.
 */
export function useTaskRail(app: AppController, host: HostInfo) {
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const owner = useMemo(
    () => ({
      accountId: app.accountId,
      bridge,
      controllerScope: app.controllerScope,
    }),
    [app.accountId, bridge, app.controllerScope],
  );
  const context = taskRailContext({
    page: app.page,
    active: app.active,
    role: app.windowRole.kind,
    host: app.host ?? host,
    scheduledEnabled: app.policy.scheduledTasks.enabled,
  });
  const tasksAvailable = Boolean(
    context?.tasksAvailable &&
    bridge &&
    (typeof bridge.querySchedules === "function" ||
      typeof bridge.listSchedules === "function"),
  );
  const active = context?.active;
  const source = taskRailSessionSource(active);
  const generation = useRef(0);
  const lease = useMemo(
    () => ({
      owner,
      sessionId: active?.id,
      source,
      tasksAvailable,
      key: ++generation.current,
    }),
    [owner, active?.id, source, tasksAvailable],
  );
  const current = useRef<typeof lease | undefined>(lease);
  current.current = lease;
  useLayoutEffect(() => {
    current.current = lease;
    return () => {
      if (current.current === lease) current.current = undefined;
    };
  }, [lease]);
  const [preference, setPreference] = useState({
    owner,
    open: false,
    view: "tasks" as TaskRailView,
  });
  const visible =
    preference.owner === owner
      ? preference
      : { owner, open: false, view: "tasks" as TaskRailView };
  const isCurrent = () => {
    if (current.current !== lease || !active || window.desktop !== bridge)
      return false;
    const controller = app.currentController?.current;
    if (!app.currentController) return true;
    if (
      !controller ||
      controller.accountId !== owner.accountId ||
      controller.controllerScope !== owner.controllerScope
    )
      return false;
    const latestContext = taskRailContext({
      page: controller.page,
      active: controller.active,
      role: controller.windowRole.kind,
      host: controller.host ?? host,
      scheduledEnabled: controller.policy.scheduledTasks.enabled,
    });
    return Boolean(
      latestContext &&
      latestContext.active.id === active.id &&
      taskRailSessionSource(latestContext.active) === source &&
      Boolean(
        latestContext.tasksAvailable &&
        bridge &&
        (typeof bridge.querySchedules === "function" ||
          typeof bridge.listSchedules === "function"),
      ) === tasksAvailable,
    );
  };
  const update = (patch: Partial<Pick<typeof preference, "open" | "view">>) => {
    if (!isCurrent()) return;
    setPreference((previous) => ({
      ...(previous.owner === owner
        ? previous
        : { owner, open: false, view: "tasks" as TaskRailView }),
      ...patch,
    }));
  };
  return {
    context: context ? { ...context, tasksAvailable } : undefined,
    open: visible.open,
    view: visible.view,
    lease,
    isCurrent,
    toggle: () => {
      if (isCurrent())
        setPreference((previous) => ({
          ...(previous.owner === owner
            ? previous
            : { owner, view: "tasks" as TaskRailView }),
          open: previous.owner === owner ? !previous.open : true,
        }));
    },
    close: () => update({ open: false }),
    changeView: (view: TaskRailView) => update({ view }),
  };
}
