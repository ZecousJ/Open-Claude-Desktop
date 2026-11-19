import { z } from "zod";
import {
  codeReadSnapshotSchema,
  sameCodeReadActivity,
  sameCodeReadSnapshot,
  type CodeReadSnapshot,
} from "../../shared/code-read-state";
import type { Conversation } from "../../shared/types";
import type { Context } from "./conversations";

// A mutated-but-unconfirmed service save must not become a successful duplicate.
const pending = new WeakSet<Conversation>();
const uncertain = new WeakSet<Conversation>();

/** Deliberately overload an existing boolean: legacy hosts reject this guard. */
export async function acknowledgeCodeRead(
  context: Context,
  c: Conversation,
  raw: unknown,
) {
  const {
    unread: { expected },
  } = z
    .object({
      unread: z
        .object({
          version: z.literal(1),
          expected: codeReadSnapshotSchema,
        })
        .strict(),
    })
    .strict()
    .parse(raw);
  const store = context.store,
    generation = context.accountGeneration?.();
  const account = context.activeAccount?.id;
  const localOrSavedSsh = () => {
    if (!c.environment || c.environment.kind === "local") return true;
    const ssh = context.services?.ssh;
    return c.environment.kind === "ssh" && ssh?.allowed() === true &&
      Boolean(ssh.hosts.get(c.environment.hostId));
  };
  const eligible = () =>
    c.mode === "code" &&
    !c.incognito &&
    !c.cloudHosted &&
    !c.cloudEnvironmentId &&
    localOrSavedSsh() &&
    typeof c.cwd === "string" &&
    c.cwd.trim().length > 0 &&
    (!account ||
      !c.sessionAuthors ||
      c.sessionAuthors.ownerAccountUuid === account);
  const current = () =>
    generation != null &&
    !context.accountRetiring &&
    context.store === store &&
    context.accountGeneration?.() === generation &&
    context.activeAccount?.id === account &&
    eligible();
  if (!current())
    throw Error(
      "Account-scoped local Code read updates are unavailable for this session.",
    );
  return commitCodeRead(context, c, expected, current);
}

export async function commitCodeRead(
  context: Pick<Context, "store" | "scheduler" | "push">,
  c: Conversation,
  expected: CodeReadSnapshot,
  scopeCurrent: () => boolean,
) {
  const { store } = context;
  const { id, createdAt } = c;
  const current = () =>
    scopeCurrent() &&
    context.store === store &&
    c.id === id &&
    c.createdAt === createdAt &&
    store.conversations.includes(c) &&
    store.conversations.filter((row) => row.id === id).length === 1;
  if (!current())
    throw Error("The Code session changed. Reopen it before marking it read.");
  if (pending.has(c) || uncertain.has(c))
    throw Error(
      "The Code read save is pending or unknown. Reopen the account before retrying.",
    );
  if (!sameCodeReadSnapshot(c, expected))
    throw Error("The Code session changed. Reopen it before marking it read.");
  const cleared = () => c.unread === false;
  // A repeated open of an already-read snapshot has no persistence or scheduler effects.
  if (c.unread !== true) return structuredClone(c);
  if (expected.readStateRevision >= Number.MAX_SAFE_INTEGER)
    throw Error(
      "The Code read revision is exhausted. Reopen the account before retrying.",
    );
  const revision = expected.readStateRevision + 1;
  let saveStarted = false;
  pending.add(c);
  try {
    await store.persistChatMetadata(
      c,
      { unread: false, readStateRevision: revision },
      () => {
        if (!current() || !sameCodeReadActivity(c, expected)) return false;
        if (!saveStarted) {
          if (!sameCodeReadSnapshot(c, expected) || c.unread !== true)
            return false;
          saveStarted = true;
          return true;
        }
        return (
          (c.readStateRevision ?? 0) === expected.readStateRevision ||
          (c.readStateRevision === revision && cleared())
        );
      },
    );
    if (
      !current() ||
      !cleared() ||
      c.readStateRevision !== revision ||
      !sameCodeReadActivity(c, expected)
    )
      throw Error(
        "The Code read save could not be confirmed. Reopen before retrying.",
      );
  } catch (error) {
    if (cleared() && c.readStateRevision === revision) uncertain.add(c);
    throw error;
  } finally {
    pending.delete(c);
  }
  context.scheduler?.markConversationRead(id);
  context.push?.({
    type: "code-read-state",
    conversationId: id,
    unread: false,
    readStateRevision: revision,
  });
  return structuredClone(c);
}
