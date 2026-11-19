import { activationLocalError } from "./activation-failure";
/** Optional only for legacy direct callers; host mutation paths supply a real lease. */
export type AccountOperationCurrent = () => boolean;
export function assertAccountOperationCurrent(current?: AccountOperationCurrent): void {
  if (!current) return;
  let valid = false;
  try { valid = current() === true; } catch { /* Unknown identity is not authority. */ }
  if (!valid)
    throw activationLocalError("account_operation_stale", "The account changed during this operation. Its prior outcome may be unknown; do not retry automatically.");
}
