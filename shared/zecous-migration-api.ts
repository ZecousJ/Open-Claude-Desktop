/**
 * The move from ZecousAI (owner, 2026-10-03): a Claudex account whose e-mail
 * also has a ZecousAI account sees a one-time dialog until the person
 * confirms the move. Confirming clears the ZecousAI balance and
 * subscriptions and adds what they were worth to the Claudex balance
 * (backend/backend/internal/claudex/zmigrate). Closing the dialog changes
 * nothing; it shows again next time.
 */
import { z } from "zod";
import { bridgeMethods } from "./bridge-methods";

export interface ZecousMigration {
  /** "pending": the dialog shows; "none" and "done": it doesn't. */
  state: "none" | "pending" | "done";
  /** What is (or was) added to the Claudex balance, USD. */
  amountUsd: number;
  /** The balance's share. */
  balanceUsd: number;
  /** The subscriptions' share. */
  subscriptionUsd: number;
}

export interface ZecousMigrationAPI {
  /** Whether the dialog shows, and the amount; "none" when it can't tell. */
  zecousMigration(): Promise<ZecousMigration>;
  /** Moves the account; answers "done" with the amount added. */
  confirmZecousMigration(): Promise<ZecousMigration>;
}

export interface OfficialZecousMigration {
  status(options?: { refreshOnDone?: boolean }): Promise<ZecousMigration>;
  confirm(): Promise<ZecousMigration & { state: "done" }>;
}

export const zecousMigrationMethods = bridgeMethods<ZecousMigrationAPI>({
  zecousMigration: true,
  confirmZecousMigration: true,
});

export const noZecousMigration: ZecousMigration = {
  state: "none",
  amountUsd: 0,
  balanceUsd: 0,
  subscriptionUsd: 0,
};

const money = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : 0;

/** The service's answer (`{state, amount_usd, …}`), checked. */
export function zecousMigrationFrom(value: unknown): ZecousMigration {
  const v = (value ?? {}) as Record<string, unknown>;
  const state = v.state === "pending" || v.state === "done" ? v.state : "none";
  return {
    state,
    amountUsd: money(v.amount_usd),
    balanceUsd: money(v.balance_usd),
    subscriptionUsd: money(v.subscription_usd),
  };
}

const usd = z.number().nonnegative();
const migrationStatus = z.object({
  state: z.enum(["none", "pending", "done"]),
  amount_usd: usd,
  balance_usd: usd,
  subscription_usd: usd,
  migration_protocol: z.unknown().optional(),
});
const migrationConfirmation = migrationStatus.extend({
  state: z.literal("done"),
  balance_usd: usd.default(0),
  subscription_usd: usd.default(0),
  migration_protocol: z.literal(1),
});

function migrationAmounts(value: z.infer<typeof migrationStatus>) {
  return {
    amountUsd: value.amount_usd,
    balanceUsd: value.balance_usd,
    subscriptionUsd: value.subscription_usd,
  };
}

export function officialZecousMigrationFrom(value: unknown): ZecousMigration {
  const status = migrationStatus.safeParse(value);
  if (!status.success)
    throw Error(
      "The Claudex service returned an invalid ZecousAI transfer status.",
    );
  if (status.data.state === "pending" && status.data.migration_protocol !== 1)
    throw Error("The Claudex service does not support ZecousAI transfers yet.");
  return { state: status.data.state, ...migrationAmounts(status.data) };
}

export async function confirmOfficialZecousMigration(
  request: (route: ZecousMigrationRoute) => Promise<unknown>,
): ReturnType<OfficialZecousMigration["confirm"]> {
  const status = officialZecousMigrationFrom(
    await request(zecousMigrationRoute),
  );
  if (status.state === "done") return { ...status, state: "done" };
  if (status.state === "none")
    throw Error("There is no ZecousAI balance to transfer.");
  const result = migrationConfirmation.safeParse(
    await request(zecousMigrationConfirmationRoute),
  );
  if (!result.success)
    throw Error("The Claudex service did not confirm the ZecousAI transfer.");
  return { state: result.data.state, ...migrationAmounts(result.data) };
}

export const zecousMigrationRoute = "/claudex/zecous-migration";
export const zecousMigrationConfirmationRoute = `${zecousMigrationRoute}/confirm-v1`;
export const zecousMigrationPath = `/api/v1${zecousMigrationRoute}`;

export type ZecousMigrationRoute =
  | typeof zecousMigrationRoute
  | typeof zecousMigrationConfirmationRoute
  | `${typeof zecousMigrationRoute}/confirm`;

export async function refreshZecousMigrationReadiness(
  refresh: (signal: AbortSignal) => Promise<unknown>,
) {
  const signal = AbortSignal.timeout(5_000);
  const deadline = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([refresh(signal), deadline]).catch(() => {});
}
