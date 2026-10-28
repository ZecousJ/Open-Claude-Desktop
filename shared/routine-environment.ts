import type { EnvironmentRef } from "./types";
/** Preserve execution identity without importing a server validator into the UI. */
export function routineEnvironment(value: unknown): EnvironmentRef | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid task environment.");
  const data = value as Record<string, unknown>;
  if (data.kind === "local" && Object.keys(data).length === 1)
    return { kind: "local" };
  if (
    data.kind === "ssh" &&
    Object.keys(data).length === 2 &&
    typeof data.hostId === "string" &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(data.hostId)
  )
    return { kind: "ssh", hostId: data.hostId };
  if (
    data.kind === "space" &&
    Object.keys(data).length === 2 &&
    typeof data.spaceId === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/.test(data.spaceId)
  )
    return { kind: "space", spaceId: data.spaceId };
  throw new Error("Invalid task environment.");
}

export function routineEnvironmentKey(environment?: EnvironmentRef): string {
  return !environment || environment.kind === "local"
    ? "local"
    : environment.kind === "ssh"
      ? `ssh:${environment.hostId}`
      : `space:${environment.spaceId}`;
}
