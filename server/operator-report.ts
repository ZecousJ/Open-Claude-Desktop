import path from "node:path";
import { operatorUsageReport } from "./operator-usage";
import type { UsageRange } from "../shared/types";

const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const root = option("--data-dir"),
  range = option("--range") ?? "all";
if (!root || !["all", "30d", "7d"].includes(range))
  throw Error(
    "Usage: operator-report --data-dir DIR [--range all|30d|7d] [--include-emails]",
  );
const report = operatorUsageReport(path.resolve(root), range as UsageRange);
if (!process.argv.includes("--include-emails"))
  for (const account of report.accounts) {
    account.email = "";
    account.name = "";
  }
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
