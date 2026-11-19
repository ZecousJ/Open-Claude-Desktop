import type { Conversation } from "../../shared/types";
import {
  interruptTargetSchema,
  type InterruptTargetResult,
} from "../../shared/interrupt-target";
import { codeSendStartFor } from "../engine/code-send-start";

interface InterruptContext {
  readonly store: { conversation(id: string): Conversation };
  readonly engine: { interrupt(id: string): Promise<void> };
  accountGeneration?(): unknown;
}
/** Only narrows the existing method. No new mode, path, account or remote authority. */
export function interruptExpectedTurn(
  ctx: InterruptContext,
  id: string,
  raw: unknown,
  beforeInterrupt?: () => void,
): Promise<InterruptTargetResult> {
  const expected = interruptTargetSchema.parse(raw);
  if (!ctx.accountGeneration)
    throw Error(
      "Account-scoped expected-turn interruption is unavailable on this host.",
    );
  const store = ctx.store,
    generation = ctx.accountGeneration?.();
  let c: Conversation;
  try {
    c = store.conversation(id);
  } catch {
    return Promise.resolve({ status: "mismatch" });
  }
  const turn = c.turns.at(-1);
  const sameConversationTurn = () => {
    try {
      return (
        ctx.store === store &&
        generation === ctx.accountGeneration?.() &&
        store.conversation(id) === c &&
        c.id === id &&
        c.createdAt === expected.conversationCreatedAt &&
        c.turns.at(-1) === turn &&
        turn?.createdAt === expected.turnCreatedAt
      );
    } catch {
      return false;
    }
  };
  if ("kind" in expected) {
    const tracked = codeSendStartFor(c, turn);
    const engine = ctx.engine;
    const current = () => sameConversationTurn() && ctx.engine === engine;
    if (tracked?.id !== expected.turnId || !current())
      return Promise.resolve({ status: "mismatch" });
    if (turn?.status !== "inProgress")
      return Promise.resolve({ status: "already_finished" });
    return tracked.start.stop(current, beforeInterrupt);
  }
  const current = () =>
    sameConversationTurn() &&
    c.threadId === expected.threadId &&
    turn?.id === expected.turnId;
  if (!current()) return Promise.resolve({ status: "mismatch" });
  if (turn && ["completed", "failed", "interrupted"].includes(turn.status))
    return Promise.resolve({ status: "already_finished" });
  if (turn?.status !== "inProgress")
    return Promise.resolve({ status: "mismatch" });
  const engine = ctx.engine;
  if (!current()) return Promise.resolve({ status: "mismatch" });
  beforeInterrupt?.();
  if (!current() || ctx.engine !== engine)
    return Promise.resolve({ status: "mismatch" });
  // The engine synchronously selects the turn before its first RPC await.
  // Do not insert an await between this authoritative comparison and invocation.
  return engine.interrupt(id).then(() => ({
    status: current() && ctx.engine === engine ? "accepted" : "mismatch",
  }));
}
