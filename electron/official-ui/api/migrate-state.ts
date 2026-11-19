/** Migrate only legacy records that can be proven to belong to this account. */
import fs from "node:fs";
import path from "node:path";
import type { Conversation, Turn } from "../../../shared/types";
import type { AdapterContext } from "./context";
import type { KnownFile } from "./files";
import { readLegacyState, readState, writeStateIfMissing } from "./state";

const entries = (value: unknown): [string, string][] => Array.isArray(value)
  ? value.filter((item): item is [string, string] => Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string")
  : [];

function ownedPath(file: string | undefined, root: string | undefined) {
  if (!file || !root) return false;
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}

/** Legacy data stays untouched, so another account can recover its own records. */
export async function migrateLegacyState(ctx: AdapterContext) {
  const marker = readState<{ completed?: boolean } | null>("migration-v1", null);
  if (marker?.completed === true) return;
  if (marker !== null) throw new Error("The account state migration marker is invalid.");
  const legacyAliases = entries(readLegacyState("aliases", []));
  const rawIds = readLegacyState<unknown>("message-ids", {});
  const rawFiles = readLegacyState<unknown>("files", {});
  const legacyIds = rawIds && typeof rawIds === "object" && !Array.isArray(rawIds) ? rawIds as { turns?: unknown; prompts?: unknown } : {};
  const legacyFiles = rawFiles && typeof rawFiles === "object" && !Array.isArray(rawFiles) ? rawFiles as { files?: unknown; aliases?: unknown } : {};
  if (!legacyAliases.length && !(Array.isArray(legacyIds.turns) && legacyIds.turns.length) && !(Array.isArray(legacyIds.prompts) && legacyIds.prompts.length) && !(Array.isArray(legacyFiles.files) && legacyFiles.files.length)) {
    writeStateIfMissing("migration-v1", { completed: true });
    return;
  }
  const conversations = await ctx.listConversations();
  if (ctx.isCurrent && !ctx.isCurrent()) throw new Error("The account changed during state migration.");
  const ownedIds = new Set(conversations.map((conversation) => conversation.id));
  const turns = conversations.flatMap((conversation: Conversation) => [
    ...(conversation.turns ?? []), ...(conversation.savedBranches ?? []).flatMap((branch) => branch.turns ?? []),
  ]);
  const turnIds = new Set(turns.map((turn: Turn) => turn.id));
  const promptIds = new Set(turns.map((turn: Turn) => turn.promptVersionId ?? turn.responseGroupId ?? turn.id));
  const attachments = new Map<string, Set<string>>();
  for (const turn of turns) for (const attachment of turn.attachments ?? []) {
    const paths = attachments.get(attachment.id) ?? new Set<string>();
    if (attachment.path) paths.add(attachment.path);
    attachments.set(attachment.id, paths);
  }
  const ownAliases = legacyAliases.filter(([, actual]) => ownedIds.has(actual));
  const ownTurns = Array.isArray(legacyIds.turns) ? legacyIds.turns.filter((entry: unknown) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && turnIds.has(entry[0]) && entry[1] && typeof entry[1] === "object" && typeof entry[1].user === "string" && typeof entry[1].assistant === "string") : [];
  const ownPrompts = entries(legacyIds.prompts).filter(([key]) => promptIds.has(key));
  const accountRoot = ctx.stateDirectory?.();
  const files = Array.isArray(legacyFiles.files) ? legacyFiles.files.filter((file: KnownFile) => {
    if (!file || typeof file.id !== "string") return false;
    if (file.conversationId && !ownedIds.has(file.conversationId)) return false;
    return ownedPath(file.path, accountRoot) || (!!file.conversationId && ownedIds.has(file.conversationId) && attachments.has(file.id) && (!file.path || attachments.get(file.id)!.has(file.path)));
  }) : [];
  const fileIds = new Set(files.map((file: KnownFile) => file.id));
  const aliases = entries(legacyFiles.aliases).filter(([, local]) => fileIds.has(local));
  if (ctx.isCurrent && !ctx.isCurrent()) throw new Error("The account changed during state migration.");
  writeStateIfMissing("aliases", ownAliases);
  writeStateIfMissing("message-ids", { turns: ownTurns, prompts: ownPrompts });
  writeStateIfMissing("files", { files, aliases });
  writeStateIfMissing("migration-v1", { completed: true });
}
