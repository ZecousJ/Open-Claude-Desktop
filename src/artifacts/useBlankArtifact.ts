import { registerBlankArtifactFlush } from "./blank-artifact-flush";
import {
  fileTransitionEvent,
  type FileTransition,
} from "../files/file-transitions";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlankArtifactDocument } from "../../shared/blank-artifacts";
import type { Artifact } from "../ui/ArtifactTypes";
import { useApp } from "../app/AppContext";
export function useBlankArtifact(artifact: Artifact) {
  const app = useApp(),
    bridge = window.desktop,
    descriptor = artifact.blankArtifact!;
  const scope = useMemo(
    () => ({
      account: app.accountId,
      owner: app.controllerScope,
      bridge,
      conversationId: artifact.conversationId!,
      artifactId: descriptor.id,
    }),
    [
      app.accountId,
      app.controllerScope,
      bridge,
      artifact.conversationId,
      descriptor.id,
    ],
  );
  const live = useRef(scope);
  live.current = scope;
  const [state, setState] = useState<{
    scope: typeof scope;
    document?: BlankArtifactDocument;
    content?: string;
    error?: unknown;
    conflict?: boolean;
    saving?: boolean;
  }>({ scope });
  const value = state.scope === scope ? state : { scope };
  const latest = useRef(value);
  latest.current = value;
  const navigation = useRef<
    { scope: typeof scope; resume(): void; cancel?: () => void } | undefined
  >(undefined);
  const [waiting, setWaiting] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const saveLocks = useRef(new Set<{ scope: typeof scope }>());
  const [, setLockRevision] = useState(0);
  const flushWaiters = useRef(
    new Set<{ scope: typeof scope; resolve(saved: boolean): void }>(),
  );
  useLayoutEffect(() => {
    const off = registerBlankArtifactFlush(
      { ...scope, artifactId: scope.artifactId },
      {
        lock: () => {
          const lock = { scope };
          saveLocks.current.add(lock);
          setLockRevision((n) => n + 1);
          return () => {
            if (!saveLocks.current.delete(lock)) return;
            if (live.current === scope) setLockRevision((n) => n + 1);
          };
        },
        revision: () => latest.current.document?.revision,
        flush: () => {
          const value = latest.current;
          if (value.error || value.conflict) return Promise.resolve(false);
          if (
            value.document &&
            value.content === value.document.content &&
            !value.saving
          )
            return Promise.resolve(true);
          setUrgent(true);
          return new Promise<boolean>((resolve) =>
            flushWaiters.current.add({ scope, resolve }),
          );
        },
      },
    );
    return () => {
      off();
      for (const waiter of flushWaiters.current)
        if (waiter.scope === scope) {
          flushWaiters.current.delete(waiter);
          waiter.resolve(false);
        }
    };
  }, [scope]);
  const dirty = Boolean(
    value.document && value.content !== value.document.content,
  );
  const beforeLeave = (resume: () => void) => {
    if (!dirty && !value.saving) return resume();
    navigation.current = { scope, resume };
    setWaiting(true);
  };
  useLayoutEffect(() => {
    const listener = (event: Event) => {
      const current = latest.current;
      if (
        event.defaultPrevented ||
        !(
          (current.document && current.content !== current.document.content) ||
          current.saving
        )
      )
        return;
      event.preventDefault();
      navigation.current = {
        scope,
        resume: (event as CustomEvent<FileTransition>).detail.resume,
        cancel: (event as CustomEvent<FileTransition>).detail.cancel,
      };
      setWaiting(true);
    };
    const unload = (event: BeforeUnloadEvent) => {
      const current = latest.current;
      if (
        (current.document && current.content !== current.document.content) ||
        current.saving
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener(fileTransitionEvent, listener);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener(fileTransitionEvent, listener);
      window.removeEventListener("beforeunload", unload);
      if (navigation.current?.scope === scope) navigation.current = undefined;
    };
  }, [scope]);
  useEffect(() => {
    const intent = navigation.current;
    if (intent?.scope === scope && !dirty && !value.saving && value.document) {
      navigation.current = undefined;
      setWaiting(false);
      intent.resume();
    }
  }, [scope, dirty, value.saving, value.document]);
  useEffect(() => {
    const settled = Boolean(
      value.error ||
      value.conflict ||
      (value.document && !dirty && !value.saving),
    );
    if (!settled) return;
    for (const waiter of flushWaiters.current)
      if (waiter.scope === scope) {
        flushWaiters.current.delete(waiter);
        waiter.resolve(!value.error && !value.conflict);
      }
    if (!flushWaiters.current.size) setUrgent(false);
  }, [scope, dirty, value.document, value.saving, value.error, value.conflict]);
  const [reload, setReload] = useState(0);
  const mounted = useRef<object | undefined>(undefined);
  useEffect(() => {
    const lease = {};
    mounted.current = lease;
    let current = true;
    setState({ scope });
    void bridge
      .readBlankArtifact({
        conversationId: scope.conversationId,
        artifactId: scope.artifactId,
      })
      .then(
        (document) => {
          if (current && live.current === scope)
            setState({ scope, document, content: document.content });
        },
        (error) => {
          if (current && live.current === scope) setState({ scope, error });
        },
      );
    return () => {
      current = false;
      if (mounted.current === lease) mounted.current = undefined;
    };
  }, [scope, reload]);
  // Writes are serialized. A newer edit waits for the prior real revision;
  // a conflict leaves the local draft visible until the user reloads it.
  useEffect(() => {
    if (
      !value.document ||
      value.content === undefined ||
      value.content === value.document.content ||
      value.saving ||
      value.error ||
      value.conflict
    )
      return;
    const timer = setTimeout(
      () => {
        const lease = mounted.current,
          base = value.document!,
          content = value.content!;
        if (live.current !== scope || !lease) return;
        setState((current) =>
          current.scope === scope ? { ...current, saving: true } : current,
        );
        void bridge
          .saveBlankArtifact({
            conversationId: scope.conversationId,
            artifactId: scope.artifactId,
            content,
            expectedRevision: base.revision,
          })
          .then(
            (result) => {
              if (live.current !== scope || mounted.current !== lease) return;
              setState((current) => {
                if (current.scope !== scope) return current;
                if (result.status === "saved")
                  return {
                    ...current,
                    document: result.document,
                    saving: false,
                  };
                return {
                  ...current,
                  saving: false,
                  conflict: result.status === "conflict",
                  error:
                    result.status === "conflict"
                      ? undefined
                      : new Error(
                          result.status === "denied"
                            ? "This artifact is being updated. Try again when the reply finishes."
                            : "This artifact is not available in this account.",
                        ),
                };
              });
            },
            (error) => {
              if (live.current === scope && mounted.current === lease)
                setState((current) =>
                  current.scope === scope
                    ? { ...current, error, saving: false }
                    : current,
                );
            },
          );
      },
      urgent ? 0 : 400,
    );
    return () => clearTimeout(timer);
  }, [
    scope,
    value.document,
    value.content,
    value.saving,
    value.error,
    value.conflict,
    urgent,
  ]);
  // A real agent file change is read once it settles. Never replace an
  // unsaved local draft with an arriving conversation snapshot.
  const last = app.snapshot.conversations
    .find((c) => c.id === scope.conversationId)
    ?.turns.at(-1);
  const stamp = last ? `${last.id}:${last.status}:${artifact.updatedAt}` : "";
  const previous = useRef({ scope, stamp });
  useEffect(() => {
    const before = previous.current;
    previous.current = { scope, stamp };
    if (
      before.scope !== scope ||
      before.stamp === stamp ||
      !stamp ||
      last?.status === "inProgress"
    )
      return;
    const current = latest.current;
    if (
      current.document &&
      current.content === current.document.content &&
      !current.saving
    )
      setReload((n) => n + 1);
  }, [scope, stamp]);
  return {
    ...value,
    waiting: waiting && navigation.current?.scope === scope,
    beforeLeave,
    cancelNavigation: () => {
      const intent = navigation.current;
      navigation.current = undefined;
      intent?.cancel?.();
      setWaiting(false);
    },
    loading: !value.document && !value.error,
    dirty: Boolean(value.document && value.content !== value.document.content),
    readOnly:
      !value.document?.writable ||
      last?.status === "inProgress" ||
      [...saveLocks.current].some((lock) => lock.scope === scope),
    change: (content: string) => {
      if ([...saveLocks.current].some((lock) => lock.scope === scope)) return;
      setState((current) =>
        current.scope === scope
          ? { ...current, content, error: undefined }
          : current,
      );
    },
    reload: () => setReload((n) => n + 1),
    retry: () =>
      value.document
        ? setState((current) =>
            current.scope === scope
              ? { ...current, error: undefined }
              : current,
          )
        : setReload((n) => n + 1),
  };
}
