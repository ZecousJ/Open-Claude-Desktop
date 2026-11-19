export const officialResponseChunkBytes = 2 * 1024 * 1024;
export const officialResponseChunkPrefix = "/api/claudex/response_chunks/";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const transferId = new RegExp(`^${uuid}$`);
const chunkQuery = new RegExp(
  `^${officialResponseChunkPrefix}(${uuid})\\?offset=([1-9][0-9]*)$`,
);

export interface OfficialResponseTransfer {
  id: string;
  totalBytes: number;
}

export function isOfficialResponseTransferId(id: unknown): id is string {
  return typeof id === "string" && id.length === 36 && transferId.test(id);
}

export function officialResponseChunkPath(id: string, offset: number) {
  return `${officialResponseChunkPrefix}${id}?offset=${offset}`;
}

export function officialResponseChunk(method: string, path: string) {
  if (method !== "GET") return undefined;
  const match = chunkQuery.exec(path);
  if (!match || match[0] !== path) return undefined;
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) return undefined;
  return { id: match[1], offset };
}
