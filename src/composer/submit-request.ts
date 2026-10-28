/**
 * Asks a composer elsewhere in the window to send its draft, as if Send was
 * pressed there, so it goes through the same checks (a repository to pick,
 * a folder, the model). The composer is named by its draft identity
 * (`Composer`'s `draftIdentity`). Used by a split pane's "Start session"
 * when it is closed with an unsent draft.
 */
const listeners = new Set<{
  identity: string;
  submit: () => void;
  hasResources: () => boolean;
}>();

type PendingSubmit = {
  identity: string;
  owner: object;
  current(): boolean;
};
let pending: PendingSubmit | undefined;

function flushPending() {
  const request = pending;
  if (!request) return;
  const ready = [...listeners].find(
    (listener) => listener.identity === request.identity,
  );
  if (!ready) return;
  pending = undefined;
  if (request.current() && !ready.hasResources()) ready.submit();
}

/** One explicit page-control intent, held until its exact new draft has a
 * committed Composer. This never falls back to another conversation. */
export function requestComposerSubmitWhenReady(
  identity: string,
  owner: object,
  current: () => boolean,
) {
  const request = { identity, owner, current };
  pending = request;
  queueMicrotask(() => {
    if (pending === request) flushPending();
  });
}

/** Navigation and account teardown retire the pending page-control intent. */
export function cancelStaleComposerSubmit() {
  if (pending && !pending.current()) pending = undefined;
}
export function cancelComposerSubmitFor(owner: object) {
  if (pending?.owner === owner) pending = undefined;
}

export function requestComposerSubmit(
  identity: string,
  options?: { withoutResources?: boolean },
) {
  for (const listener of [...listeners])
    if (
      listener.identity === identity &&
      !(options?.withoutResources && listener.hasResources())
    )
      listener.submit();
}

/** Calls `submit` when the composer with this identity is asked to send. */
export function onComposerSubmitRequest(
  identity: string,
  submit: () => void,
  hasResources: () => boolean = () => false,
) {
  const listener = { identity, submit, hasResources };
  listeners.add(listener);
  queueMicrotask(() => {
    if (listeners.has(listener)) flushPending();
  });
  return () => void listeners.delete(listener);
}
