import { useEffect, useSyncExternalStore } from "react";
import { lowBalanceUsd } from "../../shared/billing-api";

/**
 * The account's balance for the low-balance notice, from the same Billing read
 * Settings uses. One reader serves every mounted composer: it reads on first
 * use, after each turn (the main process's "weekly-usage" event, at most every
 * `turnGapMs`, the last one always read), when the account changed and when a
 * payment completed. Whether the service sells balance (Add funds) is read with
 * it.
 */
export interface BalanceSnapshot {
  /** US dollars; null until read, or for an account without billing. */
  balance: number | null;
  /** The service takes payments for the balance in the app. */
  canAddFunds: boolean;
}

const turnGapMs = 20_000;
let snapshot: BalanceSnapshot = { balance: null, canAddFunds: false };
const listeners = new Set<() => void>();
let lastRead = 0;
let reading = false;
let again = false;
let trailing: ReturnType<typeof setTimeout> | undefined;
let checkoutRead = false;
let stopEvents: (() => void) | undefined;

function publish(next: BalanceSnapshot) {
  if (
    next.balance === snapshot.balance &&
    next.canAddFunds === snapshot.canAddFunds
  )
    return;
  snapshot = next;
  // Back at or over the threshold: a later drop warns again.
  if (next.balance !== null && next.balance >= lowBalanceUsd)
    writeDismissed("");
  listeners.forEach((listener) => listener());
}

async function read() {
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  lastRead = Date.now();
  try {
    const info = await window.desktop.billingInfo?.();
    let canAddFunds = snapshot.canAddFunds;
    if (info && !checkoutRead) {
      const checkout = await window.desktop
        .billingCheckout?.()
        .catch(() => null);
      checkoutRead = true;
      canAddFunds = !!checkout?.balance;
    }
    publish({
      balance: info && Number.isFinite(info.balance) ? info.balance : null,
      canAddFunds: info ? canAddFunds : false,
    });
  } catch {
    // An unreadable balance keeps what was shown.
  } finally {
    reading = false;
    if (again) {
      again = false;
      void read();
    }
  }
}

/** After a turn: read now, or once the gap since the last read is over. */
function readAfterTurn() {
  const wait = lastRead + turnGapMs - Date.now();
  if (wait <= 0) return void read();
  if (trailing) return;
  trailing = setTimeout(() => {
    trailing = undefined;
    void read();
  }, wait);
}

function start() {
  void read();
  stopEvents = window.desktop.onEvent((event) => {
    if (event.type === "weekly-usage") readAfterTurn();
    else if (event.type === "service-changed") {
      checkoutRead = false;
      void read();
    } else if (event.type === "billing-order" && event.status === "COMPLETED")
      void read();
  });
}

function stop() {
  stopEvents?.();
  stopEvents = undefined;
  if (trailing) clearTimeout(trailing);
  trailing = undefined;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Closed until the balance is back at $10 or more, per account.
const dismissedKey = "claudex.lowBalanceDismissed";
const dismissal = {
  value: (() => {
    try {
      return localStorage.getItem(dismissedKey) ?? "";
    } catch {
      return "";
    }
  })(),
  listeners: new Set<() => void>(),
};
function writeDismissed(account: string) {
  if (dismissal.value === account) return;
  dismissal.value = account;
  try {
    if (account) localStorage.setItem(dismissedKey, account);
    else localStorage.removeItem(dismissedKey);
  } catch {
    // Storage off: closed for this window only.
  }
  dismissal.listeners.forEach((listener) => listener());
}
function subscribeDismissal(listener: () => void) {
  dismissal.listeners.add(listener);
  return () => void dismissal.listeners.delete(listener);
}

let users = 0;

/**
 * The balance while `enabled` (a service account), and whether this
 * account closed the warning. `account` tells accounts apart (the email).
 */
export function useLowBalance(enabled: boolean, account = "account") {
  useEffect(() => {
    if (!enabled) return;
    if (users++ === 0) start();
    return () => {
      if (--users === 0) stop();
    };
  }, [enabled]);
  const current = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  const closedFor = useSyncExternalStore(
    subscribeDismissal,
    () => dismissal.value,
    () => dismissal.value,
  );
  return {
    balance: enabled ? current.balance : null,
    canAddFunds: enabled && current.canAddFunds,
    dismissed: closedFor === account,
    dismiss: () => writeDismissed(account),
  };
}

/** For tests: forget what was read. */
export function resetLowBalanceForTests() {
  stop();
  users = 0;
  snapshot = { balance: null, canAddFunds: false };
  lastRead = 0;
  reading = false;
  again = false;
  checkoutRead = false;
}

/** Reads the balance now (tests; the hook reads by itself). */
export const refreshBalance = read;
/** What was last read (tests). */
export const balanceSnapshot = () => snapshot;
/** Whether the warning was closed for `account` (tests). */
export const lowBalanceClosedFor = (account: string) =>
  dismissal.value === account;
export const closeLowBalance = writeDismissed;
