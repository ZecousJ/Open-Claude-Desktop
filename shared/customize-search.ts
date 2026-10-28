/** Cursor search is owned by the authenticated host, not by a client-side
 * reveal counter. Each source section retains its independent continuation. */
export type CustomizeSearchKind = "skill" | "plugin" | "connector";
export type CustomizeSearchPage = "skills" | "plugins" | "connectors";
export type CustomizeSearchSection = "yours" | "inPage" | "more";
export type CustomizeSearchTarget =
  | { type: "skill"; path: string }
  | { type: "plugin"; id: string }
  | { type: "connector"; id: string }
  | { type: "external"; url: string };
export interface CustomizeSearchHit {
  key: string;
  kind: CustomizeSearchKind;
  name: string;
  description?: string;
  yours: boolean;
  target: CustomizeSearchTarget;
}
export interface CustomizeSearchRequest {
  query: string;
  page: CustomizeSearchPage;
  section: CustomizeSearchSection;
  cursor?: string;
  limit?: number;
}
export interface CustomizeSearchResult {
  items: CustomizeSearchHit[];
  nextCursor?: string;
  total: number;
}
export interface CustomizeSearchAPI {
  customizeSearch(
    request: CustomizeSearchRequest,
  ): Promise<CustomizeSearchResult>;
}
export interface SkillUploadCapabilities {
  securityScan: boolean;
}
export interface SkillUploadCapabilitiesAPI {
  skillUploadCapabilities(): Promise<SkillUploadCapabilities>;
}
/** An explicit origin supplied by the host; a system scope alone never
 * proves publisher, partner or sharing provenance. */
export interface CustomizeSkillProvenance {
  source:
    "you" | "organization" | "project" | "shared" | "publisher" | "marketplace";
  publisher?: string;
  marketplace?: string;
}
export function validCustomizeSearchResult(
  value: unknown,
): value is CustomizeSearchResult {
  const result = value as CustomizeSearchResult | undefined;
  return (
    !!result &&
    Number.isSafeInteger(result.total) &&
    result.total >= 0 &&
    (result.nextCursor === undefined ||
      (typeof result.nextCursor === "string" &&
        result.nextCursor.length > 0 &&
        result.nextCursor.length <= 4096)) &&
    Array.isArray(result.items) &&
    result.items.length <= 100 &&
    result.items.every((hit) => {
      if (
        !hit ||
        typeof hit.key !== "string" ||
        !hit.key ||
        typeof hit.name !== "string" ||
        !["skill", "plugin", "connector"].includes(hit.kind) ||
        typeof hit.yours !== "boolean" ||
        (hit.description !== undefined && typeof hit.description !== "string")
      )
        return false;
      const target = hit.target;
      if (!target || typeof target !== "object") return false;
      if (target.type === "skill")
        return typeof target.path === "string" && !!target.path;
      if (target.type === "plugin" || target.type === "connector")
        return typeof target.id === "string" && !!target.id;
      if (target.type !== "external" || typeof target.url !== "string")
        return false;
      try {
        return new URL(target.url).protocol === "https:";
      } catch {
        return false;
      }
    })
  );
}
