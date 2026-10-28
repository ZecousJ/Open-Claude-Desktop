/**
 * Earlier versions kept artifact names and comments in window storage,
 * which every local account on this app origin shares. They now live in
 * the account profile (shared/artifact-notes.ts); these keys are only read
 * once to move what an earlier version saved, then removed.
 */
import { legacyMetadataKey, metadataStorageKey } from "./artifact-storage-keys";
import type { ArtifactNotes } from "../../shared/artifact-notes";
import type { DesktopAPI } from "../../shared/types";
export { legacyMetadataKey, metadataStorageKey } from "./artifact-storage-keys";

export interface Metadata {
  name: string;
  updatedAt: number;
}

export function readArtifactMetadata(
  value: string | null,
): Record<string, Metadata> {
  try {
    const data = JSON.parse(value ?? "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data).filter((entry): entry is [string, Metadata] => {
        const value = entry[1] as Metadata;
        return (
          !!value &&
          typeof value.name === "string" &&
          value.name.trim().length > 0 &&
          value.name.length <= 200 &&
          Number.isFinite(value.updatedAt)
        );
      }),
    );
  } catch {
    return {};
  }
}

export function storedNamesAsNotes(
  metadata: Record<string, Metadata>,
  noteKey: (identity: string) => string,
): ArtifactNotes {
  const notes: ArtifactNotes = {};
  for (const [identity, meta] of Object.entries(metadata)) {
    let owner: unknown;
    try {
      [owner] = JSON.parse(identity) as unknown[];
    } catch {
      continue;
    }
    notes[noteKey(identity)] = {
      ...(typeof owner === "string" && owner && owner !== "library"
        ? { conversationId: owner }
        : {}),
      name: meta.name.trim(),
      renamedAt: meta.updatedAt,
    };
  }
  return notes;
}

export async function importStoredArtifactNames(
  api: Pick<DesktopAPI, "importArtifactNotes"> | undefined,
  accountId: string,
  legacyOwner: boolean,
  conversationIds: ReadonlySet<string>,
  noteKey: (identity: string) => string,
): Promise<ArtifactNotes | undefined> {
  const stored = storedNamesAsNotes(
    readArtifactMetadata(
      scopedMetadataValue(
        localStorage,
        accountId,
        legacyOwner,
        conversationIds,
      ),
    ),
    noteKey,
  );
  if (!Object.keys(stored).length || !api?.importArtifactNotes) return;
  const notes = await api.importArtifactNotes(stored);
  forgetStoredNames(localStorage, accountId, legacyOwner);
  return notes;
}

export interface ArtifactStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}
export function legacyCommentStorageKey(
  conversationId: string,
  source: string,
) {
  return `claudex:artifact-comments:${JSON.stringify([conversationId, source])}`;
}
export function scopedCommentStorageKey(
  accountId: string,
  conversationId: string,
  source: string,
) {
  return `claudex:artifact-comments:v2:${JSON.stringify([accountId, conversationId, source])}`;
}

/** Legacy values can only move into the first account and only for its conversation IDs. */
export function scopedMetadataValue(
  storage: ArtifactStorage,
  accountId: string,
  legacyOwner: boolean,
  conversationIds: ReadonlySet<string>,
): string | null {
  const key = metadataStorageKey(accountId),
    existing = storage.getItem(key);
  if (existing !== null || !legacyOwner) return existing;
  const legacy = storage.getItem(legacyMetadataKey);
  if (legacy === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(legacy);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
  } catch {
    return null;
  }
  const entries = Object.entries(parsed).filter(([identity]) => {
    try {
      const value: unknown = JSON.parse(identity);
      return (
        Array.isArray(value) &&
        typeof value[0] === "string" &&
        conversationIds.has(value[0])
      );
    } catch {
      return false;
    }
  });
  const migrated = JSON.stringify(Object.fromEntries(entries));
  storage.setItem(key, migrated);
  return migrated;
}
export function scopedCommentValue(
  storage: ArtifactStorage,
  accountId: string,
  conversationId: string,
  source: string,
  legacyOwner: boolean,
  conversationIds: ReadonlySet<string>,
): string | null {
  const key = scopedCommentStorageKey(accountId, conversationId, source),
    existing = storage.getItem(key);
  if (existing !== null || !legacyOwner || !conversationIds.has(conversationId))
    return existing;
  const legacy = storage.getItem(
    legacyCommentStorageKey(conversationId, source),
  );
  if (legacy !== null) storage.setItem(key, legacy);
  return legacy;
}

/** Removes the window-storage names once the profile has them. */
export function forgetStoredNames(
  storage: ArtifactStorage,
  accountId: string,
  legacyOwner: boolean,
) {
  storage.removeItem?.(metadataStorageKey(accountId));
  if (legacyOwner) storage.removeItem?.(legacyMetadataKey);
}

/** Removes one artifact's window-storage comments once the profile has them. */
export function forgetStoredComments(
  storage: ArtifactStorage,
  accountId: string,
  conversationId: string,
  source: string,
  legacyOwner: boolean,
) {
  storage.removeItem?.(
    scopedCommentStorageKey(accountId, conversationId, source),
  );
  if (legacyOwner)
    storage.removeItem?.(legacyCommentStorageKey(conversationId, source));
}
