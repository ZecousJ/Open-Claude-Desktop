import type { Conversation } from "../../shared/types";
import type { HostInfo } from "../../shared/host";

/** An execution owner can change without changing the conversation ID. */
export function taskRailSessionSource(active?: Conversation) {
  const environment = active?.environment;
  return JSON.stringify([
    environment?.kind ?? "local",
    environment?.kind === "space"
      ? environment.spaceId
      : environment?.kind === "ssh"
        ? environment.hostId
        : undefined,
    Boolean(active?.linkedToComputer),
    active?.linkedComputerId,
  ]);
}

/** Source c1f04f7e1:6570–6595/6965–6984 is a task-session branch with
 * separate tasksAvailable/unifiedRail flags. An explicit legacy rail request
 * is not permission to project that branch onto every unified Chat. */
export function taskRailContext(input: {
  page: string;
  active?: Conversation;
  role: "main" | "conversation" | "project";
  host: HostInfo;
  scheduledEnabled: boolean;
}) {
  const { active, host } = input;
  if (
    input.role !== "main" ||
    input.page !== "chat" ||
    !active ||
    active.mode !== "cowork" ||
    active.incognito ||
    active.archived
  )
    return undefined;
  const supported =
    active.environment?.kind === "space"
      ? host.capabilities.cloudCowork
      : active.environment?.kind === "ssh"
        ? host.capabilities.ssh
        : host.capabilities.localFolders;
  if (!supported) return undefined;
  return {
    active,
    tasksAvailable: host.capabilities.scheduledTasks && input.scheduledEnabled,
  };
}
