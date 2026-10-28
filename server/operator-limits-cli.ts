import path from "node:path";
import {
  isMoreUsageUrl,
  loadOperatorLimits,
  resolveRequestLimits,
  saveOperatorLimits,
  type RequestLimits,
} from "./operator-limits";

const usage = [
  "Usage: operator-limits --data-dir DIR [--account UUID | --defaults] [options]",
  "  --concurrent N|unlimited      simultaneous requests",
  "  --per-minute N|unlimited      requests per minute",
  "  --daily-tokens N|unlimited    reported tokens per local day",
  "  --weekly-tokens N|unlimited   reported tokens per usage week",
  "  --warn-percent 1-100          show the weekly usage banner from this percent (default 80)",
  "  --reset-day sun..sat|0-6      weekday the usage week resets (default mon)",
  "  --reset-hour 0-23             local hour it resets (default 17)",
  "  --more-usage-url URL|none     https page behind the banner's Get more usage button",
  "  --show                        print the policy, or with --account the resolved limits",
].join("\n");
const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayNames = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function whole(flag: string, raw: string, min: number, max: number) {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
    throw Error(`Invalid ${flag} value.`);
  if (value < min || value > max) throw Error(`Invalid ${flag} value.`);
  return value;
}
const limit = (flag: string, raw: string) =>
  raw === "unlimited" ? null : whole(flag, raw, 1, Number.MAX_SAFE_INTEGER);
const parsers: Array<
  [string, keyof RequestLimits, (flag: string, raw: string) => unknown]
> = [
  ["--concurrent", "maxConcurrent", limit],
  ["--per-minute", "requestsPerMinute", limit],
  ["--daily-tokens", "dailyTokenLimit", limit],
  ["--weekly-tokens", "weeklyTokenLimit", limit],
  ["--warn-percent", "weeklyWarnPercent", (f, raw) => whole(f, raw, 1, 100)],
  [
    "--reset-day",
    "weeklyResetDay",
    (f, raw) => {
      const name = raw.toLowerCase();
      const index = days.findIndex(
        (day, i) => name === day || name === dayNames[i],
      );
      return index >= 0 ? index : whole(f, raw, 0, 6);
    },
  ],
  ["--reset-hour", "weeklyResetHour", (f, raw) => whole(f, raw, 0, 23)],
  [
    "--more-usage-url",
    "moreUsageUrl",
    (f, raw) => {
      if (raw === "none") return null;
      if (!isMoreUsageUrl(raw))
        throw Error(`Invalid ${f} value; use an https URL or none.`);
      return raw;
    },
  ],
];

const root = option("--data-dir");
if (!root) throw Error(usage);
const config = loadOperatorLimits(path.resolve(root));
const account = option("--account");
if (account && !/^[0-9a-f-]{36}$/.test(account))
  throw Error("Invalid account UUID.");
if (process.argv.includes("--show")) {
  if (process.argv.some((arg) => parsers.some(([flag]) => flag === arg)))
    throw Error("--show cannot change limits.");
  console.log(
    JSON.stringify(
      account ? resolveRequestLimits(path.resolve(root), account) : config,
      null,
      2,
    ),
  );
} else {
  if (
    (!account && !process.argv.includes("--defaults")) ||
    (account && process.argv.includes("--defaults"))
  )
    throw Error("Select --account UUID or --defaults.");
  const patch: Record<string, unknown> = {};
  for (const [flag, key, parse] of parsers) {
    const raw = option(flag);
    if (raw === undefined) continue;
    patch[key] = parse(flag, raw);
  }
  if (!Object.keys(patch).length)
    throw Error("Specify at least one limit to change.\n" + usage);
  if (account)
    config.accounts[account] = { ...config.accounts[account], ...patch };
  else config.defaults = { ...config.defaults, ...patch };
  saveOperatorLimits(path.resolve(root), config);
  console.log(
    "Backend request limits saved. The weekly banner updates after the next reply; enforcement takes effect when the account next signs in.",
  );
}
