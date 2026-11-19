import type { RetirableResponse } from "./response-lease";
export interface OfficialActivationIdentity {
  readonly owner: string;
  readonly store: object;
  readonly generation: unknown;
  readonly active: boolean;
}
/** Host-only immutable authority; a retired lease can never become current again. */
export function createOfficialActivationLease(
  identity: OfficialActivationIdentity,
  currentIdentity: () => OfficialActivationIdentity | undefined,
) {
  if (!identity.owner || !identity.store || identity.generation == null || !identity.active)
    throw new Error("An active account is required to open the interface.");
  let retired = false;
  const captured = Object.freeze({ ...identity });
  const responses = new Set<RetirableResponse>();
  const retirementListeners = new Set<() => void>();
  const retire = () => {
    if (retired) return;
    // Authority is revoked before any possibly reentrant consumer runs.
    retired = true;
    for (const listener of [...retirementListeners]) {
      if (!retirementListeners.delete(listener)) continue;
      try { listener(); } catch { /* A consumer cannot prevent retirement. */ }
    }
  };
  return {
    identity: captured,
    retire,
    onRetire(listener: () => void) {
      if (retired) {
        try { listener(); } catch { /* Retirement remains irrevocable. */ }
        return () => {};
      }
      retirementListeners.add(listener);
      return () => { retirementListeners.delete(listener); };
    },
    trackResponse(response: RetirableResponse) {
      responses.add(response);
      void response.finished.then(() => { responses.delete(response); });
    },
    async settleResponses(timeoutMs = 5000) {
      if (!retired) throw new Error("Cannot retire responses of an active account.");
      const capturedResponses = [...responses];
      if (!capturedResponses.length) return { timedOut: false, unconfirmed: 0 };
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.all(capturedResponses.map(r => r.finished)).then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      let unconfirmed = 0;
      if (timedOut) for (const response of capturedResponses) {
        if (!responses.has(response)) continue;
        try { response.abort(); } catch { unconfirmed++; }
      }
      return { timedOut, unconfirmed };
    },
    current() {
      if (retired) return false;
      let next: OfficialActivationIdentity | undefined;
      try { next = currentIdentity(); } catch { retire(); return false; }
      if (!next || !next.active || next.owner !== captured.owner ||
          next.store !== captured.store || next.generation !== captured.generation)
        retire();
      return !retired;
    },
  };
}
export type OfficialActivationLease = ReturnType<typeof createOfficialActivationLease>;
