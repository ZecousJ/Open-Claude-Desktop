import type { Approval } from "./types";

export interface TaskConnectionHold {
  service: string;
  url?: string;
}

export const taskConnectionHoldMessage =
  "This task is on hold because a service it uses needs you to connect your account.";

// Connection recovery.
export function taskConnectionRequest(
  approval: Pick<Approval, "method" | "params">,
  servers: Record<string, unknown>,
): TaskConnectionHold | undefined {
  if (
    approval.method !== "mcpServer/elicitation/request" ||
    approval.params?.mode !== "url"
  )
    return;
  const service =
    typeof approval.params.serverName === "string"
      ? approval.params.serverName
      : "";
  let url: string | undefined;
  try {
    const parsed = new URL(approval.params.url);
    const server = servers[service] as { url?: string } | undefined;
    const configured = server?.url ? new URL(server.url) : undefined;
    if (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      configured?.host === parsed.host
    )
      url = parsed.href;
  } catch {}
  return { service, ...(url ? { url } : {}) };
}
