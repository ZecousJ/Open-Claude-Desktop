import { AsyncLocalStorage } from "node:async_hooks";
import type { AdapterContext } from "../api/context";
interface InvocationLease { current(): boolean }
/** Separate from API/prefs AdapterScope: native handlers may enter their own
 * persistence scopes, but cannot replace the verified window's authority. */
export function createNativeInvocationScope(original: AdapterContext) {
  const storage = new AsyncLocalStorage<InvocationLease>();
  const check = (lease: InvocationLease | undefined) => {
    if (!lease) return;
    let current = false;
    try { current = lease.current() === true; } catch {}
    if (!current) throw new Error("This account window has retired.");
  };
  const context = new Proxy(original, {
    get(target, key, receiver) {
      const acquiredLease = storage.getStore();
      if (key === "isCurrent") {
        try { check(acquiredLease); } catch { return () => false; }
      } else if (key !== "log") check(acquiredLease);
      const value = Reflect.get(target, key, receiver);
      if (key === "log" || typeof value !== "function") return value;
      if (key === "onEvent") return (listener: Parameters<AdapterContext["onEvent"]>[0]) => {
        const lease = acquiredLease ?? storage.getStore(); check(lease);
        if (!lease) return target.onEvent(listener);
        let off: (() => void) | undefined, closed = false, installing = true;
        let failed = false, listenerError: unknown;
        const dispose = () => { closed = true; const stop = off; off = undefined; stop?.(); };
        off = target.onEvent((event) => {
          if (closed) return;
          try { check(lease); } catch { dispose(); return; }
          try { storage.run(lease, () => listener(event)); }
          catch (error) {
            if (installing) { failed = true; listenerError = error; closed = true; }
            else { dispose(); throw error; }
          }
        });
        installing = false;
        if (closed) dispose();
        if (failed) throw listenerError;
        return dispose;
      };
      if (key === "isCurrent") return () => {
        try { const lease = acquiredLease ?? storage.getStore(); check(lease); return lease ? storage.run(lease, () => value.call(target)) : value.call(target); } catch { return false; }
      };
      return (...args: unknown[]) => {
        const lease = acquiredLease ?? storage.getStore(); check(lease);
        const result = lease ? storage.run(lease, () => value.apply(target, args)) : value.apply(target, args);
        if (result && typeof result.then === "function")
          return result.then((answer: unknown) => { check(lease); return answer; },
            (error: unknown) => { check(lease); throw error; });
        check(lease); return result;
      };
    },
  });
  return { context, run<T>(lease: InvocationLease, operation: () => T): T {
    check(lease); const result = storage.run(lease, operation); check(lease); return result;
  } };
}
