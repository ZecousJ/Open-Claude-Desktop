import {
  capabilityPreferenceSettings,
  officialCapabilityPreferenceSchema,
} from "../../../shared/official-capability-preferences";
import { preference } from "../../../shared/settings-extras";
import type { AdapterContext } from "./context";

export function officialCapabilityPreferences(ctx: AdapterContext) {
  const settings = ctx.settings();
  return {
    enabled_wiggle_egress: preference(settings, "networkEgress"),
    wiggle_egress_hosts_template: (
      {
        none: "custom",
        packages: "package_managers",
        all: "full_egress",
      } as const
    )[preference(settings, "egressAllowlist")],
    wiggle_egress_allowed_hosts: preference(settings, "egressDomains"),
    enabled_turmeric: preference(settings, "aiArtifacts"),
    enabled_geolocation: preference(settings, "locationMetadata"),
    tool_search_mode:
      preference(settings, "toolAccessMode") === "loaded" ? "off" : "on",
    enabled_connector_suggestions: preference(settings, "connectorSearch"),
    enabled_web_search: preference(settings, "chatWebSearch"),
    enabled_monkeys_in_a_barrel: preference(settings, "chatExecution"),
    preview_feature_uses_artifacts: preference(settings, "artifacts"),
    enabled_artifacts_attachments: false,
  };
}

export async function saveOfficialCapabilityPreference(
  ctx: AdapterContext,
  body: unknown,
) {
  const failed = (status: number, message: string) => ({
    status,
    body: { type: "error", error: { type: "invalid_request_error", message } },
  });
  const parsed = officialCapabilityPreferenceSchema.safeParse(body);
  if (!parsed.success) return failed(400, "Invalid capability preference.");
  if (ctx.readOnly || !ctx.localCall)
    return failed(
      403,
      "Capability preference changes are unavailable on this host.",
    );
  let owner: string | undefined, activation: unknown;
  try {
    owner = ctx.account()?.id;
    activation = ctx.sessionIdentity?.();
  } catch {
    return failed(409, "The account activation changed. Reopen settings.");
  }
  if (!owner) return failed(401, "Sign in to change capability preferences.");
  const current = () => {
    try {
      return (
        activation != null &&
        activation !== "" &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === activation &&
        ctx.isCurrent?.() === true
      );
    } catch {
      return false;
    }
  };
  if (!current())
    return failed(409, "The account activation changed. Reopen settings.");
  const wire = parsed.data;
  const patch = capabilityPreferenceSettings(wire);
  try {
    const settings = ctx.settings();
    if (!current())
      return failed(409, "The account activation changed. Reopen settings.");
    if (
      "preview_feature_uses_artifacts" in wire &&
      !("enabled_monkeys_in_a_barrel" in wire) &&
      !wire.preview_feature_uses_artifacts &&
      preference(settings, "chatExecution")
    )
      return failed(409, "Disable code execution before changing Artifacts.");
    const already = Object.entries(patch).every(
      ([key, value]) =>
        JSON.stringify(preference(settings, key as keyof typeof patch)) ===
        JSON.stringify(value),
    );
    if (!already)
      await ctx.localCall("saveSettings", { ...settings, ...patch });
    if (!current())
      return failed(409, "The account activation changed. Reopen settings.");
    const actual = officialCapabilityPreferences(ctx);
    if (
      !Object.entries(wire).every(
        ([key, value]) =>
          JSON.stringify(actual[key as keyof typeof actual]) ===
          JSON.stringify(value),
      )
    )
      return failed(
        409,
        "Settings changed while saving. Reload to confirm the result.",
      );
    return { status: 200, body: wire };
  } catch {
    return current()
      ? failed(
          503,
          "The preference could not be confirmed. Reload settings before retrying.",
        )
      : failed(409, "The account activation changed. Reopen settings.");
  }
}
