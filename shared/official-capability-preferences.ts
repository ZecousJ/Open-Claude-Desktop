import { z } from "zod";
import { preferenceFields } from "./settings-extras-schema";
import type { OfficialUiReadRequest } from "./official-ui-web";

const capabilityPreferenceKeys = [
  "enabled_wiggle_egress",
  "wiggle_egress_hosts_template",
  "wiggle_egress_allowed_hosts",
  "enabled_turmeric",
  "enabled_geolocation",
  "tool_search_mode",
  "enabled_connector_suggestions",
  "enabled_web_search",
  "enabled_monkeys_in_a_barrel",
  "preview_feature_uses_artifacts",
  "enabled_artifacts_attachments",
] as const;

export function hasOfficialCapabilityPreference(body: unknown) {
  return body !== null && typeof body === "object" &&
    capabilityPreferenceKeys.some(key => Object.hasOwn(body, key));
}

export const officialCapabilityPreferenceSchema = z.union([
  z.object({ enabled_wiggle_egress: z.boolean() }).strict(),
  z
    .object({
      wiggle_egress_hosts_template: z.enum([
        "custom",
        "package_managers",
        "full_egress",
      ]),
    })
    .strict(),
  z
    .object({
      wiggle_egress_allowed_hosts: preferenceFields.egressDomains.unwrap(),
    })
    .strict(),
  z
    .object({
      enabled_wiggle_egress: z.literal(true),
      wiggle_egress_hosts_template: z.literal("package_managers"),
      wiggle_egress_allowed_hosts: z.array(z.string()).length(0),
    })
    .strict(),
  z.object({ enabled_turmeric: z.boolean() }).strict(),
  z.object({ enabled_geolocation: z.boolean() }).strict(),
  z.object({ tool_search_mode: z.enum(["on", "off"]) }).strict(),
  z.object({ enabled_connector_suggestions: z.boolean() }).strict(),
  z.object({ enabled_web_search: preferenceFields.chatWebSearch.unwrap() }).strict(),
  z.object({ enabled_monkeys_in_a_barrel: z.literal(false) }).strict(),
  z
    .object({
      enabled_monkeys_in_a_barrel: z.literal(true),
      enabled_artifacts_attachments: z.literal(false),
      preview_feature_uses_artifacts: z.literal(true),
    })
    .strict(),
  z.object({ preview_feature_uses_artifacts: z.boolean() }).strict(),
]);
export type OfficialCapabilityPreference = z.infer<
  typeof officialCapabilityPreferenceSchema
>;

export function capabilityPreferenceSettings(
  wire: OfficialCapabilityPreference,
) {
  if ("enabled_wiggle_egress" in wire && "wiggle_egress_hosts_template" in wire)
    return {
      networkEgress: true,
      egressAllowlist: "packages" as const,
      egressDomains: wire.wiggle_egress_allowed_hosts,
    };
  if ("enabled_wiggle_egress" in wire)
    return { networkEgress: wire.enabled_wiggle_egress };
  if ("wiggle_egress_hosts_template" in wire)
    return {
      egressAllowlist: (
        {
          custom: "none",
          package_managers: "packages",
          full_egress: "all",
        } as const
      )[wire.wiggle_egress_hosts_template],
    };
  if ("wiggle_egress_allowed_hosts" in wire)
    return { egressDomains: wire.wiggle_egress_allowed_hosts };
  if ("enabled_turmeric" in wire) return { aiArtifacts: wire.enabled_turmeric };
  if ("enabled_geolocation" in wire)
    return { locationMetadata: wire.enabled_geolocation };
  if ("tool_search_mode" in wire)
    return {
      toolAccessMode:
        wire.tool_search_mode === "on"
          ? ("needed" as const)
          : ("loaded" as const),
    };
  if ("enabled_connector_suggestions" in wire)
    return { connectorSearch: wire.enabled_connector_suggestions };
  if ("enabled_web_search" in wire)
    return { chatWebSearch: wire.enabled_web_search };
  if ("enabled_monkeys_in_a_barrel" in wire)
    return wire.enabled_monkeys_in_a_barrel
      ? { chatExecution: true, artifacts: true }
      : { chatExecution: false };
  return { artifacts: wire.preview_feature_uses_artifacts };
}

export function parseOfficialCapabilityPreferenceRequest(
  request: OfficialUiReadRequest,
) {
  if (
    request.method !== "PATCH" ||
    request.path !== "/api/account/settings" ||
    !(request.body instanceof Uint8Array) ||
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")
  )
    return undefined;
  const body: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(request.body),
  );
  if (!hasOfficialCapabilityPreference(body)) return undefined;
  const parsed = officialCapabilityPreferenceSchema.safeParse(body);
  if (!parsed.success) throw Error("Invalid capability preference.");
  return parsed.data;
}
