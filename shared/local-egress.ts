import { DEFAULT_TRUSTED_DOMAINS } from "./cloud-network-domains";
import { preference, type SettingsPreferences } from "./settings-extras";

/**
 * Settings → Capabilities → Allow network egress on this computer: what a
 * Chat's code may reach from the local sandbox.
 *
 * - off: no network (the sandbox as before);
 * - All domains: the sandbox's own network switch;
 * - None / Package managers only: a Codex permission profile that extends the
 *   workspace sandbox with Codex's network proxy, which lets through only the
 *   listed names. Codex matches `name` exactly and `*.name` for its subdomains
 *   only, so a package manager entry (the name and everything under it, as on
 *   the web runner) is both.
 */
export const egressProfileId = "claudex-egress";

/**
 * Codex's network proxy enforces the list on macOS and Linux. On Windows The
 * profile let an unlisted name through and HTTPS failed inside the sandbox
 * (schannel: no credentials), so Windows keeps Chat's code offline.
 */
export function localEgressSupported(platform: NodeJS.Platform) {
  return platform !== "win32";
}

export type LocalEgress =
  | { kind: "off" }
  | { kind: "all" }
  | { kind: "profile"; domains: Record<string, "allow"> };

export function localEgress(settings: SettingsPreferences): LocalEgress {
  if (!preference(settings, "networkEgress")) return { kind: "off" };
  const allowlist = preference(settings, "egressAllowlist");
  if (allowlist === "all") return { kind: "all" };
  const names = new Set<string>();
  if (allowlist === "packages")
    for (const name of DEFAULT_TRUSTED_DOMAINS) {
      names.add(name);
      names.add(`*.${name}`);
    }
  for (const name of preference(settings, "egressDomains"))
    names.add(name.trim().toLowerCase());
  names.delete("");
  return {
    kind: "profile",
    domains: Object.fromEntries(
      [...names].sort().map((name) => [name, "allow" as const]),
    ),
  };
}

/**
 * The config.toml entries the profile needs (written only while it is used:
 * a file with profiles must also name a default, and the proxy is a feature).
 */
export function egressProfileConfig(egress: LocalEgress) {
  if (egress.kind !== "profile") return {};
  return {
    default_permissions: ":workspace",
    features: { network_proxy: true },
    permissions: {
      [egressProfileId]: {
        extends: ":workspace",
        network: { enabled: true, domains: egress.domains },
      },
    },
  };
}
