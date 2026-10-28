import { t } from "../../i18n";
import { dismissToast, showToast } from "../../ui/toast-store";

export type RoutineReadUpdate =
  { runId: string; readAt: number } | { runId: string; error: unknown };
type Acknowledge = (routineId: string, runId: string) => Promise<void>;
type ReadListener = (update: RoutineReadUpdate) => void;
type AccountScope = {
  accountId: string;
  active: boolean;
  pending: Map<string, Promise<void>>;
  notices: Map<string, number>;
  listeners: Map<string, Set<ReadListener>>;
};
let account: AccountScope | undefined;
const keyFor = (scope: AccountScope, routineId: string, runId: string) =>
  JSON.stringify([scope.accountId, routineId, runId]);
const current = (scope: AccountScope) => scope.active && account === scope;

function invalidate(scope: AccountScope) {
  scope.active = false;
  scope.pending.clear();
  scope.listeners.clear();
  for (const notice of scope.notices.values()) dismissToast(notice);
  scope.notices.clear();
  if (account === scope) account = undefined;
}

/** App owns this lease with its real accountId, including sign-out cleanup.
 * Detail navigation leaves the lease alive; another account never inherits it. */
export function activateRoutineReadAccount(accountId: string): () => void {
  if (account) invalidate(account);
  const scope: AccountScope = {
    accountId,
    active: true,
    pending: new Map(),
    notices: new Map(),
    listeners: new Map(),
  };
  account = scope;
  return () => invalidate(scope);
}

/** Read receipts outlive the detail panel, never the signed-in account. */
export function onRoutineReadUpdate(
  routineId: string,
  listener: (update: RoutineReadUpdate) => void,
) {
  const scope = account;
  if (!scope) return () => {};
  const group = scope.listeners.get(routineId) ?? new Set<ReadListener>();
  scope.listeners.set(routineId, group);
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size && scope.listeners.get(routineId) === group)
      scope.listeners.delete(routineId);
  };
}

function publish(
  scope: AccountScope,
  routineId: string,
  update: RoutineReadUpdate,
) {
  if (current(scope))
    scope.listeners.get(routineId)?.forEach((listener) => listener(update));
}

/** Share only in-flight writes; a failed write remains retryable on its
 * existing endpoint. The toast action retries the receipt, not opening a chat. */
export function acknowledgeRoutineRun(
  routineId: string,
  runId: string,
  acknowledge: Acknowledge,
): Promise<void> {
  const scope = account;
  // A standalone caller can acknowledge once, but has no signed-in owner
  // for a persistent action or a cross-panel subscription.
  if (!scope)
    return Promise.resolve().then(() => acknowledge(routineId, runId));
  const key = keyFor(scope, routineId, runId);
  const existing = scope.pending.get(key);
  if (existing) return existing;
  let attempt: Promise<void>;
  attempt = Promise.resolve()
    .then(() => {
      if (current(scope)) return acknowledge(routineId, runId);
    })
    .then(() => {
      if (!current(scope)) return;
      const notice = scope.notices.get(key);
      if (notice !== undefined) dismissToast(notice);
      publish(scope, routineId, { runId, readAt: Date.now() });
    })
    .catch((error: unknown) => {
      if (!current(scope)) throw error;
      const previous = scope.notices.get(key);
      if (previous !== undefined) dismissToast(previous);
      const notice = showToast(
        t("Couldn’t mark this run as read. Try again."),
        {
          description: error instanceof Error ? error.message : String(error),
          variant: "warning",
          timeout: Infinity,
          action: {
            label: t("Retry"),
            onSelect: () => {
              if (!current(scope)) return;
              void acknowledgeRoutineRun(routineId, runId, acknowledge).catch(
                () => {},
              );
            },
          },
          onDismiss: () => {
            if (scope.notices.get(key) === notice) scope.notices.delete(key);
          },
        },
      );
      scope.notices.set(key, notice);
      publish(scope, routineId, { runId, error });
      throw error;
    })
    .finally(() => {
      if (scope.pending.get(key) === attempt) scope.pending.delete(key);
    });
  scope.pending.set(key, attempt);
  return attempt;
}
