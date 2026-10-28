/**
 * What an account keeps about its artifacts besides the artifacts
 * themselves: a display name, when it was last opened, and comments pinned
 * to its preview. Stored in the account profile (`artifact-notes.json`,
 * electron/artifact-library.ts), never in the window's shared storage.
 */

/** An answer under a pinned comment (a reply in the original's comment thread). */
export interface ArtifactReply {
  id: string;
  text: string;
  createdAt: number;
  /** When the text was last edited; the card then says "edited". */
  editedAt?: number;
}

/**
 * A comment pinned to a point of an artifact's preview (0–1 of its size),
 * and the thread of replies under it. Comments saved before replies and
 * edits existed have neither field.
 */
export interface ArtifactComment {
  id: string;
  text: string;
  x: number;
  y: number;
  createdAt: number;
  resolved: boolean;
  editedAt?: number;
  replies?: ArtifactReply[];
}

export interface ArtifactNote {
  /** Effective rights from the host, never inferred from link audience. */
  access?: { read: boolean; write: boolean };
  /** The conversation the artifact came from; notes of deleted chats are dropped. */
  conversationId?: string;
  name?: string;
  renamedAt?: number;
  viewedAt?: number;
  /** Absent until comments were first saved (earlier versions kept them in window storage). */
  comments?: ArtifactComment[];
}

/** Notes by `artifactNoteKey(identity)`. */
export type ArtifactNotes = Record<string, ArtifactNote>;

export interface ArtifactNotePatch {
  conversationId?: string;
  name?: string;
  viewed?: boolean;
  comments?: ArtifactComment[];
}

export const artifactNoteLimits = {
  notes: 5000,
  comments: 500,
  replies: 200,
  commentChars: 10_000,
  nameChars: 200,
  fileBytes: 8 * 1024 * 1024,
};

const cache = new Map<string, string>();

/**
 * A fixed-length key for an artifact identity. Identities of artifacts
 * without a source file contain their whole content, so they are hashed
 * (128-bit cyrb128; collisions only mix up display notes).
 */
export function artifactNoteKey(identity: string): string {
  const cached = cache.get(identity);
  if (cached) return cached;
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < identity.length; i++) {
    const k = identity.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const key = [h1, h2, h3, h4]
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
  if (cache.size >= 1000) cache.clear();
  cache.set(identity, key);
  return key;
}
