import type { AdapterContext } from "../api/context";
import { AsyncLocalStorage } from "node:async_hooks";

/** Retire cached native-session state and in-flight reads on account changes. */
export function sessionAccountScope(ctx: AdapterContext, clear: () => void) {
  const current = () => ({ owner: ctx.account?.()?.id, identity: ctx.sessionIdentity?.() });
  let active = current();
  const request = new AsyncLocalStorage<ReturnType<typeof current>>();
  const same = (a: ReturnType<typeof current>, b: ReturnType<typeof current>) => a.owner === b.owner && a.identity === b.identity;
  const sync = () => {
    const next = current();
    if (!same(active, next)) { active = next; clear(); }
    const started = request.getStore();
    if (started && !same(started, next)) throw Error("The account changed during this request.");
    return next;
  };
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    const started = sync();
    const result = await operation();
    if (!same(started, sync())) throw Error("The account changed during this request.");
    return result;
  };
  const run = <T>(operation: () => T): T => request.run(sync(), operation);
  return { sync, guard, run };
}
