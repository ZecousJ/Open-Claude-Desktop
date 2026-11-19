import { z } from "zod";
import type { Conversation } from "./types";

const identifier = z.string().min(1).max(500);
const timestamp = z.number().finite().nonnegative();
export const codeReadSnapshotSchema = z
  .object({
    id: identifier,
    createdAt: timestamp,
    updatedAt: timestamp,
    readStateRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    threadId: identifier.nullable(),
    turnCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    latestTurn: z
      .object({
        id: identifier,
        createdAt: timestamp,
        status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => (value.turnCount === 0) === (value.latestTurn === null));
export type CodeReadSnapshot = z.infer<typeof codeReadSnapshotSchema>;

/** Content-free identity of the activity the person actually opened. */
export function codeReadSnapshot(c: Conversation): CodeReadSnapshot {
  if (
    !c ||
    !Array.isArray(c.turns) ||
    c.turns.some((turn) => !turn || typeof turn !== "object")
  )
    throw Error(
      "The Code session activity snapshot is invalid. Reopen the session before retrying.",
    );
  const latest = c.turns.at(-1);
  return codeReadSnapshotSchema.parse({
    id: c.id,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    readStateRevision: c.readStateRevision ?? 0,
    threadId: c.threadId ?? null,
    turnCount: c.turns.length,
    latestTurn: latest
      ? { id: latest.id, createdAt: latest.createdAt, status: latest.status }
      : null,
  });
}
export function sameCodeReadActivity(
  c: Conversation,
  expected: CodeReadSnapshot,
): boolean {
  try {
    const actual = codeReadSnapshot(c),
      valid = codeReadSnapshotSchema.parse(expected);
    return (
      actual.id === valid.id &&
      actual.createdAt === valid.createdAt &&
      actual.updatedAt === valid.updatedAt &&
      actual.threadId === valid.threadId &&
      actual.turnCount === valid.turnCount &&
      JSON.stringify(actual.latestTurn) === JSON.stringify(valid.latestTurn)
    );
  } catch {
    return false;
  }
}
export function sameCodeReadSnapshot(
  c: Conversation,
  expected: CodeReadSnapshot,
): boolean {
  return (
    sameCodeReadActivity(c, expected) &&
    (c.readStateRevision ?? 0) === expected.readStateRevision
  );
}
