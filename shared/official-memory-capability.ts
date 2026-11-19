import { z } from "zod";

export const officialMemoryCapabilitiesPath = "/api/claudex/memory-capabilities/version1";

export type OfficialMemoryAction = "controls" | "reset" | "settings" | "synthesize" | "backfill";

const memoryActionPath = /^\/api\/organizations\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(?:memory\/(controls|reset|settings|synthesize)(\?[^#]*)?|(conversation\/backfill))$/i;

export function officialMemoryAction(method: string, path: string): OfficialMemoryAction | undefined {
  const match = memoryActionPath.exec(path);
  if (method === "PUT" && match?.[1] === "controls" && !match[2]) return "controls";
  if (method === "POST" && match?.[1] === "reset") return "reset";
  if (method === "POST" && match?.[1] === "settings" && !match[2]) return "settings";
  if (method === "POST" && match?.[1] === "synthesize" && !match[2]) return "synthesize";
  if (method === "POST" && match?.[3] === "conversation/backfill") return "backfill";
}

const gesture = z.literal(true);
const officialMemorySettings = z.union([
  z.strictObject({ enabled_saffron_search: z.boolean(), user_initiated: gesture }),
  z.strictObject({ enabled_saffron: z.literal(false), user_initiated: gesture.optional() }),
  z.strictObject({ enabled_saffron: z.literal(true), user_initiated: gesture }),
  z.strictObject({ enabled_melange: z.literal(true), user_initiated: gesture }),
  z.strictObject({ enabled_melange: z.literal(false), enabled_saffron: z.literal(true), user_initiated: gesture }),
  z.strictObject({ enabled_melange: z.literal(false), enabled_saffron: z.literal(false), clear_data: gesture.optional(), user_initiated: gesture.optional() }),
]);

export function parseOfficialMemorySettings(value: unknown) {
  const parsed = officialMemorySettings.safeParse(value);
  if (!parsed.success) return undefined;
  const body = parsed.data;
  if ("enabled_saffron_search" in body) return { kind: "search" as const, enabled: body.enabled_saffron_search };
  if (!("enabled_melange" in body)) return { kind: "generation" as const, enabled: body.enabled_saffron };
  if (body.enabled_melange) return { kind: "mode" as const, mode: "melange" as const, clear: false };
  return { kind: "mode" as const, mode: body.enabled_saffron ? "classic" as const : "off" as const, clear: "clear_data" in body && body.clear_data === true };
}

export type OfficialMemorySettingsIntent = NonNullable<ReturnType<typeof parseOfficialMemorySettings>>;

export function officialMemorySettingsPreference(intent: OfficialMemorySettingsIntent) {
  if (intent.kind === "search") return { key: "searchChats" as const, enabled: intent.enabled };
  if (intent.kind === "generation") return { key: "generate" as const, enabled: intent.enabled };
  return { key: "generate" as const, enabled: intent.mode !== "off" };
}

export interface OfficialMemoryPreferenceActions {
  generate: boolean;
  searchChats: boolean;
}

export interface OfficialMemoryCapability {
  version: 1;
  accountId: string;
  activationLease: string;
  controls: {
    state: "ready" | "unavailable" | "denied" | "error";
    reason: "ready" | "disabled" | "service_unavailable" | "memory_off" | "version_unavailable" | "session_changed" | "source_error";
  };
  generation: "unavailable";
  synthesis?: "ready";
  reset: "ready" | "unavailable";
  settings: "disable-only" | "unavailable";
  preferences?: OfficialMemoryPreferenceActions;
}
