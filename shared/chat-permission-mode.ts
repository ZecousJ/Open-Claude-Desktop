import type { ClientPolicy } from "./client-policy";

export function availableChatPermissionModes(policy: Pick<ClientPolicy, "permissionModes">): ChatPermissionMode[] {
  const modes: ChatPermissionMode[] = [];
  if (policy.permissionModes.includes("manual")) modes.push("default");
  if (policy.permissionModes.includes("auto")) modes.push("auto");
  return modes;
}

export type ChatPermissionMode = "default" | "auto";

export function chatPermissionFromWire(value: unknown): ChatPermissionMode | undefined {
  return value === 1 ? "default" : value === 2 ? "auto" : undefined;
}

export function chatPermissionToWire(mode: ChatPermissionMode): number {
  return mode === "auto" ? 2 : 1;
}
