export const legacyMetadataKey = "claudex:artifact-metadata:v1";
export function metadataStorageKey(accountId: string) {
  return `claudex:artifact-metadata:v2:${accountId}`;
}
