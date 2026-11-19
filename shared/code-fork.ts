import type { Conversation, Turn } from "./types";
import { rewindModel } from "./code-rewind";
import { clearTurnRetry } from "./activity";

type CodeForkBoundary = { turnId: string } & (
  | { itemId?: string; importedRowId?: never }
  | { importedRowId: string; itemId?: never }
);

export type CodeForkOptions = {
  conversationId?: string;
  cwd?: string;
  separateWorktree?: true;
  before?: CodeForkBoundary;
};

export type CodeForkSource =
  { kind: "native"; threadId: string } | { kind: "imported" };

export function codeForkSource(
  c: Conversation,
  target: Turn,
  kept: readonly Turn[],
): CodeForkSource | undefined {
  if (c.importedSessionResumePending) return undefined;
  const importedPrefix =
    (kept.length > 0 || target.importedCodeTranscript?.length) &&
    kept.every((turn) => turn.importedCodeTranscript?.length);
  if (
    c.mode === "code" &&
    c.importedHistory &&
    !c.cloudHosted &&
    !c.cloudEnvironmentId &&
    (c.environment?.kind ?? "local") === "local" &&
    (!c.threadId || importedPrefix)
  )
    return { kind: "imported" };
  if (c.threadId) return { kind: "native", threadId: c.threadId };
}

export function codeForkModel(
  turns: Turn[],
  current: string,
  before?: CodeForkOptions["before"],
) {
  if (!before) return current;
  const index = turns.findIndex((turn) => turn.id === before.turnId);
  return rewindModel(
    turns.slice(
      index +
        Number(
          before.itemId !== undefined || before.importedRowId !== undefined,
        ),
    ),
    current,
  );
}

export function codeForkTurns(
  turns: Turn[],
  turnId: string,
  before?: CodeForkOptions["before"],
): Turn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0 || turns.filter((turn) => turn.id === turnId).length !== 1)
    throw Error("The Code fork message is unavailable or ambiguous.");
  if (!before) return structuredClone(turns.slice(0, index + 1));
  if (before.turnId !== turnId)
    throw Error("The Code fork boundary does not match its turn.");
  const kept = structuredClone(turns.slice(0, index));
  if (before.importedRowId !== undefined) {
    const source = turns[index];
    const rows = source.importedCodeTranscript ?? [];
    const rowIndex = rows.findIndex((row) => row.uuid === before.importedRowId);
    if (
      rowIndex < 0 ||
      rows.filter((row) => row.uuid === before.importedRowId).length !== 1
    )
      throw Error(
        "The imported Code fork message is unavailable or ambiguous.",
      );
    if (rowIndex > 0)
      kept.push({
        ...structuredClone(source),
        importedCodeTranscript: structuredClone(rows.slice(0, rowIndex)),
      });
    const completedTools = new Set(
      kept.flatMap((turn) =>
        (turn.importedCodeTranscript ?? []).flatMap((row) =>
          Array.isArray(row.message.content)
            ? row.message.content.flatMap((block) =>
                block.type === "tool_result" &&
                typeof block.tool_use_id === "string"
                  ? [block.tool_use_id]
                  : [],
              )
            : [],
        ),
      ),
    );
    for (const turn of kept) {
      if (!turn.importedCodeTranscript?.length) continue;
      const itemIds = new Set(
        turn.importedCodeTranscript.flatMap((row) => [
          row.uuid,
          ...(Array.isArray(row.message.content)
            ? row.message.content
            : [row.message.content]
          ).map((block, index) =>
            typeof block === "object" &&
            block.type === "tool_use" &&
            typeof block.id === "string"
              ? block.id
              : `${row.uuid}:${index}`,
          ),
        ]),
      );
      turn.items = turn.items.filter((item) => itemIds.has(item.id));
      for (const item of turn.items) {
        if (item.type !== "dynamicToolCall" || completedTools.has(item.id))
          continue;
        if (item.status === "completed" || item.status === "failed")
          item.status = "interrupted";
        delete item.contentItems;
        delete item.result;
        delete item.generatedFiles;
      }
      if (
        turn.error &&
        !turn.importedCodeTranscript.some((row) => row.isApiErrorMessage)
      ) {
        delete turn.error;
        turn.status = "completed";
      }
    }
    return kept;
  }
  if (before.itemId !== undefined) {
    const source = turns[index];
    const itemIndex = source.items.findIndex(
      (item) => item.id === before.itemId,
    );
    if (
      itemIndex < 0 ||
      source.items.filter((item) => item.id === before.itemId).length !== 1
    )
      throw Error("The Code fork message is unavailable or ambiguous.");
    const partial = {
      ...structuredClone(source),
      items: structuredClone(source.items.slice(0, itemIndex)),
      status: "completed" as const,
    };
    delete partial.error;
    delete partial.userStopped;
    delete partial.stopReason;
    delete partial.usageHold;
    clearTurnRetry(partial);
    delete partial.outputTokens;
    delete partial.outputTokenBase;
    delete partial.inputTokens;
    delete partial.inputTokenBase;
    kept.push(partial);
  }
  return kept;
}
