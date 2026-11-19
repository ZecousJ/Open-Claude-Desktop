import type { AdapterContext } from "./context";
import { bindAdapterScope, currentAdapterScope } from "./scope";

export const anonymousOwner = "\u0000signed-out";
export const accountOwner = (ctx: AdapterContext) =>
  ctx.account()?.id ?? anonymousOwner;

/** Bind every read and event to the account that initiated this request. */
export function guardAdapterContext(ctx: AdapterContext): AdapterContext {
  const isCurrent = () => {
    try {
      // A host may enter retirement before its account/store pointers are cleared.
      // The scoped wrapper must preserve that authoritative lifecycle veto.
      if (ctx.isCurrent && ctx.isCurrent() !== true) return false;
      const scope = currentAdapterScope();
      return (
        scope.owner === accountOwner(ctx) &&
        (!ctx.sessionIdentity ||
          scope.sessionIdentity === ctx.sessionIdentity())
      );
    } catch {
      return false;
    }
  };
  const assertCurrent = () => {
    if (!isCurrent())
      throw new Error("The account changed during this request.");
  };
  return new Proxy(ctx, {
    get(target, key, receiver) {
      if (key === "isCurrent") return isCurrent;
      const value = Reflect.get(target, key, receiver);
      if (key === "log" || typeof value !== "function") return value;
      if (key === "onEvent")
        return (listener: Parameters<AdapterContext["onEvent"]>[0]) => {
          assertCurrent();
          let closed = false,
            installing = true,
            terminalPending = false;
          let off: (() => void) | undefined;
          let listenerFailed = false,
            listenerError: unknown;
          const detach = () => {
            const stop = off;
            off = undefined; // Reentrant host events/disposal must never call it twice.
            try {
              stop?.();
            } catch {
              /* Still close locally and notify stream cleanup. */
            }
          };
          const dispose = () => {
            closed = true;
            terminalPending = false;
            detach();
          };
          const notifyRetirement = () => {
            terminalPending = false;
            listener({
              type: "signed-out",
              reason: "session-expired",
              message: "The account session changed. Reopen the conversation.",
            });
          };
          const retire = () => {
            closed = true;
            terminalPending = true;
            if (!installing) {
              detach();
              notifyRetirement();
            }
          };
          const bound = bindAdapterScope(
            (event: Parameters<typeof listener>[0]) => {
              if (closed) return;
              if (!isCurrent()) {
                retire();
                return;
              }
              try {
                listener(event);
              } catch (error) {
                dispose();
                if (!installing) throw error;
                // A synchronous callback must not make subscribe lose its disposer.
                listenerFailed = true;
                listenerError = error;
              }
            },
          );
          // Hosts must either return a disposer or leave no registration on throw.
          // A host that registers and then throws without returning it cannot be
          // physically unsubscribed by this interface; closed still drops events.
          try {
            off = target.onEvent(bound);
          } catch (error) {
            closed = true;
            installing = false;
            throw error;
          }
          installing = false;
          if (closed) detach();
          if (listenerFailed) throw listenerError;
          if (terminalPending) notifyRetirement();
          else if (!closed && !isCurrent()) retire();
          return dispose;
        };
      return (...args: unknown[]) => {
        assertCurrent();
        const result = value.apply(target, args);
        const intentionalSignout =
          key === "call" &&
          ["logoutAccount", "revokeAllSessions", "deleteAccount", "addAccount", "switchAccount"].includes(
            String(args[0]),
          );
        if (result && typeof result.then === "function")
          return result.then(
            (answer: unknown) => {
              if (!intentionalSignout) assertCurrent();
              return answer;
            },
            (error: unknown) => {
              if (!intentionalSignout) assertCurrent();
              throw error;
            },
          );
        if (!intentionalSignout) assertCurrent();
        return result;
      };
    },
  });
}
