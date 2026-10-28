import type { ClientPolicy } from "../../shared/client-policy";
import type { SshHost } from "../../shared/ssh-api";
import { effectiveConfig } from "./ssh-config";

export function sshHostAllowed(
  hostname: string,
  allowlist?: readonly string[],
) {
  if (allowlist === undefined) return true;
  const host = hostname.replace(/^.*@/, "").toLowerCase();
  return allowlist.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "*") return true;
    if (!pattern.startsWith("*.")) return host === pattern;
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

export async function sshPolicyError(
  policy: Pick<ClientPolicy, "sshRemote" | "sshHostAllowlist">,
  host: Pick<SshHost, "destination" | "port">,
  program: string,
) {
  if (policy.sshRemote === false)
    return {
      code: "policy-disabled" as const,
      message:
        "SSH connections are disabled by your organization's managed settings.",
    };
  if (policy.sshHostAllowlist === undefined) return undefined;
  const config = await effectiveConfig(program, host.destination, host.port);
  const hostname = config?.hostname ?? host.destination.replace(/^.*@/, "");
  if (!sshHostAllowed(hostname, policy.sshHostAllowlist))
    return {
      code: "host-not-allowed" as const,
      message: `SSH host "${hostname}" is not allowed by your organization's managed settings.`,
    };
  return undefined;
}
