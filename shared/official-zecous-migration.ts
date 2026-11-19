import type { OfficialZecousMigration } from "./zecous-migration-api";

export const officialZecousMigrationPath = "/api/claudex/zecous-migration";
const confirmPath = `${officialZecousMigrationPath}/confirm`;

export function isOfficialZecousMigrationPath(path: string) {
  return path === officialZecousMigrationPath || path === confirmPath;
}

export async function serveOfficialZecousMigration(
  request: { method: string; url: URL },
  api: OfficialZecousMigration | undefined,
  current: () => boolean,
): Promise<{ body: unknown; status: number; allow?: string }> {
  const failed = (status: number, error: string, allow?: string) => ({ body: { error }, status, allow });
  const confirming = request.url.pathname === confirmPath;
  const method = confirming ? "POST" : "GET";
  if (request.method !== method) return failed(405, "Unsupported request.", method);
  const refresh = !confirming && request.url.search === "?refresh=1";
  if (request.url.search && !refresh) return failed(400, "Unsupported balance transfer query.");
  if (!api) return failed(404, "Balance transfer is unavailable.");
  if (!current()) return failed(409, "The active account changed.");
  try {
    const body = confirming ? await api.confirm() : await api.status(refresh ? { refreshOnDone: true } : undefined);
    return current() ? { body, status: 200 } : failed(409, "The active account changed.");
  } catch {
    return current() ? failed(503, "Balance transfer is temporarily unavailable.") : failed(409, "The active account changed.");
  }
}
