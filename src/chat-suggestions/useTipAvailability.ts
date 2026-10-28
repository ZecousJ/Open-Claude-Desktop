import { useContext, useEffect, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { MemoryStatus } from "../../shared/memory-api";
import {
  eligibleCapabilityTips,
  tipAvailability,
} from "../../shared/capability-tips";
import { useHost } from "../host/HostContext";
import { AppContext } from "../app/AppContext";

/** The capability tips this window can offer; none outside the app (the phone surface). */
export function useTipAvailability(conversation?: Conversation) {
  const app = useContext(AppContext);
  const host = useHost();
  const [memory, setMemory] = useState<MemoryStatus>();
  useEffect(() => {
    if (!app) return;
    let disposed = false;
    const read = () => {
      void window.desktop
        .memoryStatus()
        .then((status) => {
          if (!disposed) setMemory(status);
        })
        .catch(() => {});
    };
    read();
    const stop = window.desktop.onEvent((event) => {
      if (event.type === "memory-changed") read();
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [app?.accountId]);
  if (!app) return [];
  return eligibleCapabilityTips(
    conversation ?? { incognito: false, projectId: app.projectId, turns: [] },
    app.snapshot?.settings ?? {},
    {
      ...tipAvailability(
        host.capabilities,
        app.snapshot?.projects.some((project) => !project.archivedAt) ?? false,
      ),
      scheduledTasks:
        host.capabilities.scheduledTasks &&
        app.policy?.scheduledTasks.enabled !== false,
      incognito: app.policy?.incognito,
      fileUploads: app.policy?.attachments.types.length !== 0,
      screenshots: app.policy?.attachments.types.some((type) =>
        ["png", "jpg", "jpeg", "webp", "gif"].includes(type),
      ),
      memory,
    },
  );
}
