import type { InterruptTargetResult } from "../../shared/interrupt-target";
import type { Conversation, Turn } from "../../shared/types";

export const officialCodeSessionEnvironment = Symbol("official Code session environment");
export const officialCodeNewTaskInput = Symbol("official Code new task input");
export const officialCodeSendStart = Symbol("official Code send start");

export class CodeSendCancelled extends Error {
  constructor() {
    super("The Code message was cancelled before dispatch.");
  }
}

export class CodeRunAdmissionError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export interface CodeRunAdmission {
  track(turn: Turn): void;
  abandon(): void;
}

type StopDispatched = (
  current: () => boolean,
) => Promise<InterruptTargetResult>;
type StartPhase =
  | { kind: "preparing" }
  | { kind: "cancelled" }
  | { kind: "dispatched"; stop: StopDispatched; promote?: (id: string) => void };

export class CodeSendStart {
  constructor(readonly nativeMessageUuid?: string) {}

  private phase: StartPhase = { kind: "preparing" };
  private readonly cancellation = new AbortController();
  private current = () => true;
  private cancel: () => void | Promise<void> = () => {};
  private pendingStop?: Promise<InterruptTargetResult>;
  dispatchUncertain = false;

  get beforeDispatch() {
    return this.phase.kind !== "dispatched";
  }

  get cancelledBeforeDispatch() {
    return this.phase.kind === "cancelled";
  }

  get signal() {
    return this.cancellation.signal;
  }

  get stopping() {
    return this.pendingStop !== undefined;
  }

  bind(current: () => boolean, cancel: () => void | Promise<void>) {
    this.current = current;
    this.cancel = cancel;
  }

  dispatched(stop: StopDispatched, promote?: (id: string) => void) {
    this.phase = { kind: "dispatched", stop, promote };
    this.cancel = () => {};
  }

  promoted(id: string) {
    if (this.phase.kind === "dispatched") this.phase.promote?.(id);
  }

  async stop(
    stillCurrent = () => true,
    beforeInterrupt?: () => void,
  ): Promise<InterruptTargetResult> {
    const current = () => stillCurrent() && this.current();
    if (!current()) return { status: "mismatch" };
    beforeInterrupt?.();
    if (!current()) return { status: "mismatch" };
    if (this.phase.kind === "preparing") {
      this.phase = { kind: "cancelled" };
      this.cancellation.abort(new CodeSendCancelled());
    }
    if (this.pendingStop) return this.pendingStop;
    const operation =
      this.phase.kind === "cancelled"
        ? this.finishCancellation()
        : this.phase.stop(current);
    this.pendingStop = operation;
    try {
      return await operation;
    } finally {
      this.pendingStop = undefined;
    }
  }

  private async finishCancellation(): Promise<InterruptTargetResult> {
    await this.cancel();
    this.cancel = () => {};
    return { status: "accepted" };
  }
}

const starts = new WeakMap<
  Conversation,
  { start: CodeSendStart; turn: Turn; id: string }
>();

export function trackCodeSendStart(
  c: Conversation,
  turn: Turn,
  start: CodeSendStart,
) {
  starts.set(c, { start, turn, id: turn.id });
}

export function codeSendStartFor(c: Conversation, turn: Turn | undefined) {
  const tracked = starts.get(c);
  return tracked?.turn === turn ? tracked : undefined;
}

const interrupts = new WeakMap<Turn, Set<() => boolean>>();

export function beginCodeInterrupt(turn: Turn, current: () => boolean) {
  const active = interrupts.get(turn) ?? new Set<() => boolean>();
  active.add(current);
  interrupts.set(turn, active);
  return () => {
    active.delete(current);
    if (!active.size) interrupts.delete(turn);
  };
}

export function codeInterruptInFlight(turn: Turn) {
  const active = interrupts.get(turn);
  if (active) for (const current of active) if (current()) return true;
  return false;
}
