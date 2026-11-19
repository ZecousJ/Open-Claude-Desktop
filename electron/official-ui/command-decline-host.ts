/**
 * Host-only capabilities for declining ordinary commands. The renderer never
 * supplies an engine request id, and this API cannot approve a command.
 */
import { randomUUID } from "node:crypto";
import type { Approval, Conversation } from "../../shared/types";

export interface CommandDeclineCard {
  elicitationId: string;
  askNonce: string;
  conversationId: string;
  turnId: string;
  command: string;
  state: "pending" | "unconfirmed";
}

export class CommandDeclineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const stale = () =>
  new CommandDeclineError(
    "elicitation_unavailable",
    "That command request is no longer available. No decline was sent.",
  );
const unconfirmed = () =>
  new CommandDeclineError(
    "elicitation_unconfirmed",
    "The decline result is unconfirmed. It will not be sent again. Reopen the conversation to check its current state.",
  );

export interface CommandDeclineHostPorts {
  /** Bound to one immutable account activation, store and engine. */
  current(): boolean;
  approvals(): readonly Approval[];
  conversation(id: string): Conversation | undefined;
  /** Synchronous exact-object compare-and-dispatch. Never an id-only fallback. */
  declineExact(approval: Approval): unknown;
  confirmationWaitMs?: number;
}

/** Only a complete live ordinary Chat command can receive a decline capability. */
function commandTarget(approval: Approval, c: Conversation | undefined) {
  const p = approval.params;
  if (
    !c ||
    c.id !== approval.conversationId ||
    c.mode !== "chat" ||
    c.cloudHosted ||
    (c.environment && c.environment.kind !== "local") ||
    approval.method !== "item/commandExecution/requestApproval" ||
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    !c.threadId ||
    p.threadId !== c.threadId ||
    typeof p.turnId !== "string" ||
    !p.turnId ||
    typeof p.itemId !== "string" ||
    !p.itemId ||
    typeof p.command !== "string" ||
    !p.command.trim() ||
    p.command.length > 200000
  )
    return;
  // Even empty expanded-permission fields belong to a separate contract.
  if (
    [
      "networkApprovalContext",
      "additionalPermissions",
      "proposedNetworkPolicyAmendments",
      "proposedExecpolicyAmendment",
      "proposedExecPolicyAmendment",
      "permissions",
      "requestedSchema",
      "url",
      "mode",
    ].some((key) => p[key] != null)
  )
    return;
  const turn = c.turns?.at(-1);
  if (
    !turn ||
    turn.status !== "inProgress" ||
    turn.id !== p.turnId ||
    c.turns.filter((t) => t.id === turn.id).length !== 1
  )
    return;
  const items = turn.items?.filter((item) => item.id === p.itemId) ?? [];
  if (
    items.length !== 1 ||
    items[0].type !== "commandExecution" ||
    items[0].command !== p.command ||
    ["completed", "failed", "interrupted"].includes(items[0].status ?? "") ||
    ["completed", "failed", "interrupted"].includes(
      items[0].lifecycleStatus ?? "",
    )
  )
    return;
  return {
    turnId: turn.id,
    command: p.command as string,
    // Include timestamps, branch and all parameters. Reusing an id is not enough.
    fingerprint: JSON.stringify([
      c.id,
      c.createdAt,
      c.threadId,
      c.activeBranchId,
      turn.id,
      turn.createdAt,
      p,
      items[0].id,
      items[0].command,
    ]),
  };
}

interface Entry {
  approval: Approval;
  card: CommandDeclineCard;
  fingerprint: string;
  status: "pending" | "unconfirmed" | "declined" | "invalid";
}

export function createCommandDeclineHost(ports: CommandDeclineHostPorts) {
  const byRequest = new WeakMap<Approval, Entry>();
  const byId = new Map<string, Entry>();
  const listeners = new Set<(conversationId: string) => void>();
  const changed = (conversationId: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(conversationId);
      } catch {
        /* A listener cannot authorize or retry an operation. */
      }
    }
  };
  let retired = false;
  const current = () => {
    if (retired) return false;
    try {
      if (ports.current() !== true) retired = true;
    } catch {
      retired = true;
    }
    return !retired;
  };
  const target = (approval: Approval) => {
    if (!current()) return;
    const pending = ports.approvals();
    if (
      !pending.includes(approval) ||
      pending.filter((a) => a.id === approval.id).length !== 1
    )
      return;
    const result = commandTarget(
      approval,
      ports.conversation(approval.conversationId),
    );
    return current() ? result : undefined;
  };
  return {
    subscribe(listener: (conversationId: string) => void) {
      if (!current()) throw stale();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    list(conversationId: string): CommandDeclineCard[] {
      if (!current()) throw stale();
      const cards: CommandDeclineCard[] = [];
      for (const approval of ports.approvals()) {
        if (approval.conversationId !== conversationId) continue;
        let entry = byRequest.get(approval);
        const live = target(approval);
        if (!live || (entry && entry.fingerprint !== live.fingerprint)) {
          if (entry?.status === "pending") entry.status = "invalid";
          continue;
        }
        if (!entry) {
          entry = {
            approval,
            fingerprint: live.fingerprint,
            status: "pending",
            card: {
              elicitationId: randomUUID(),
              askNonce: randomUUID(),
              conversationId,
              turnId: live.turnId,
              command: live.command,
              state: "pending",
            },
          };
          byRequest.set(approval, entry);
          byId.set(entry.card.elicitationId, entry);
        }
        if (entry.status === "pending" || entry.status === "unconfirmed")
          cards.push({
            ...entry.card,
            state: entry.status === "pending" ? "pending" : "unconfirmed",
          });
      }
      if (!current()) throw stale();
      return cards;
    },
    async decline(
      conversationId: string,
      elicitationId: string,
      askNonce: string,
    ): Promise<void> {
      if (!current()) throw stale();
      const entry = byId.get(elicitationId);
      if (
        !entry ||
        entry.card.askNonce !== askNonce ||
        entry.card.conversationId !== conversationId
      )
        throw stale();
      // A repeated known outcome is read-only; an ambiguous one is never replayed.
      if (entry.status === "declined") return;
      if (entry.status === "invalid") throw stale();
      if (entry.status !== "pending") throw unconfirmed();
      const live = target(entry.approval);
      if (!live || live.fingerprint !== entry.fingerprint) {
        entry.status = "invalid";
        throw stale();
      }
      // Reserve before the call, including reentrant calls and synchronous throws.
      entry.status = "unconfirmed";
      let dispatched: unknown;
      try {
        dispatched = ports.declineExact(entry.approval);
      } catch {
        changed(conversationId);
        throw unconfirmed();
      }
      changed(conversationId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve(dispatched).catch(() => undefined),
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve(undefined),
              ports.confirmationWaitMs ?? 1500,
            );
          }),
        ]);
        if (
          !current() ||
          !result ||
          typeof result !== "object" ||
          (result as { status?: unknown }).status !== "declined"
        )
          throw unconfirmed();
        entry.status = "declined";
      } finally {
        if (timer) clearTimeout(timer);
        changed(conversationId);
      }
    },
  };
}

export type CommandDeclineHost = ReturnType<typeof createCommandDeclineHost>;
