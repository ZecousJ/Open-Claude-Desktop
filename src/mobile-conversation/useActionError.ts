import { useMemo, useSyncExternalStore } from "react";
import type {
  ConversationActionPayloads,
  ConversationActionType,
} from "../../shared/mobile/conversation-contract";
import {
  ConversationBridge,
  ConversationUserDeclinedError,
  downloadResult,
} from "./bridge";

type ActionError = { message: string; scope?: string };

function completedAction<K extends ConversationActionType>(
  type: K,
  payload: ConversationActionPayloads[K],
  result: unknown,
) {
  if (type === "downloadArtifact")
    return typeof result === "string" && result.length > 0;
  if (type === "downloadArtifacts") {
    const total = (payload as ConversationActionPayloads["downloadArtifacts"])
      .files.length;
    try {
      const saved = downloadResult(result, total);
      return !saved.cancelled && saved.saved === total;
    } catch {
      return false;
    }
  }
  return result !== false;
}

class ScopedActionError extends Error {
  constructor(
    readonly owner: ConversationActionErrors,
    readonly scope: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** Per-surface errors. A successful retry may retire only the error it saw. */
export class ConversationActionErrors {
  private error: ActionError | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly bridge: ConversationBridge) {}

  snapshot = () => this.error;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(error: ActionError | undefined) {
    this.error = error;
    this.listeners.forEach((listener) => listener());
  }
  dismiss = () => this.set(undefined);
  report = (value: unknown) => {
    if (value instanceof ConversationUserDeclinedError) return;
    if (value instanceof ScopedActionError && value.owner !== this) return;
    this.set({
      message: value instanceof Error ? value.message : String(value),
      scope: value instanceof ScopedActionError ? value.scope : undefined,
    });
  };
  request = async <K extends ConversationActionType>(
    type: K,
    payload: ConversationActionPayloads[K],
  ): Promise<unknown> => {
    // Include the complete target/payload: success on another turn, link or
    // mutation must not dismiss this failure. No payload is sent elsewhere.
    const scope = JSON.stringify([type, payload]);
    const previous = this.error;
    try {
      const result = await this.bridge.request(type, payload);
      // An overlapping operation that started before the error is not a retry.
      // Neither a newer failure nor an unrelated failure is cleared on success.
      if (
        completedAction(type, payload, result) &&
        previous?.scope === scope &&
        this.error === previous
      )
        this.set(undefined);
      return result;
    } catch (error) {
      if (error instanceof ConversationUserDeclinedError) throw error;
      throw new ScopedActionError(this, scope, error);
    }
  };
}

export function useActionError(bridge: ConversationBridge, sessionId: string) {
  const actions = useMemo(
    () => new ConversationActionErrors(bridge),
    [bridge, sessionId],
  );
  const error = useSyncExternalStore(
    actions.subscribe,
    actions.snapshot,
    actions.snapshot,
  );
  return {
    error: error?.message ?? "",
    dismiss: actions.dismiss,
    report: actions.report,
    request: actions.request,
  };
}
