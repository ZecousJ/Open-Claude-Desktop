import { z } from "zod";
import { codeThinkingPreferenceSnapshotSchema } from "../../shared/code-thinking-preferences";
import type { Conversation } from "../../shared/types";
import type { Context } from "./conversations";

const pending = new WeakSet<Conversation>();
const uncertain = new WeakSet<Conversation>();

/** Legacy boolean callers cannot overwrite an in-flight or uncertain guarded save. */
export function assertCodeThinkingPreferenceAvailable(c: Conversation) {
  if (pending.has(c) || uncertain.has(c))
    throw Error(
      "The thinking summary save is pending or unknown. Reopen the account before retrying.",
    );
}

/** Overload an existing boolean so older services reject before any mutation. */
export async function saveCodeThinkingPreference(
  context: Context,
  c: Conversation,
  raw: unknown,
) {
  const {
    thinkingSummariesWanted: { wanted, expected },
  } = z
    .object({
      thinkingSummariesWanted: z
        .object({
          version: z.literal(1),
          wanted: z.boolean(),
          expected: codeThinkingPreferenceSnapshotSchema,
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
  const current = () =>
    !context.accountRetiring &&
    context.store === store &&
    context.accountGeneration?.() === generation &&
    context.activeAccount?.id === account &&
    c.id === expected.id &&
    c.createdAt === expected.createdAt &&
    c.mode === "code" &&
    !c.incognito &&
    !c.cloudHosted &&
    !c.cloudEnvironmentId &&
    localOrSavedSsh() &&
    typeof c.cwd === "string" &&
    c.cwd.trim().length > 0 &&
    (!c.sessionAuthors ||
      (!!account && c.sessionAuthors.ownerAccountUuid === account)) &&
    store.conversations.includes(c) &&
    store.conversations.filter((row) => row.id === c.id).length === 1;
  if (!context.accountGeneration || generation == null || !current())
    throw Error(
      "Account-scoped owned local Code thinking summary updates are unavailable for this session.",
    );
  assertCodeThinkingPreferenceAvailable(c);
  const matchesExpected = () =>
    (c.thinkingSummariesWanted ?? null) === expected.thinkingSummariesWanted;
  if (!matchesExpected())
    throw Error(
      "The thinking summary preference changed. Reopen its settings before retrying.",
    );
  if (c.thinkingSummariesWanted === wanted) return structuredClone(c);
  let started = false;
  pending.add(c);
  try {
    await store.persistChatMetadata(
      c,
      { thinkingSummariesWanted: wanted },
      () => {
        if (!current()) return false;
        if (!started) {
          if (!matchesExpected()) return false;
          started = true;
          return true;
        }
        return matchesExpected() || c.thinkingSummariesWanted === wanted;
      },
    );
    if (!current() || c.thinkingSummariesWanted !== wanted)
      throw Error(
        "The thinking summary save could not be confirmed. Reopen the account before retrying.",
      );
  } catch (error) {
    // Disk failures leave memory untouched. An applied service mutation or a lost
    // account lease may already have reached storage: never roll it back or replay it.
    if (!current() || !matchesExpected()) uncertain.add(c);
    throw error;
  } finally {
    pending.delete(c);
  }
  const saved = structuredClone(c);
  context.push?.({ type: "conversation", conversation: saved });
  return saved;
}
