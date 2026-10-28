import { useEffect, useRef } from "react";
import { useApp } from "./AppContext";
import { showToast } from "../ui/toast-store";
import { t } from "../i18n";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
/** Reuse the normal creation notice; never navigate away during the Chat turn. */
export function ScheduledTaskSetupReceipt() {
  const app = useApp();
  const taskId = app.active?.scheduledTaskSetup?.createdTaskId;
  const previous = useRef({
    owner: app.controllerScope,
    account: app.accountId,
    taskId,
    conversationId: app.activeId,
  });
  useEffect(() => {
    const old = previous.current;
    previous.current = {
      owner: app.controllerScope,
      account: app.accountId,
      taskId,
      conversationId: app.activeId,
    };
    if (
      !taskId ||
      old.taskId === taskId ||
      old.conversationId !== app.activeId ||
      old.owner !== app.controllerScope ||
      old.account !== app.accountId
    )
      return;
    const account = app.accountId,
      owner = app.controllerScope,
      bridge = window.desktop;
    showToast(t("Scheduled task created"), {
      action: {
        label: t("View task"),
        onSelect: () => {
          const now = app.currentController
            ? app.currentController.current
            : app;
          if (
            !now ||
            now.accountId !== account ||
            now.controllerScope !== owner ||
            window.desktop !== bridge
          )
            return;
          requestScheduleConfirmation({
            description: "",
            openRoutineId: taskId,
          });
          now.setPage("scheduled");
        },
      },
    });
  }, [taskId, app.activeId, app.accountId, app.controllerScope]);
  return null;
}
