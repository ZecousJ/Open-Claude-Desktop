import fs from "node:fs";
import path from "node:path";

import type { ReplyRating } from "../../shared/diagnostics-api";
export type { ReplyRating };
interface FeedbackFile {
  version: 1;
  ratings: Record<string, ReplyRating>;
}
function identity(conversationId: string, turnId: string) {
  if (
    !conversationId ||
    !turnId ||
    conversationId.length > 500 ||
    turnId.length > 500
  )
    throw Error("Invalid reply identity.");
  return JSON.stringify([conversationId, turnId]);
}
function valid(value: unknown): value is FeedbackFile {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>,
    ratings = data.ratings;
  return (
    data.version === 1 &&
    !!ratings &&
    typeof ratings === "object" &&
    !Array.isArray(ratings) &&
    Object.entries(ratings).length <= 100000 &&
    Object.entries(ratings).every(([key, rating]) => {
      if (key.length > 1010 || !["up", "down"].includes(String(rating)))
        return false;
      try {
        const parts: unknown = JSON.parse(key);
        return (
          Array.isArray(parts) &&
          parts.length === 2 &&
          parts.every(
            (item) =>
              typeof item === "string" && item.length > 0 && item.length <= 500,
          )
        );
      } catch {
        return false;
      }
    })
  );
}

/**
 * Account-local reply ratings. The file contains identities and votes, never
 * reply text. Diagnostics (C7) listens for deleted conversations so their
 * unsent feedback is dropped too.
 */
export class ReplyFeedback {
  private readonly filename: string;
  private ratings: Record<string, ReplyRating> = {};
  private deletedListeners = new Set<(conversationId: string) => void>();
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.filename = path.join(root, "reply-feedback.json");
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.filename, "utf8"));
      if (!valid(data)) throw Error("Invalid reply feedback.");
      this.ratings = data.ratings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(
          "Reply feedback cannot be read; it has not been overwritten.",
        );
    }
  }
  all() {
    return { ...this.ratings };
  }
  set(conversationId: string, turnId: string, rating: ReplyRating | null) {
    const key = identity(conversationId, turnId),
      next = { ...this.ratings };
    if (rating === null) delete next[key];
    else if (rating === "up" || rating === "down") next[key] = rating;
    else throw Error("Invalid reply rating.");
    this.write(next);
    return this.all();
  }
  deleteConversation(conversationId: string) {
    const next = { ...this.ratings };
    let changed = false;
    for (const key of Object.keys(next))
      if ((JSON.parse(key) as string[])[0] === conversationId) {
        delete next[key];
        changed = true;
      }
    if (changed) this.write(next);
    for (const listener of [...this.deletedListeners])
      try {
        listener(conversationId);
      } catch (error) {
        console.error(
          "Listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
  }
  /** Runs `cb` after a conversation's ratings were deleted with it; returns the unsubscribe. */
  onConversationDeleted(cb: (conversationId: string) => void) {
    this.deletedListeners.add(cb);
    return () => {
      this.deletedListeners.delete(cb);
    };
  }
  private write(next: Record<string, ReplyRating>) {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ratings: next }), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filename);
    this.ratings = next;
  }
}
