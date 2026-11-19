import { z } from "zod";

export const officialCodeSessionPresetKey = "ccd/session-presets";
export const officialCodeUserSettingsMaxBytes = 512 * 1024;

const userSettingsPrefix = "/api/claude_code/organizations/";
const organizationUserSettings =
  /^\/api\/claude_code\/organizations\/([a-fA-F\d]{8}-[a-fA-F\d]{4}-[a-fA-F\d]{4}-[a-fA-F\d]{4}-[a-fA-F\d]{12})\/user_settings$/;

export function officialCodeUserSettingsOrganization(path: string) {
  const match = organizationUserSettings.exec(path);
  if (match?.[0] === path) return match[1].toLowerCase();
}

export function officialCodeUserSettingsPath(organization: string) {
  return `${userSettingsPrefix}${organization}/user_settings`;
}

export function isOfficialCodeUserSettingsChecksum(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

const keys = z.enum([
  officialCodeSessionPresetKey,
  "ccd/ccd-sessions-filter",
  "ccd/desktop-frame.paneStore.v1",
  "ccd/dframe-pinned-project-outputs",
  "ccd/dframe-session-groups",
  "ccd/dframe-starred-code",
  "ccd/dframe-starred-cowork-remote",
  "ccd/dframe-starred-routines",
  "ccd/dframe-store",
  "ccd/dframe-unpinned-epitaxy-project",
  "ccd/epitaxy-editor-prefs",
  "ccd/epitaxy-starred-environments",
]);
const entries = z.partialRecord(keys, z.string());
export type OfficialCodeUserSettingsEntries = z.infer<typeof entries>;

const request = z.strictObject({ entries });
const settings = z.record(z.string(), z.unknown());
const stateEnvelope = z.strictObject({
  state: settings,
  version: z.number().optional(),
  updatedAt: z.number(),
});
const catalog = z.strictObject({
  version: z.literal(3),
  updatedAt: z.number(),
  state: z.strictObject({
    presets: z
      .array(
        z.object({ target: z.object({ kind: z.enum(["cloud", "bridge"]) }) }),
      )
      .max(200),
    builtIns: z.strictObject({ cloud: settings.optional() }),
    placeDefaults: z.record(z.string().regex(/^(?:cloud|bridge):/), settings),
  }),
});

export function parseOfficialCodeUserSettingsWrite(body: Uint8Array) {
  try {
    const { entries } = request.parse(
      JSON.parse(new TextDecoder().decode(body)),
    );
    for (const [key, value] of Object.entries(entries)) {
      const envelope: unknown = JSON.parse(value);
      (key === officialCodeSessionPresetKey ? catalog : stateEnvelope).parse(
        envelope,
      );
    }
    return entries;
  } catch {
    return undefined;
  }
}

export interface OfficialCodeUserSettings {
  revision: number;
  entries: OfficialCodeUserSettingsEntries;
}

export function officialCodeUserSettingsChecksum(
  saved?: OfficialCodeUserSettings,
) {
  return `revision:${saved?.revision ?? 0}`;
}

export function officialCodeUserSettingsWire(
  userId: string,
  saved?: OfficialCodeUserSettings,
) {
  return {
    userId,
    checksum: officialCodeUserSettingsChecksum(saved),
    content: { entries: saved?.entries ?? {} },
  };
}
