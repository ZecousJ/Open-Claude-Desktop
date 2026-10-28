import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import type { DesktopAPI } from "../../shared/types";
import { dismissToast, showToast } from "../ui/toast-store";

/** A Privacy view belongs to one bridge, account and controller lifetime. */
export function usePrivacyOwner() {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const identity = useMemo(
    () => ({
      bridge,
      accountId: app?.accountId,
      scope: app?.controllerScope,
      ref: app?.currentController,
    }),
    [bridge, app?.accountId, app?.controllerScope, app?.currentController],
  );
  const latest = useRef(identity);
  latest.current = identity;
  const blocked = useRef<typeof identity | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const owner = useMemo(() => {
    const state = { active: true };
    return {
      id: ++sequence.current,
      bridge,
      invalidate() {
        state.active = false;
      },
      current() {
        const actor = identity.ref?.current;
        return (
          state.active &&
          latest.current === identity &&
          blocked.current !== identity &&
          typeof window !== "undefined" &&
          window.desktop === bridge &&
          (!identity.ref ||
            (!!actor &&
              actor.accountId === identity.accountId &&
              actor.controllerScope === identity.scope))
        );
      },
    };
  }, [identity, revision]);
  useEffect(
    () =>
      bridge?.onEvent((event) => {
        if (event.type !== "service-changed" && event.type !== "signed-out")
          return;
        owner.invalidate();
        if (event.type === "signed-out") blocked.current = identity;
        setRevision((value) => value + 1);
      }),
    [owner, bridge, identity],
  );
  return owner;
}
export type PrivacyOwner = ReturnType<typeof usePrivacyOwner>;

/** Latest read wins; stale owners and unmounted views cannot publish data/errors. */
export function usePrivacyRead<T>(
  owner: PrivacyOwner,
  load: (bridge: DesktopAPI) => Promise<T>,
  onError: (error: unknown) => void,
) {
  const live = useRef(true);
  const serial = useRef(0);
  const [state, setState] = useState<{ value?: T; failed: boolean }>({
    failed: false,
  });
  const reload = async () => {
    if (!live.current || !owner.current() || !owner.bridge) return;
    const request = ++serial.current;
    const current = () =>
      live.current && owner.current() && request === serial.current;
    try {
      const value = await load(owner.bridge);
      if (current()) setState({ value, failed: false });
    } catch (error) {
      if (!current()) return;
      setState({ failed: true });
      onError(error);
    }
  };
  useEffect(() => {
    live.current = true;
    void reload();
    return () => {
      live.current = false;
      serial.current++;
    };
  }, [owner]);
  return { ...state, reload };
}

/** Leaving a manager commits its authorized Undo queue; changing owner cancels it. */
export function usePrivacyRemove(owner: PrivacyOwner) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(
    new Map<string, { toast: number; settled: boolean }>(),
  );
  const live = useRef(true);
  const show = (key: string, gone: boolean) => {
    if (!live.current || !owner.current()) return;
    setHidden((before) => {
      const next = new Set(before);
      if (gone) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const item of pending.current.values()) dismissToast(item.toast);
    };
  }, []);
  function remove(
    key: string,
    options: {
      title: string;
      doneTitle: string;
      commit: () => Promise<unknown>;
      onDone?: () => void;
      onFailed: (error: unknown) => void;
    },
  ) {
    if (!owner.current() || pending.current.has(key)) return;
    show(key, true);
    const item = { toast: 0, settled: false };
    pending.current.set(key, item);
    item.toast = showToast(options.title, {
      action: {
        label: "Undo",
        onSelect: () => {
          item.settled = true;
          pending.current.delete(key);
          show(key, false);
        },
      },
      onDismiss: () => {
        if (item.settled) return;
        item.settled = true;
        if (!owner.current()) {
          pending.current.delete(key);
          return;
        }
        void options
          .commit()
          .then(() => {
            if (!owner.current()) return;
            showToast(options.doneTitle);
            options.onDone?.();
          })
          .catch((error: unknown) => {
            if (!owner.current()) return;
            show(key, false);
            options.onFailed(error);
          })
          .finally(() => pending.current.delete(key));
      },
    });
  }
  return { hidden, remove };
}
