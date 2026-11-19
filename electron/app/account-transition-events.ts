/** Desktop host observations only. They never decide account business results. */
export type AccountTransitionEvent =
  | { type: "begin" | "settled"; token: object; store: unknown; generation: unknown }
  | { type: "deactivated" | "forced-signed-out"; store: unknown; generation: unknown };
const names = new Set(["logoutAccount", "revokeAllSessions", "deleteAccount", "switchAccount", "addAccount", "cancelAddAccount"]);
export const isAccountTransitionMethod = (name: string) => names.has(name);
const pending = new Map<object, string>();
const listeners = new Set<(event: AccountTransitionEvent) => void>();
function notify(event: AccountTransitionEvent) {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { console.error("Account interface transition notification failed."); }
  }
}
export function onAccountTransition(listener: (event: AccountTransitionEvent) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function pendingAccountTransitions() { return pending.size; }
export function signingOut() {
  return [...pending.values()].some((method) => method === "logoutAccount" || method === "revokeAllSessions");
}
export function observeAccountTransition<T>(name: string, identity: { store: unknown; generation: unknown }, operation: () => T): T | Promise<T> {
  if (!names.has(name)) return operation();
  const token = Object.freeze({}); pending.set(token, name);
  notify({ type: "begin", token, ...identity });
  return (async () => {
    try { return await operation(); }
    finally { pending.delete(token); notify({ type: "settled", token, ...identity }); }
  })();
}
export function accountDeactivated(store: unknown, generation: unknown) {
  notify({ type: "deactivated", store, generation });
}

export function accountForcedSignedOut(store: unknown, generation: unknown) {
  notify({ type: "forced-signed-out", store, generation });
}
