import {
  codeForkTurns,
  codeForkModel,
  codeForkSource,
  type CodeForkOptions,
} from "../../../shared/code-fork";
import {
  localCodeDirectory,
  resolveLocalCodeDirectory,
} from "../../workspace/code-additional-folder";
import { randomUUID, createHash } from "node:crypto";
import type { Conversation } from "../../../shared/types";
import type { CodeTranscriptConversion } from "./code-transcript";
const localId =
  /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function codeHistoryFingerprint(c: Conversation) {
  const value = JSON.stringify({
    id: c.id,
    createdAt: c.createdAt,
    threadId: c.threadId,
    cwd: c.cwd,
    mode: c.mode,
    environment: c.environment,
    cloudHosted: c.cloudHosted,
    providerId: c.providerId,
    model: c.model,
    incognito: c.incognito,
    importedHistory: c.importedHistory,
    importedSessionResumePending: c.importedSessionResumePending,
    cloudEnvironmentId: c.cloudEnvironmentId,
    sessionAuthors: c.sessionAuthors,
    archived: c.archived,
    worktree: c.worktree,
    codeNewTask: c.codeNewTask,
    projectId: c.projectId,
    rewind: c.rewind,
    parentSessionId: c.parentSessionId,
    forkedFrom: c.forkedFrom,
    activeBranchId: c.activeBranchId,
    turns: c.turns,
  });
  return createHash("sha256").update(value).digest("hex");
}
export function codeForkPlan(
  c: Conversation,
  message: unknown,
  targetCwd: unknown,
  convert: (c: Conversation) => CodeTranscriptConversion,
) {
  if (
    c.mode !== "code" ||
    c.cloudHosted ||
    c.cloudEnvironmentId ||
    c.codeNewTask ||
    (c.environment?.kind ?? "local") !== "local" ||
    c.incognito ||
    !c.cwd
  )
    throw Error("Fork requires an owned local, non-temporary Code session.");
  if (c.importedSessionResumePending)
    throw Error("Confirm that you trust this imported session before forking it.");
  const cwd =
    targetCwd == null
      ? c.cwd
      : resolveLocalCodeDirectory(localCodeDirectory.parse(targetCwd));
  if (
    message !== undefined &&
    message !== null &&
    (typeof message !== "string" || !message || message.length > 500)
  )
    throw Error("Invalid Code fork message.");
  if (
    !c.turns.length ||
    (message == null &&
      c.turns.some(
        (t) => t.status === "inProgress" || t.id.startsWith("pending-"),
      ))
  )
    throw Error("Wait for the Code session to finish before forking.");
  const fingerprint = codeHistoryFingerprint(c);
  if (message == null) {
    const index = c.turns.length - 1;
    const target = c.turns[index];
    const source = codeForkSource(c, target, c.turns);
    if (!source)
      throw Error("Wait for the Code session to finish before forking.");
    return {
      turnId: target.id,
      index,
      fingerprint,
      cwd,
      before: undefined,
      source,
      turns: structuredClone(c.turns),
    };
  }
  const matches = c.turns.flatMap<{
    turnId: string;
    index: number;
    before: NonNullable<CodeForkOptions["before"]>;
  }>((turn, index) => {
    const rows = convert({ ...c, turns: [turn] }).rows;
    const rowIndex = rows.findIndex((row) => row.uuid === message);
    if (rowIndex < 0) return [];
    const imported = turn.importedCodeTranscript?.[rowIndex];
    if (imported)
      return [
        {
          turnId: turn.id,
          index,
          before: { turnId: turn.id, importedRowId: imported.uuid },
        },
      ];
    const promptRows = convert({ ...c, turns: [{ ...turn, items: [] }] }).rows;
    if (promptRows.some((row) => row.uuid === message))
      return [{ turnId: turn.id, index, before: { turnId: turn.id } }];
    const itemIndex = turn.items.findIndex((_, itemIndex) =>
      convert({
        ...c,
        turns: [{ ...turn, items: turn.items.slice(0, itemIndex + 1) }],
      }).rows.some((row) => row.uuid === message),
    );
    if (itemIndex < 0) return [];
    return [
      {
        turnId: turn.id,
        index,
        before: { turnId: turn.id, itemId: turn.items[itemIndex].id },
      },
    ];
  });
  if (
    matches.length !== 1 ||
    convert(c).rows.filter((row) => row.uuid === message).length !== 1
  )
    throw Error("The Code fork message is unavailable or ambiguous.");
  const selected = matches[0];
  const turns = codeForkTurns(c.turns, selected.turnId, selected.before);
  const source = codeForkSource(c, c.turns[selected.index], turns);
  if (!source)
    throw Error("Wait for the Code session to finish before forking.");
  const rows = convert(c).rows;
  const expected = rows
    .slice(
      0,
      rows.findIndex((row) => row.uuid === message),
    )
    .map((row) => row.uuid);
  if (
    JSON.stringify(convert({ ...c, turns }).rows.map((row) => row.uuid)) !==
    JSON.stringify(expected)
  )
    throw Error(
      "The selected Code message boundary cannot be retained exactly.",
    );
  return {
    ...selected,
    fingerprint: codeHistoryFingerprint({ ...c, turns }),
    cwd,
    source,
    turns,
  };
}
export interface CodeForkDependencies {
  current(): boolean;
  load(id: string): Promise<Conversation | undefined>;
  convert(c: Conversation): CodeTranscriptConversion;
  fork(
    id: string,
    options: CodeForkOptions & { turnId: string },
  ): Promise<Conversation>;
  /** Must persist once-only reservation before dispatch; false never authorizes replay. */
  reserve(requestId: string, payloadHash: string): boolean;
}
export function createCodeFork(deps: CodeForkDependencies) {
  const completed = new Map<
    string,
    { hash: string; id: string; createdAt: number; threadId?: string }
  >();
  const inFlight = new Map<string, object>();
  const check = () => {
    if (!deps.current())
      throw Error(
        "The account changed during this fork. Check sessions before retrying.",
      );
  };
  const fork = async (
    parent: unknown,
    requested: unknown,
    message?: unknown,
    targetCwd?: unknown,
  ) => {
    check();
    requested ??= "local_" + randomUUID();
    if (
      typeof parent !== "string" ||
      !localId.test(parent) ||
      typeof requested !== "string" ||
      !localId.test(requested) ||
      parent === requested
    )
      throw Error(
        "A local parent session and a distinct fork request ID are required.",
      );
    const parentId = parent.slice(6),
      requestId = requested.slice(6);
    if (inFlight.has(requestId))
      throw Error(
        "This fork is already pending. Check sessions before retrying.",
      );
    const loaded = await deps.load(parent);
    check();
    const source = loaded ? structuredClone(loaded) : undefined;
    if (!source || source.id !== parentId)
      throw Error("The parent Code session is unavailable.");
    const plan = codeForkPlan(source, message, targetCwd, deps.convert);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          parent: parentId,
          message: message ?? null,
          cwd: targetCwd ?? null,
          source: plan.fingerprint,
          turn: plan.turnId,
        }),
      )
      .digest("hex");
    const prior = completed.get(requestId);
    if (prior) {
      if (prior.hash !== hash)
        throw Error(
          "This fork request ID was already used for a different source.",
        );
      const found = await deps.load("local_" + prior.id);
      check();
      if (
        !found ||
        found.id !== prior.id ||
        found.parentSessionId !== parentId ||
        found.createdAt !== prior.createdAt ||
        (prior.threadId === undefined
          ? !found.importedHistory || found.importedSessionResumePending
          : found.threadId !== prior.threadId) ||
        found.cwd !== plan.cwd ||
        found.forkedFrom?.conversationId !== parentId ||
        found.forkedFrom.turnId !== plan.turnId ||
        found.incognito ||
        found.mode !== "code" ||
        found.cloudHosted ||
        (found.environment?.kind ?? "local") !== "local"
      )
        throw Error(
          "The previous fork is no longer available; it will not be recreated automatically.",
        );
      return { sessionId: "local_" + prior.id };
    }
    if (inFlight.has(requestId)) throw Error("This fork is already pending.");
    const token = {};
    inFlight.set(requestId, token);
    try {
      check();
      if (!deps.reserve(requestId, hash))
        throw Error(
          "This fork may already have been requested. Check sessions; it will not be replayed automatically.",
        );
      const latest = await deps.load(parent);
      check();
      if (
        !latest ||
        codeHistoryFingerprint({
          ...latest,
          turns: codeForkTurns(latest.turns, plan.turnId, plan.before),
        }) !== plan.fingerprint
      )
        throw Error(
          "The parent history changed before the fork. No automatic retry was started.",
        );
      const forked = await deps.fork(parentId, {
        turnId: plan.turnId,
        conversationId: requestId,
        ...(targetCwd == null ? {} : { cwd: plan.cwd }),
        ...(plan.before ? { before: plan.before } : {}),
      });
      check();
      const after = await deps.load(parent);
      check();
      if (
        !after ||
        codeHistoryFingerprint({
          ...after,
          turns: codeForkTurns(after.turns, plan.turnId, plan.before),
        }) !== plan.fingerprint
      )
        throw Error(
          "The parent history changed while the fork was pending. Check sessions before retrying.",
        );
      if (
        !forked ||
        typeof forked.id !== "string" ||
        !uuid.test(forked.id) ||
        forked.id === parentId ||
        forked.mode !== "code" ||
        forked.cloudHosted ||
        forked.cloudEnvironmentId ||
        forked.incognito ||
        forked.archived ||
        forked.rewind ||
        forked.codeNewTask ||
        (forked.environment?.kind ?? "local") !== "local" ||
        forked.cwd !== plan.cwd ||
        forked.parentSessionId !== parentId ||
        forked.forkedFrom?.conversationId !== parentId ||
        forked.forkedFrom.turnId !== plan.turnId ||
        forked.providerId !== source.providerId ||
        forked.model !==
          codeForkModel(source.turns, source.model, plan.before) ||
        forked.projectId !==
          (plan.cwd === source.cwd ? source.projectId : undefined) ||
        JSON.stringify(forked.sessionAuthors) !==
          JSON.stringify(source.sessionAuthors) ||
        typeof forked.createdAt !== "number" ||
        !Number.isFinite(forked.createdAt) ||
        (plan.source.kind === "imported"
          ? forked.threadId !== undefined ||
            forked.importedHistory !== true ||
            forked.importedSessionResumePending ||
            forked.importedCliSessionId
          : !forked.threadId || forked.threadId === plan.source.threadId) ||
        JSON.stringify(forked.turns) !== JSON.stringify(plan.turns)
      )
        throw Error(
          "The fork result could not be confirmed. Check sessions before retrying.",
        );
      const owned = await deps.load("local_" + forked.id);
      check();
      if (
        !owned ||
        codeHistoryFingerprint(owned) !== codeHistoryFingerprint(forked)
      )
        throw Error(
          "The created fork is not available in this account. Check sessions before retrying.",
        );
      if (completed.size >= 4096)
        throw Error(
          "Fork result capacity is full. Check sessions before retrying.",
        );
      completed.set(requestId, {
        hash,
        id: forked.id,
        createdAt: forked.createdAt,
        threadId: forked.threadId,
      });
      return { sessionId: "local_" + forked.id };
    } finally {
      if (inFlight.get(requestId) === token) inFlight.delete(requestId);
    }
  };
  return Object.assign(fork, {
    clear() {
      completed.clear();
      inFlight.clear();
    },
  });
}
