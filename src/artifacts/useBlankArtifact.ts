import {
  registerBlankArtifactFlush,
  type BlankArtifactBridge,
} from "./blank-artifact-flush";
import {
  fileTransitionEvent,
  type FileTransition,
} from "../files/file-transitions";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlankArtifactDocument } from "../../shared/blank-artifacts";
import type { Turn } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { useApp } from "../app/AppContext";

type ArtifactRead = { base: BlankArtifactDocument | undefined };

function isDirty(value: {
  document?: BlankArtifactDocument;
  content?: string;
}) {
  return Boolean(value.document && value.content !== value.document.content);
}

export function useBlankArtifact(artifact: Artifact) {
  const app = useApp();
  return useBlankArtifactDocument({
    accountId: app.accountId,
    owner: app.controllerScope,
    bridge: window.desktop,
    conversationId: artifact.conversationId!,
    artifactId: artifact.blankArtifact!.id,
    updatedAt: artifact.updatedAt,
    lastTurn: app.snapshot.conversations
      .find((conversation) => conversation.id === artifact.conversationId)
      ?.turns.at(-1),
  });
}
export function useBlankArtifactDocument({
  accountId,
  owner,
  bridge,
  conversationId,
  artifactId,
  updatedAt,
  lastTurn,
  isCurrent,
}: {
  accountId: string;
  owner?: object;
  bridge: BlankArtifactBridge;
  conversationId: string;
  artifactId: string;
  updatedAt?: number;
  lastTurn?: Pick<Turn, "id" | "status">;
  isCurrent?: () => boolean;
}) {
  const scope = useMemo(
    () => ({
      account: accountId,
      owner,
      bridge,
      conversationId,
      artifactId,
      isCurrent,
    }),
    [accountId, owner, bridge, conversationId, artifactId, isCurrent],
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
    completedRead?: ArtifactRead;
  }>({ scope });
  const value = state.scope === scope ? state : { scope };
  const dirty = isDirty(value);
  const agentWriting = lastTurn?.status === "inProgress";
  const latest = useRef(value);
  latest.current = value;
  const navigation = useRef<
    { scope: typeof scope; resume(): void; cancel?: () => void } | undefined
  >(undefined);
  const [waiting, setWaiting] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef<{ stamp?: string; read?: ArtifactRead } | undefined>(
    undefined,
  );
  const reading = (current: typeof value) => {
    const pending = mounted.current?.read;
    return (
      pending &&
      pending !== current.completedRead &&
      pending.base === current.document
    );
  };
  const saveLocks = useRef(new Set<{ scope: typeof scope }>());
  const [, setLockRevision] = useState(0);
  const flushWaiters = useRef(
    new Set<{ scope: typeof scope; resolve(saved: boolean): void }>(),
  );
  useLayoutEffect(() => {
    const off = registerBlankArtifactFlush(scope, {
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
          !isDirty(value) &&
          !value.saving &&
          !reading(value)
        )
          return Promise.resolve(true);
        setUrgent(true);
        return new Promise<boolean>((resolve) =>
          flushWaiters.current.add({ scope, resolve }),
        );
      },
    });
    return () => {
      off();
      for (const waiter of flushWaiters.current)
        if (waiter.scope === scope) {
          flushWaiters.current.delete(waiter);
          waiter.resolve(false);
        }
    };
  }, [scope]);
  const beforeLeave = (resume: () => void) => {
    if (!dirty && !value.saving) return resume();
    navigation.current = { scope, resume };
    setWaiting(true);
  };
  useLayoutEffect(() => {
    const listener = (event: Event) => {
      const current = latest.current;
      if (event.defaultPrevented || !(isDirty(current) || current.saving))
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
      if (isDirty(current) || current.saving) {
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
      (value.document && !dirty && !value.saving && !reading(value)),
    );
    if (!settled) return;
    for (const waiter of flushWaiters.current)
      if (waiter.scope === scope) {
        flushWaiters.current.delete(waiter);
        waiter.resolve(!value.error && !value.conflict);
      }
    if (!flushWaiters.current.size) setUrgent(false);
  }, [
    scope,
    dirty,
    value.document,
    value.saving,
    value.error,
    value.conflict,
    value.completedRead,
  ]);
  useLayoutEffect(() => {
    mounted.current = {};
    return () => {
      mounted.current = undefined;
    };
  }, [scope, reload]);
  const stamp = agentWriting
    ? ""
    : `${lastTurn?.id ?? ""}:${lastTurn?.status ?? ""}:${updatedAt ?? ""}`;
  useLayoutEffect(() => {
    const lease = mounted.current;
    if (!lease || scope.isCurrent?.() === false) return;
    const reset = lease.stamp === undefined;
    if (!reset) {
      if (!stamp) {
        lease.stamp = stamp;
        return;
      }
      if (lease.stamp === stamp || dirty || value.saving) return;
    }
    lease.stamp = stamp;
    if (reset) setState({ scope });
    const base = latest.current.document;
    const read = { base };
    lease.read = read;
    const accept = (
      result: Pick<typeof state, "document" | "content" | "error">,
    ) => {
      if (
        live.current !== scope ||
        mounted.current !== lease ||
        lease.read !== read ||
        scope.isCurrent?.() === false
      )
        return;
      setState((current) => {
        if (current.scope !== scope) return current;
        if (
          !reset &&
          (current.document !== base || isDirty(current) || current.saving)
        )
          return { ...current, completedRead: read };
        return { scope, ...result, completedRead: read };
      });
    };
    void bridge
      .readBlankArtifact({
        conversationId: scope.conversationId,
        artifactId: scope.artifactId,
      })
      .then(
        (document) => accept({ document, content: document.content }),
        (error) => accept({ error }),
      );
  }, [scope, reload, stamp, dirty, value.saving]);
  useLayoutEffect(() => {
    const base = value.document,
      content = value.content;
    if (
      agentWriting ||
      !base ||
      content === undefined ||
      content === base.content ||
      value.saving ||
      value.error ||
      value.conflict
    )
      return;
    const timer = setTimeout(
      () => {
        const lease = mounted.current;
        if (live.current !== scope || !lease || scope.isCurrent?.() === false)
          return;
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
              if (
                live.current !== scope ||
                mounted.current !== lease ||
                scope.isCurrent?.() === false
              )
                return;
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
              if (
                live.current === scope &&
                mounted.current === lease &&
                scope.isCurrent?.() !== false
              )
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
    agentWriting,
  ]);
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
    dirty,
    readOnly:
      !value.document?.writable ||
      agentWriting ||
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
