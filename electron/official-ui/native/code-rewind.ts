import { codeForkTurns } from "../../../shared/code-fork";
import { codeSteerTranscriptInput } from "./code-transcript";
import {
  pendingCodeRewindMark,
  rewindModel,
  type CodeRewindTarget,
} from "../../../shared/code-rewind";

import { createHash } from "node:crypto";
import type { Conversation } from "../../../shared/types";
import type { CodeTranscriptConversion } from "./code-transcript";
import { codeHistoryFingerprint } from "./code-history";
const local =
  /^local_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fingerprint(c: Conversation) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        history: codeHistoryFingerprint(c),
        rewind: c.rewind,
        updatedAt: c.updatedAt,
      }),
    )
    .digest("hex");
}
export interface CodeRewindDependencies {
  current(): boolean;
  load(id: string): Promise<Conversation | undefined>;
  convert(c: Conversation): CodeTranscriptConversion;
  call(
    method: "rewindConversation" | "swapRewind",
    id: string,
    turn?: CodeRewindTarget,
  ): Promise<Conversation>;
  reserve(id: string, hash: string, undo: boolean): boolean;
  files?(id: string, turn: CodeRewindTarget, dryRun: boolean): Promise<unknown>;
  switchSavedMark?(id: string, mark: string): Promise<Conversation>;
}
export function createCodeRewind(deps: CodeRewindDependencies) {
  const pending = new Map<string, object>();
  const check = () => {
    if (!deps.current())
      throw Error(
        "The account changed during rewind. Check the session before retrying.",
      );
  };
  const run = async (
    session: unknown,
    message: unknown,
    undo: boolean,
    mark?: unknown,
  ) => {
    check();
    if (typeof session !== "string" || !local.test(session))
      throw Error("An owned local Code session is required.");
    if (pending.has(session))
      throw Error(
        "A history change is pending. Check the session before retrying.",
      );
    const value = await deps.load(session);
    check();
    const c = value ? structuredClone(value) : undefined;
    if (
      !c ||
      c.id !== session.slice(6) ||
      c.mode !== "code" ||
      c.incognito ||
      c.cloudHosted ||
      c.cloudEnvironmentId ||
      c.archived ||
      c.worktree?.state === "deleted" ||
      c.codeNewTask ||
      (c.environment?.kind ?? "local") !== "local" ||
      !c.cwd ||
      c.turns.some(
        (t) => t.status === "inProgress" || t.id.startsWith("pending-"),
      )
    )
      throw Error("Rewind requires a settled owned local Code session.");
    const converted = deps.convert(c);
    if (converted.unsupported.length)
      throw Error("This history cannot be represented completely for rewind.");
    let index = -1,
      prefill = "";
    let itemId: string | undefined;
    if (undo) {
      if (!c.rewind) return { refusal: "sent" };
      if (mark !== undefined && mark !== codeRewindMark(c)?.id)
        return { refusal: "gone" };
      if (mark === undefined && c.rewind.variant !== "pending")
        return { refusal: "gone" };
      if (
        !Number.isSafeInteger(c.rewind.index) ||
        c.rewind.index < 0 ||
        c.rewind.index > c.turns.length ||
        (c.rewind.variant === "pending" &&
          c.rewind.index + Number(!!c.rewind.partial) !== c.turns.length) ||
        !Array.isArray(c.rewind.turns) ||
        (c.rewind.variant === "pending" && !c.rewind.turns.length) ||
        c.rewind.turns.some(
          (t) => t.status === "inProgress" || t.id.startsWith("pending-"),
        ) ||
        (c.rewind.index > 0 && !c.rewind.threadId)
      )
        throw Error(
          "The saved rewind boundary is invalid. Its history was not changed.",
        );
      if (
        deps.convert({
          ...c,
          turns: [...c.turns.slice(0, c.rewind.index), ...c.rewind.turns],
        }).unsupported.length
      )
        throw Error(
          "The removed history cannot be restored completely in this interface.",
        );
    } else {
      if (typeof message !== "string" || message.length > 500)
        throw Error("A complete user prompt boundary is required.");
      const matches = c.turns.flatMap((t, i) => {
        const row = deps.convert({ ...c, turns: [t] }).rows[0];
        const targets =
          !t.compaction && row?.type === "user" && row.uuid === message
            ? [
                {
                  t,
                  i,
                  itemId: undefined as string | undefined,
                  text: t.prompt,
                },
              ]
            : [];
        for (const item of t.items) {
          const steer = codeSteerTranscriptInput(t, item);
          if (steer?.uuid === message)
            targets.push({ t, i, itemId: item.id, text: steer.text });
        }
        return targets;
      });
      if (
        converted.rows.filter((row) => row.uuid === message).length !== 1 ||
        matches.length !== 1
      )
        throw Error(
          "The complete user prompt boundary is missing or ambiguous. Its history was not changed.",
        );
      index = matches[0].i;
      itemId = matches[0].itemId;
      prefill = matches[0].text;
    }
    const before = fingerprint(c),
      hash = createHash("sha256")
        .update(
          JSON.stringify({
            kind: undo ? "undo" : "rewind",
            session,
            source: before,
            target: message ?? null,
          }),
        )
        .digest("hex");
    // Deterministic host identity: renderer cannot obtain fresh authority by choosing a new UUID.
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    if (pending.has(session)) throw Error("A history change is pending.");
    const token = {};
    pending.set(session, token);
    try {
      check();
      if (!deps.reserve(id, hash, undo))
        throw Error(
          "This history operation may already have been requested. Check the session; it will not be replayed.",
        );
      const latest = await deps.load(session);
      check();
      if (!latest || fingerprint(latest) !== before)
        throw Error(
          "The history changed before rewind. No automatic retry was started.",
        );
      const result = await deps.call(
        undo ? "swapRewind" : "rewindConversation",
        c.id,
        undo
          ? undefined
          : itemId
            ? { turnId: c.turns[index].id, itemId }
            : c.turns[index]!.id,
      );
      check();
      const expectedTurns = undo
        ? [...c.turns.slice(0, c.rewind!.index), ...c.rewind!.turns]
        : codeForkTurns(c.turns, c.turns[index].id, {
            turnId: c.turns[index].id,
            ...(itemId ? { itemId } : {}),
          });
      if (
        !result ||
        result.id !== c.id ||
        result.createdAt !== c.createdAt ||
        result.cwd !== c.cwd ||
        result.mode !== c.mode ||
        result.incognito !== c.incognito ||
        result.cloudHosted !== c.cloudHosted ||
        result.cloudEnvironmentId !== c.cloudEnvironmentId ||
        result.archived !== c.archived ||
        JSON.stringify(result.worktree) !== JSON.stringify(c.worktree) ||
        JSON.stringify(result.sessionAuthors) !==
          JSON.stringify(c.sessionAuthors) ||
        result.codeNewTask ||
        JSON.stringify(result.environment) !== JSON.stringify(c.environment) ||
        result.providerId !== c.providerId ||
        result.model !==
          (undo
            ? (c.rewind?.model ?? c.model)
            : rewindModel(c.turns.slice(index), c.model)) ||
        result.activeBranchId !== c.activeBranchId ||
        result.projectId !== c.projectId ||
        typeof result.updatedAt !== "number" ||
        !Number.isFinite(result.updatedAt) ||
        JSON.stringify(result.turns) !== JSON.stringify(expectedTurns) ||
        result.rewind?.variant !==
          (undo && c.rewind?.variant === "pending" ? "forward" : "pending") ||
        typeof result.rewind.at !== "number" ||
        !Number.isFinite(result.rewind.at) ||
        result.rewind.index !== (undo ? c.rewind!.index : index) ||
        JSON.stringify(result.rewind.turns) !==
          JSON.stringify(
            undo ? c.turns.slice(c.rewind!.index) : c.turns.slice(index),
          ) ||
        result.rewind.threadId !== c.threadId ||
        (undo
          ? result.threadId !== c.rewind!.threadId
          : index === 0 && !itemId
            ? result.threadId !== undefined
            : typeof result.threadId !== "string" ||
              !result.threadId ||
              result.threadId === c.threadId)
      )
        throw Error(
          "The history result could not be confirmed. Check the session before retrying.",
        );
      const owned = await deps.load(session);
      check();
      if (!owned || fingerprint(owned) !== fingerprint(result))
        throw Error(
          "The changed history is no longer available in this account.",
        );
      if (undo) {
        const rows = deps.convert(owned);
        if (rows.unsupported.length)
          throw Error(
            "The restored transcript cannot be represented completely.",
          );
        return { transcript: rows.rows };
      }
      return {
        prefill,
        ...(c.model !== result.model ? { unwoundRefusalFallback: true } : {}),
      };
    } finally {
      if (pending.get(session) === token) pending.delete(session);
    }
  };
  return {
    rewind: async (s: unknown, m: unknown) => {
      const result = await run(s, m, false);
      if (!("prefill" in result))
        throw Error("The rewind result has no prompt.");
      return result;
    },
    undo: (s: unknown) => run(s, undefined, true),
    refusedPrompt: async (session: unknown) => {
      check();
      if (typeof session !== "string" || !local.test(session)) return null;
      const c = await deps.load(session);
      check();
      const turn = c?.turns.at(-1);
      if (!c || !turn?.refusedPrompt || !turn.prompt.trim()) return null;
      const row = deps.convert({ ...c, turns: [turn] }).rows[0];
      if (row?.type !== "user") return null;
      return run(session, row.uuid, false);
    },
    switchMark: async (session: unknown, mark: unknown) => {
      check();
      if (
        typeof session !== "string" ||
        !local.test(session) ||
        typeof mark !== "string"
      )
        return { refusal: "gone" };
      const c = await deps.load(session);
      check();
      if (!c) return { refusal: "gone" };
      if (mark === codeRewindMark(c)?.id)
        return run(session, undefined, true, mark);
      const target = c.savedBranches?.find(
        (branch) => branch.id === mark && branch.rewindMark,
      );
      if (!target || !deps.switchSavedMark) return { refusal: "gone" };
      if (c.rewind?.variant === "pending") return { refusal: "unsent" };
      if (deps.convert({ ...c, turns: target.turns }).unsupported.length)
        return { refusal: "unreadable" };
      const result = await deps.switchSavedMark(c.id, mark);
      check();
      if (
        result.id !== c.id ||
        result.threadId !== target.threadId ||
        JSON.stringify(result.turns) !== JSON.stringify(target.turns)
      )
        throw Error("The restored Code history could not be confirmed.");
      return { transcript: deps.convert(result).rows };
    },
    files: async (session: unknown, message: unknown, dryRun: unknown) => {
      check();
      if (
        typeof session !== "string" ||
        !local.test(session) ||
        typeof message !== "string" ||
        typeof dryRun !== "boolean"
      )
        throw Error("A Code session, prompt and dry-run flag are required.");
      const c = await deps.load(session);
      check();
      if (!c || !deps.files) return null;
      const matches: CodeRewindTarget[] = [];
      for (const turn of c.turns) {
        if (
          !turn.compaction &&
          deps.convert({ ...c, turns: [turn] }).rows[0]?.uuid === message
        )
          matches.push(turn.id);
        for (const item of turn.items)
          if (codeSteerTranscriptInput(turn, item)?.uuid === message)
            matches.push({ turnId: turn.id, itemId: item.id });
      }
      if (matches.length !== 1)
        return {
          canRewind: false,
          error: "The file restore prompt is missing or ambiguous.",
        };
      if (c.turns.some((turn) => turn.status === "inProgress"))
        return { canRewind: false, error: "Session is busy" };
      return deps.files(c.id, matches[0], dryRun);
    },
    clear: () => pending.clear(),
  };
}

export const codeRewindMark = pendingCodeRewindMark;
