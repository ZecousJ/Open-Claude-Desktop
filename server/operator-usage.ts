import path from "node:path";
import { Accounts } from "../electron/account/accounts";
import { UsageLedger } from "../electron/conversations/usage-ledger";
import { readWeeklyUsage } from "../electron/conversations/weekly-usage-status";
import type {
  UsageRange,
  UsageSummary,
  UsageTotals,
  WeeklyUsageStatus,
} from "../shared/types";

export interface AccountUsage {
  accountId: string;
  email: string;
  name: string;
  usage: UsageSummary;
  /** This usage week against the operator's weekly limit; null when none is set. */
  weekly: WeeklyUsageStatus | null;
}
export interface OperatorUsageReport {
  generatedAt: number;
  range: UsageRange;
  total: UsageTotals;
  accounts: AccountUsage[];
}

export function operatorUsageReport(
  root: string,
  range: UsageRange = "all",
  now = Date.now(),
): OperatorUsageReport {
  const accounts = new Accounts(root).listPublicAccounts();
  const total: UsageTotals = {
    requests: 0,
    successful: 0,
    failed: 0,
    unmetered: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
  const rows = accounts.map((account) => {
    const profile = path.join(root, "profiles", account.id);
    const usage = new UsageLedger(profile).summary(range, now);
    for (const key of Object.keys(total) as Array<keyof UsageTotals>)
      total[key] += usage.total[key];
    return {
      accountId: account.id,
      email: account.email,
      name: account.name,
      usage,
      weekly: readWeeklyUsage(root, account.id, profile, now),
    };
  });
  return { generatedAt: now, range, total, accounts: rows };
}
