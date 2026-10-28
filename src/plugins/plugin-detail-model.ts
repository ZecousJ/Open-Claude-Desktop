import type { PluginDetails } from "../../shared/collections-api";

/** A successful RPC is not yet a readable detail. Do not mount malformed
 * names from an older/failed bridge as usable contents or crash the dialog. */
export function validPluginDetails(value: unknown): value is PluginDetails {
  const detail = value as PluginDetails | undefined;
  return Boolean(
    detail &&
    typeof detail.description === "string" &&
    Number.isSafeInteger(detail.hooks) &&
    detail.hooks >= 0 &&
    [detail.skills, detail.apps, detail.mcpServers].every(
      (rows) =>
        Array.isArray(rows) &&
        rows.every(
          (row) =>
            row && typeof row === "object" && typeof row.name === "string",
        ),
    ),
  );
}
