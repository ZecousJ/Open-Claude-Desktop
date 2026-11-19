import type { AppContext } from "../app/app-context";

/** Registered once per handler domain. Host retirement is authoritative even
 * when registration occurs after the deactivation notification. */
export function profileReadLease(ctx: AppContext) {
  let epoch = 0;
  let retiring = ctx.accountRetiring !== false;
  let observedIdentity = ctx.accountActivationIdentity;
  let observedStore = ctx.store,
    observedHost = ctx.remote,
    observedAccount = ctx.activeAccount?.id;
  ctx.onAccountDeactivating(() => {
    retiring = true;
    epoch++;
  });
  ctx.onAccountActivated((account) => {
    if (ctx.accountRetiring !== false || ctx.activeAccount?.id !== account.id)
      return;
    // The queued registration callback is not a new activation.
    if (
      !retiring &&
      ctx.store === observedStore &&
      ctx.remote === observedHost &&
      account.id === observedAccount
    )
      return;
    observedIdentity = ctx.accountActivationIdentity;
    observedStore = ctx.store;
    observedHost = ctx.remote;
    observedAccount = account.id;
    retiring = false;
    epoch++;
  });
  return () => {
    // Runner reactivation changes its real identity without an activated event.
    // This can open only a NEW capture, never a previously captured operation.
    const identity = ctx.accountActivationIdentity;
    if (
      identity !== undefined &&
      identity !== observedIdentity &&
      ctx.accountRetiring === false
    ) {
      observedIdentity = identity;
      observedStore = ctx.store;
      observedHost = ctx.remote;
      observedAccount = ctx.activeAccount?.id;
      retiring = false;
      epoch++;
    }
    const accountId = ctx.activeAccount?.id,
      store = ctx.store,
      host = ctx.remote,
      capturedEpoch = epoch;
    return {
      accountId,
      store,
      host,
      current: () =>
        identity !== undefined &&
        identity === ctx.accountActivationIdentity &&
        !!accountId &&
        !!store &&
        ctx.accountRetiring === false &&
        !retiring &&
        epoch === capturedEpoch &&
        ctx.activeAccount?.id === accountId &&
        ctx.store === store &&
        ctx.remote === host,
    };
  };
}
