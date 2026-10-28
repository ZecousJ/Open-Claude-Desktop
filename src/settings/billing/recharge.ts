/**
 * The recharge entry: the account menu's "Add funds" (where the original
 * has "View all plans") and the low-balance notice's button open Settings →
 * Billing and its Add funds checkout. The request is held here until the
 * Billing page has read what the service sells, so it works whether the
 * page is opening now or already open.
 */
let pending = false;
const listeners = new Set<() => void>();

/** Asks Billing to open Add funds; `openBilling` shows the page. */
export function openRecharge(openBilling: () => void) {
  pending = true;
  openBilling();
  listeners.forEach((listener) => listener());
}

/** True once per request: the page that takes it opens the checkout. */
export function takeRechargeRequest() {
  const asked = pending;
  pending = false;
  return asked;
}

/** Billing, while open, hears requests made after it loaded. */
export function onRechargeRequest(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
