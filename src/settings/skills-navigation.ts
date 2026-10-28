import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export type SettingsSkillsView = "yours" | "discover";
type Target = { id: number; view: SettingsSkillsView };
let serial = 0;
function createScope() {
  let target: Target | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    key: ++serial,
    snapshot: () => target,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request(view: SettingsSkillsView) {
      target = { id: ++serial, view };
      notify();
    },
    clear(id?: number) {
      if (!target || (id !== undefined && target.id !== id)) return;
      target = undefined;
      notify();
    },
  };
}
type Scope = ReturnType<typeof createScope>;
const scopes = new WeakMap<Window["desktop"], Map<string, Scope>>();
const owners = new WeakMap<
  Window["desktop"],
  { accountId: string; token: symbol }
>();
const serverScope = createScope();
function scopeFor(account: string, bridge: Window["desktop"] | undefined) {
  if (!bridge) return serverScope;
  let accounts = scopes.get(bridge);
  if (!accounts) scopes.set(bridge, (accounts = new Map()));
  let scope = accounts.get(account);
  if (!scope) accounts.set(account, (scope = createScope()));
  return scope;
}

/** Call immediately before openSettingsTab("skills"). The existing Settings
 * route owns the dialog; this request chooses only its Skills subview. */
export function requestSettingsSkillsView(
  accountId: string,
  view: SettingsSkillsView,
  bridge = window.desktop,
) {
  if (typeof window === "undefined" || window.desktop !== bridge) return;
  const owner = owners.get(bridge);
  if (owner && owner.accountId !== accountId) return;
  scopeFor(accountId, bridge).request(view);
}

/** Lives in the eager Settings host, including while its dialog chunk loads.
 * A committed host owns the consumed target for this open dialog only. */
export function useSettingsSkillsNavigation(accountId: string, open: boolean) {
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = scopeFor(accountId, bridge);
  const pending = useSyncExternalStore(
    scope.subscribe,
    scope.snapshot,
    () => undefined,
  );
  const [selected, setSelected] = useState<{
    scope: Scope;
    target?: Target;
    view: SettingsSkillsView;
  }>();
  const latest = useRef({ scope, open });
  latest.current = { scope, open };
  const wasOpen = useRef(false);
  const live = useRef(false);
  const ownerToken = useRef(Symbol("settings-skills-owner"));
  const visible =
    open && pending
      ? { target: pending, view: pending.view }
      : selected?.scope === scope
        ? selected
        : undefined;
  useLayoutEffect(() => {
    if (open && pending) {
      setSelected({ scope, target: pending, view: pending.view });
      scope.clear(pending.id);
    } else if (!open && wasOpen.current) {
      setSelected(undefined);
      scope.clear();
    }
    wasOpen.current = open;
  }, [scope, pending, open]);
  useLayoutEffect(() => {
    live.current = true;
    if (bridge) owners.set(bridge, { accountId, token: ownerToken.current });
    return () => {
      live.current = false;
      scope.clear();
      if (bridge && owners.get(bridge)?.token === ownerToken.current)
        owners.delete(bridge);
    };
  }, [scope]);
  return {
    view: visible?.view ?? ("yours" as SettingsSkillsView),
    requestId: open ? visible?.target?.id : undefined,
    pageKey: `${scope.key}:${visible?.target?.id ?? "default"}`,
    onViewChange(view: SettingsSkillsView) {
      if (
        !live.current ||
        latest.current.scope !== scope ||
        !latest.current.open ||
        (typeof window !== "undefined" && window.desktop !== bridge)
      )
        return;
      setSelected((current) => ({
        scope,
        target: current?.scope === scope ? current.target : undefined,
        view,
      }));
    },
  };
}
