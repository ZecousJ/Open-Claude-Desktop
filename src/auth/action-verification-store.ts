import type { DesktopAPI } from "../../shared/types";
import { actionVerificationError } from "../../shared/action-verification";

let active: { actionLabel: string; key: number } | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
export const actionVerificationStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => active,
  close() {
    active = null;
    for (const listener of listeners) listener();
  },
};
export class ActionVerificationHandled extends Error {}
export function actionVerificationHandled(error: unknown): boolean {
  return error instanceof ActionVerificationHandled;
}

// No automatic replay: confirmed users press their original button again.
export function withActionVerification(api: DesktopAPI): DesktopAPI {
  return new Proxy(api, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== "function" || property === "onEvent") return method;
      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        if (!result || typeof result.catch !== "function") return result;
        return result.catch((error: unknown) => {
          const detail = actionVerificationError(error);
          if (detail?.code !== "action_verification_required") throw error;
          if (!active) {
            active = { actionLabel: detail.actionLabel, key: ++sequence };
            for (const listener of listeners) listener();
          }
          throw new ActionVerificationHandled();
        });
      };
    },
  });
}
